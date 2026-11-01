import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createContainer } from '../../src/container.js';
import { PGliteDb } from '../../src/db/pglite.js';
import { OdooClient } from '../../src/integrations/odoo/client.js';
import { createFakeOdoo, fixtureClient, testConfig } from '../helpers.js';

const ADMIN = 'test-admin-key-0001';
const OPERATOR = 'test-operator-key-01';
const APPROVER = 'test-approver-key-01';
const AUDITOR = 'test-auditor-key-001';

describe('HTTP API', () => {
  let app: FastifyInstance;
  let container: Awaited<ReturnType<typeof createContainer>>;

  beforeAll(async () => {
    const odoo = createFakeOdoo();
    const db = new PGliteDb('memory://');
    await db.ready();
    container = await createContainer(testConfig(), {
      db,
      shopifyClient: fixtureClient(),
      odooClient: new OdooClient({
        url: 'http://odoo.test',
        db: 'demo',
        username: 'admin',
        password: 'admin',
        protocol: 'xmlrpc',
        timeoutMs: 5000,
        fetchImpl: odoo.fetchImpl,
      }),
    });
    await container.seed();
    await container.mappingRepo.upsertProduct({
      sku: 'TSHIRT-CLASSIC',
      odooProductId: 101,
      active: true,
    });
    await container.mappingRepo.upsertProduct({ sku: 'TOTE-CANVAS', odooProductId: 102, active: true });
    await container.mappingRepo.upsertProduct({ sku: 'MUG-ENAMEL', odooProductId: 103, active: true });
    await container.mappingRepo.upsertTax({ shopifyTaxTitle: 'GST', odooTaxId: 5 });
    app = await buildApp(container, { logger: false, swagger: true });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await container.close();
  });

  it('exposes an unauthenticated health endpoint', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', database: 'up' });
  });

  it('serves the API documentation without an API key', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(response.statusCode).toBe(200);
    const document = response.json() as { openapi: string; paths: Record<string, unknown> };
    expect(document.openapi).toMatch(/^3\./);
    expect(Object.keys(document.paths)).toContain('/api/v1/orders');
  });

  it('refuses a request without an API key', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/orders' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('refuses an unknown API key', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/orders',
      headers: { 'x-api-key': 'not-a-real-key' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('allows a viewer to read the orders', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/orders',
      headers: { 'x-api-key': ADMIN },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().orders).toEqual([]);
  });

  it('ingests the orders and lists them', async () => {
    const ingest = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/ingest',
      headers: { 'x-api-key': OPERATOR },
      payload: {},
    });
    expect(ingest.statusCode).toBe(200);
    expect(ingest.json()).toMatchObject({ received: 2, created: 2, failed: 0 });

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/orders',
      headers: { 'x-api-key': ADMIN },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(2);
    const order = list.json().orders.find((entry: { sourceOrderId: string }) => entry.sourceOrderId === '1001');
    expect(order).toMatchObject({ total: '79.20', currency: 'AUD', status: 'downloaded' });
  });

  it('returns the full order with the lines, discounts and transactions', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/orders',
      headers: { 'x-api-key': ADMIN },
    });
    const order = list
      .json()
      .orders.find((entry: { sourceOrderId: string }) => entry.sourceOrderId === '1001');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/orders/${order.id}`,
      headers: { 'x-api-key': ADMIN },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.head.total).toBe('79.20');
    expect(body.lines).toHaveLength(2);
    expect(body.lines[0]).toMatchObject({
      sku: 'TSHIRT-CLASSIC',
      listPrice: '25.00',
      discountTotal: '5.00',
      taxTotal: '4.50',
      netTotal: '45.00',
    });
    expect(body.discounts).toHaveLength(2);
    expect(body.transactions).toHaveLength(1);
    expect(body.fulfillments).toHaveLength(1);
  });

  it('validates the order and stores the rule results', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/orders',
      headers: { 'x-api-key': ADMIN },
    });
    const order = list
      .json()
      .orders.find((entry: { sourceOrderId: string }) => entry.sourceOrderId === '1001');

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${order.id}/validate`,
      headers: { 'x-api-key': OPERATOR },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('passed');
    expect(response.json().blockingFailures).toHaveLength(0);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/orders/${order.id}`,
      headers: { 'x-api-key': ADMIN },
    });
    expect(detail.json().validations.length).toBeGreaterThan(5);
  });

  it('refuses an approval from a role that is not allowed to approve', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/orders',
      headers: { 'x-api-key': ADMIN },
    });
    const order = list
      .json()
      .orders.find((entry: { sourceOrderId: string }) => entry.sourceOrderId === '1001');

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${order.id}/approve`,
      headers: { 'x-api-key': OPERATOR },
      payload: { decision: 'approve' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('forbidden');
  });

  it('allows an approver to approve the order', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/orders',
      headers: { 'x-api-key': ADMIN },
    });
    const order = list
      .json()
      .orders.find((entry: { sourceOrderId: string }) => entry.sourceOrderId === '1001');

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${order.id}/approve`,
      headers: { 'x-api-key': APPROVER },
      payload: { decision: 'approve', comment: 'checked' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().approvalStatus).toBe('approved');
  });

  it('publishes the order to Odoo', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/orders',
      headers: { 'x-api-key': ADMIN },
    });
    const order = list
      .json()
      .orders.find((entry: { sourceOrderId: string }) => entry.sourceOrderId === '1001');

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${order.id}/publish`,
      headers: { 'x-api-key': OPERATOR },
      payload: { method: 'xmlrpc' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('published');
    expect(response.json().odooSaleOrderId).toBeDefined();
  });

  it('rejects an invalid payload', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/ingest',
      headers: { 'x-api-key': OPERATOR },
      payload: { limit: 'not-a-number' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');
  });

  it('keeps the audit trail available to the auditor only', async () => {
    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/audit',
      headers: { 'x-api-key': OPERATOR },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/v1/audit',
      headers: { 'x-api-key': AUDITOR },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().entries.length).toBeGreaterThan(0);
  });

  it('lets an administrator change the settings', async () => {
    const denied = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: { 'x-api-key': OPERATOR },
      payload: { approvalThresholdAmount: 10 },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: { 'x-api-key': ADMIN },
      payload: { approvalThresholdAmount: 250 },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().settings.approvalThresholdAmount).toBe(250);

    const read = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { 'x-api-key': ADMIN },
    });
    expect(read.json().settings.approvalThresholdAmount).toBe(250);
  });

  it('manages the product and tax mappings', async () => {
    const product = await app.inject({
      method: 'POST',
      url: '/api/v1/mappings/products',
      headers: { 'x-api-key': ADMIN },
      payload: { sku: 'NEW-SKU', odooProductId: 999 },
    });
    expect(product.statusCode).toBe(201);

    const products = await app.inject({
      method: 'GET',
      url: '/api/v1/mappings/products',
      headers: { 'x-api-key': ADMIN },
    });
    expect(products.json().products.length).toBeGreaterThan(0);

    const tax = await app.inject({
      method: 'POST',
      url: '/api/v1/mappings/taxes',
      headers: { 'x-api-key': ADMIN },
      payload: { shopifyTaxTitle: 'GST', odooTaxId: 7 },
    });
    expect(tax.statusCode).toBe(201);
  });

  it('serves the DMF artefacts', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/orders',
      headers: { 'x-api-key': ADMIN },
    });
    const order = list
      .json()
      .orders.find((entry: { sourceOrderId: string }) => entry.sourceOrderId === '1002');

    await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${order.id}/validate`,
      headers: { 'x-api-key': OPERATOR },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${order.id}/publish`,
      headers: { 'x-api-key': OPERATOR },
      payload: { method: 'dmf' },
    });

    const artifacts = await app.inject({
      method: 'GET',
      url: `/api/v1/orders/${order.id}/dmf`,
      headers: { 'x-api-key': OPERATOR },
    });
    expect(artifacts.statusCode).toBe(200);
    expect(artifacts.json().artifacts.length).toBe(4);

    const download = await app.inject({
      method: 'GET',
      url: `/api/v1/orders/${order.id}/dmf/${artifacts.json().artifacts[2].id}`,
      headers: { 'x-api-key': OPERATOR },
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toContain('text/xml');
    expect(download.body).toContain('model="sale.order"');
  });
});
