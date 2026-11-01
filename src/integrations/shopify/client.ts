/**
 * Shopify Admin GraphQL client.
 *
 * The transport is injectable so the whole ingestion path can be exercised in
 * tests (and offline demos) without touching the Shopify API.
 */
import { readFile } from 'node:fs/promises';
import { ORDERS_QUERY } from './queries.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ShopifyClientOptions {
  shopDomain: string;
  accessToken: string;
  apiVersion: string;
  timeoutMs: number;
  pageSize: number;
  fetchImpl?: FetchLike;
  fixturePath?: string;
}

export interface ShopifyQueryParams {
  /** Shopify search query, e.g. `updated_at:>=2026-10-01`. */
  query?: string;
  /** Hard cap on the number of orders pulled in a single run. */
  limit?: number;
}

export interface OrdersQueryData {
  orders: {
    nodes: Record<string, unknown>[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export interface ShopifyPage {
  nodes: Record<string, unknown>[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export class ShopifyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly errors?: unknown,
  ) {
    super(message);
    this.name = 'ShopifyError';
  }
}

export class ShopifyClient {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: ShopifyClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  get endpoint(): string {
    return `https://${this.options.shopDomain}/admin/api/${this.options.apiVersion}/graphql.json`;
  }

  /** Execute a raw GraphQL document. */
  async graphql<T = Record<string, unknown>>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': this.options.accessToken,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: { data?: T; errors?: { message: string }[] };
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ShopifyError(
          `Shopify returned a non-JSON response (HTTP ${response.status})`,
          response.status,
        );
      }
      if (!response.ok || payload.errors?.length) {
        const message =
          payload.errors?.map((e) => e.message).join('; ') ||
          `Shopify request failed with HTTP ${response.status}`;
        throw new ShopifyError(message, response.status, payload.errors);
      }
      if (!payload.data) throw new ShopifyError('Shopify response contained no data');
      return payload.data;
    } catch (error) {
      if (error instanceof ShopifyError) throw error;
      throw new ShopifyError(
        `Shopify request failed: ${(error as Error).message}`,
        undefined,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Pull orders page by page.  When a fixture is configured the orders are
   * served from disk, which allows the complete pipeline to be demonstrated
   * and tested without Shopify credentials.
   */
  async *fetchOrderPages(params: ShopifyQueryParams = {}): AsyncGenerator<ShopifyPage> {
    if (this.options.fixturePath) {
      yield* this.fetchFixturePages(params);
      return;
    }

    let cursor: string | null = null;
    let fetched = 0;
    do {
      const data: OrdersQueryData = await this.graphql<OrdersQueryData>(ORDERS_QUERY, {
        cursor,
        pageSize: this.options.pageSize,
        query: params.query ?? null,
      });

      const connection: OrdersQueryData['orders'] = data.orders;
      const nodes = connection?.nodes ?? [];
      const remaining = params.limit !== undefined ? params.limit - fetched : undefined;
      const slice = remaining !== undefined ? nodes.slice(0, Math.max(remaining, 0)) : nodes;

      yield {
        nodes: slice,
        hasNextPage: Boolean(connection?.pageInfo?.hasNextPage) && slice.length === nodes.length,
        endCursor: connection?.pageInfo?.endCursor ?? null,
      };

      fetched += slice.length;
      cursor = connection?.pageInfo?.endCursor ?? null;
      if (params.limit !== undefined && fetched >= params.limit) return;
    } while (cursor);
  }

  private async *fetchFixturePages(params: ShopifyQueryParams): AsyncGenerator<ShopifyPage> {
    const raw = await readFile(this.options.fixturePath!, 'utf8');
    const parsed = JSON.parse(raw) as
      | { data?: { orders?: { nodes?: Record<string, unknown>[] } }; orders?: { nodes?: Record<string, unknown>[] } }
      | Record<string, unknown>[];

    const nodes: Record<string, unknown>[] = Array.isArray(parsed)
      ? (parsed as Record<string, unknown>[])
      : (parsed.data?.orders?.nodes ?? (parsed as { orders?: { nodes?: Record<string, unknown>[] } }).orders?.nodes ?? []);

    const limit = params.limit ?? nodes.length;
    const slice = nodes.slice(0, limit);
    const pageSize = this.options.pageSize;
    for (let index = 0; index < slice.length; index += pageSize) {
      const page = slice.slice(index, index + pageSize);
      yield {
        nodes: page,
        hasNextPage: index + pageSize < slice.length,
        endCursor: null,
      };
    }
  }
}
