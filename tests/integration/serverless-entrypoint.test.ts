import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import handler, { closeServer } from '../../src/app.js';
import { repoRoot } from '../helpers.js';

/**
 * The serverless platforms (Vercel and friends) load the entry module and
 * require its **default export** to be a function or a server.  Without it
 * the launcher aborts with:
 *
 *   Invalid export found in module "/var/task/src/app.js".
 *   The default export must be a function or server.
 *
 * These tests replicate that contract: the default export is used as the
 * request listener of a plain Node HTTP server, exactly like the platform
 * does.
 */
describe('serverless entry point', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    // The handler creates its own container: keep it in memory.
    process.env.PGLITE_PATH = 'memory://';
    process.env.ADMIN_API_KEY = 'entrypoint-admin-key-01';

    server = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await closeServer();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('default exports a function (the shape the launcher requires)', () => {
    expect(typeof handler).toBe('function');
  });

  it('answers a health check through the raw request handler', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; database: string };
    expect(body.status).toBe('ok');
    expect(body.database).toBe('up');
  });

  it('runs the authentication hook on the raw request handler', async () => {
    const response = await fetch(`${baseUrl}/api/v1/orders`);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('authorises a request that carries a valid API key', async () => {
    const response = await fetch(`${baseUrl}/api/v1/orders`, {
      headers: { 'x-api-key': 'entrypoint-admin-key-01' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: expect.any(Number) });
  });

  it('exposes the same contract from the service entry point', async () => {
    const entry = await import('../../src/index.js');
    expect(typeof entry.default).toBe('function');
  });

  it('points the package entry point at a module with a default export', async () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, 'package.json'), 'utf8'),
    ) as { main?: string };
    expect(manifest.main).toBe('src/app.ts');
    const entry = await import('../../src/app.js');
    expect(typeof entry.default).toBe('function');
  });
});
