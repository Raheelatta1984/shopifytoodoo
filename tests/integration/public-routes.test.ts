import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createTestContainer } from '../helpers.js';

/**
 * The landing page, the health probes and the documentation are public; the
 * API is not.  An unknown route must answer "not found" (and not "unauthorised",
 * which used to hide a typo behind a 401).
 */
describe('public routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const container = await createTestContainer();
    app = await buildApp(container, { logger: false, swagger: true });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves a landing page without an API key', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('shopifytoodoo');
    expect(response.body).toContain('/docs');
    expect(response.body).toContain('X-API-Key');
  });

  it('keeps the health probes and the documentation public', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/docs/json' })).statusCode).toBe(200);
  });

  it('answers "not found" for an unknown route', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: 'not_found',
      message: 'The route GET /nope does not exist',
    });
  });

  it('still protects the API', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/orders' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('explains how to authenticate in the 401 payload', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/orders' });
    const body = response.json() as { message: string; hint?: string };
    expect(body.message).toContain('X-API-Key');
    expect(body.hint).toContain('/docs');
  });

  it('requires a key for an unknown route under /api', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(anonymous.statusCode).toBe(401);

    const authorised = await app.inject({
      method: 'GET',
      url: '/api/v1/nope',
      headers: { 'x-api-key': 'test-admin-key-0001' },
    });
    expect(authorised.statusCode).toBe(404);
  });

  it('authorises a request that carries a valid API key', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/orders',
      headers: { 'x-api-key': 'test-admin-key-0001' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ total: expect.any(Number) });
  });
});
