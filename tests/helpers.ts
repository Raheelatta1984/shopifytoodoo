import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGliteDb } from '../src/db/pglite.js';
import { createContainer, type Container } from '../src/container.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { ShopifyClient } from '../src/integrations/shopify/client.js';
import type { FetchLike } from '../src/integrations/odoo/client.js';
import { buildMethodResponse, parseMethodCall } from '../src/integrations/odoo/xmlrpc.js';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..');
export const fixturePath = resolve(here, 'fixtures/shopify/orders.json');

export interface ShopifyFixture {
  data: {
    orders: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Record<string, unknown>[];
    };
  };
}

export function loadFixture(): ShopifyFixture {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as ShopifyFixture;
}

export function fixtureOrders(): Record<string, unknown>[] {
  return loadFixture().data.orders.nodes;
}

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    PGLITE_PATH: 'memory://',
    SHOPIFY_SHOP_DOMAIN: 'demo.myshopify.com',
    SHOPIFY_ACCESS_TOKEN: 'test-token',
    SHOPIFY_FIXTURE: fixturePath,
    ADMIN_API_KEY: 'test-admin-key-0001',
    OPERATOR_API_KEY: 'test-operator-key-01',
    APPROVER_API_KEY: 'test-approver-key-01',
    AUDITOR_API_KEY: 'test-auditor-key-001',
    APPROVAL_THRESHOLD_AMOUNT: '1000',
    SUPPORTED_CURRENCIES: 'AUD,USD,EUR',
    CONFIRM_SALE_ORDER: 'true',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

/** A container backed by an in-memory Postgres (PGlite). */
export async function createTestContainer(
  overrides: Record<string, string> = {},
): Promise<Container> {
  const db = new PGliteDb('memory://');
  await db.ready();
  const container = await createContainer(testConfig(overrides), { db });
  await container.seed();
  return container;
}

/** A Shopify client that serves the fixture instead of calling the API. */
export function fixtureClient(): ShopifyClient {
  return new ShopifyClient({
    shopDomain: 'demo.myshopify.com',
    accessToken: 'test-token',
    apiVersion: '2026-07',
    timeoutMs: 5000,
    pageSize: 50,
    fixturePath,
  });
}

export interface RecordedOdooCall {
  url: string;
  service: string;
  method: string;
  model?: string;
  args: unknown[];
}

export interface FakeOdoo {
  fetchImpl: FetchLike;
  calls: RecordedOdooCall[];
  saleOrders: Record<string, unknown>[];
  partners: Record<string, unknown>[];
}

/**
 * A fake Odoo external API.  It understands both the XML-RPC and the JSON-RPC
 * transports and records every call so that the tests can assert on the exact
 * payload that would have been sent to Odoo.
 */
export function createFakeOdoo(
  options: { existingPartners?: Record<string, unknown>[]; existingSaleOrders?: Record<string, unknown>[] } = {},
): FakeOdoo {
  const calls: RecordedOdooCall[] = [];
  const partners = [...(options.existingPartners ?? [])];
  const saleOrders = [...(options.existingSaleOrders ?? [])];
  let nextId = 700;

  const dispatch = (model: string, method: string, args: unknown[]): unknown => {
    switch (`${model}.${method}`) {
      case 'res.partner.search_read': {
        const domain = (args[0] ?? []) as unknown[][];
        const email = domain.find((clause) => clause[0] === 'email')?.[2];
        const match = email ? partners.find((partner) => partner.email === email) : undefined;
        return match ? [match] : [];
      }
      case 'res.partner.create': {
        const values = (args[0] ?? {}) as Record<string, unknown>;
        const created = { id: 55, ...values };
        partners.push(created);
        return created.id;
      }
      case 'sale.order.search_read': {
        const domain = (args[0] ?? []) as unknown[][];
        const reference = domain.find((clause) => clause[0] === 'client_order_ref')?.[2];
        const match = reference
          ? saleOrders.find((order) => order.client_order_ref === reference)
          : undefined;
        return match ? [match] : [];
      }
      case 'sale.order.create': {
        const values = (args[0] ?? {}) as Record<string, unknown>;
        nextId += 1;
        const created = { id: nextId, ...values };
        saleOrders.push(created);
        return created.id;
      }
      case 'sale.order.action_confirm':
        return true;
      case 'stock.picking.search_read':
        return [
          {
            id: 900,
            name: 'WH/OUT/00042',
            state: 'confirmed',
            scheduled_date: '2026-10-02 09:00:00',
            origin: 'S00042',
          },
        ];
      default:
        return true;
    }
  };

  const fetchImpl: FetchLike = async (url, init) => {
    const body = String(init.body ?? '');
    const isJson = body.trim().startsWith('{');
    let service = 'object';
    let method = '';
    let args: unknown[] = [];

    if (isJson) {
      const payload = JSON.parse(body) as {
        params: { service: string; method: string; args: unknown[] };
      };
      service = payload.params.service;
      method = payload.params.method;
      args = payload.params.args ?? [];
    } else {
      const call = parseMethodCall(body);
      method = call.method;
      args = call.params;
      service = method === 'login' ? 'common' : 'object';
    }

    const recorded: RecordedOdooCall = { url, service, method, args };
    if (method === 'execute_kw') {
      const [db, uid, password, model, modelMethod, modelArgs] = args as [
        string,
        number,
        string,
        string,
        string,
        unknown[],
      ];
      recorded.model = model;
      recorded.method = modelMethod;
      recorded.args = modelArgs ?? [];
    }
    calls.push(recorded);

    let result: unknown = true;
    if (method === 'login') {
      result = 1;
    } else if (method === 'execute_kw') {
      const [, , , model, modelMethod, modelArgs] = args as [
        string,
        number,
        string,
        string,
        string,
        unknown[],
      ];
      result = dispatch(model, modelMethod, modelArgs ?? []);
    }

    if (isJson) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', result, id: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(buildMethodResponse(result), {
      status: 200,
      headers: { 'content-type': 'text/xml' },
    });
  };

  return { fetchImpl, calls, saleOrders, partners };
}
