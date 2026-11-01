/**
 * Odoo external API client.
 *
 * Supports both transports that Odoo 19 exposes:
 *  - XML-RPC (`/xmlrpc/2/common`, `/xmlrpc/2/object`) - the classic API,
 *  - JSON-RPC (`/jsonrpc`) - the same service exposed over JSON.
 *
 * The client is transport agnostic so the publishing service can be tested
 * against a fake Odoo without a live instance.
 */
import { buildMethodCall, parseMethodResponse, XmlRpcFaultError } from './xmlrpc.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface OdooClientOptions {
  url: string;
  db: string;
  username: string;
  password: string;
  protocol: 'xmlrpc' | 'jsonrpc';
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

export class OdooError extends Error {
  constructor(
    message: string,
    readonly fault?: unknown,
  ) {
    super(message);
    this.name = 'OdooError';
  }
}

export class OdooClient {
  private readonly fetchImpl: FetchLike;
  private uid: number | null = null;

  constructor(private readonly options: OdooClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  get baseUrl(): string {
    return this.options.url.replace(/\/$/, '');
  }

  /** Authenticate and cache the user id. */
  async authenticate(): Promise<number> {
    if (this.uid !== null) return this.uid;
    const uid = await this.serviceCall('common', 'login', [
      this.options.db,
      this.options.username,
      this.options.password,
    ]);
    if (typeof uid !== 'number' || uid === 0) {
      throw new OdooError(
        `Odoo authentication failed for user "${this.options.username}" on database "${this.options.db}"`,
        uid,
      );
    }
    this.uid = uid;
    return uid;
  }

  /** Call a method on an Odoo model. */
  async call<T = unknown>(
    model: string,
    method: string,
    args: unknown[] = [],
    kwargs: Record<string, unknown> = {},
  ): Promise<T> {
    const uid = await this.authenticate();
    return this.serviceCall<T>('object', 'execute_kw', [
      this.options.db,
      uid,
      this.options.password,
      model,
      method,
      args,
      kwargs,
    ]);
  }

  async searchRead<T = Record<string, unknown>>(
    model: string,
    domain: unknown[],
    fields: string[],
    options: Record<string, unknown> = { limit: 80 },
  ): Promise<T[]> {
    const result = await this.call<T[]>(model, 'search_read', [domain, fields], options);
    return Array.isArray(result) ? result : [];
  }

  async create(model: string, values: Record<string, unknown>): Promise<number> {
    const id = await this.call<number | number[]>(model, 'create', [values]);
    return Array.isArray(id) ? id[0]! : id;
  }

  async write(model: string, ids: number[], values: Record<string, unknown>): Promise<boolean> {
    return this.call<boolean>(model, 'write', [ids, values]);
  }

  /** Low level service call (`common` or `object`). */
  private async serviceCall<T>(service: 'common' | 'object', method: string, args: unknown[]): Promise<T> {
    if (this.options.protocol === 'jsonrpc') {
      return this.jsonRpcCall<T>(service, method, args);
    }
    return this.xmlRpcCall<T>(service, method, args);
  }

  private async xmlRpcCall<T>(service: 'common' | 'object', method: string, args: unknown[]): Promise<T> {
    const endpoint =
      service === 'common'
        ? `${this.baseUrl}/xmlrpc/2/common`
        : `${this.baseUrl}/xmlrpc/2/object`;
    const body = buildMethodCall(method, args);
    const response = await this.request(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body,
    });
    const text = await response.text();
    try {
      return parseMethodResponse(text) as T;
    } catch (error) {
      if (error instanceof XmlRpcFaultError) {
        throw new OdooError(`Odoo call "${method}" failed: ${error.message}`, error.fault);
      }
      throw new OdooError(`Invalid XML-RPC response from Odoo: ${(error as Error).message}`);
    }
  }

  private async jsonRpcCall<T>(service: 'common' | 'object', method: string, args: unknown[]): Promise<T> {
    const endpoint = `${this.baseUrl}/jsonrpc`;
    const response = await this.request(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: { service, method, args },
        id: Date.now(),
      }),
    });
    const text = await response.text();
    let payload: { result?: T; error?: { message?: string; data?: { message?: string } } };
    try {
      payload = JSON.parse(text);
    } catch {
      throw new OdooError(`Invalid JSON-RPC response from Odoo (HTTP ${response.status})`);
    }
    if (payload.error) {
      const message = payload.error.data?.message ?? payload.error.message ?? 'unknown error';
      throw new OdooError(`Odoo call failed: ${message}`, payload.error);
    }
    return payload.result as T;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      if (!response.ok && response.status >= 500) {
        throw new OdooError(`Odoo returned HTTP ${response.status} for ${url}`);
      }
      return response;
    } catch (error) {
      if (error instanceof OdooError) throw error;
      throw new OdooError(`Odoo request failed: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
