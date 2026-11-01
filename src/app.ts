/**
 * HTTP application.
 *
 * The module has two entry points:
 *
 * - `buildApp(container)` builds a Fastify instance from an existing
 *   container (used by the CLI, the tests and the standalone server).
 * - the **default export** is a `(req, res)` request handler.  Serverless
 *   platforms (Vercel, AWS Lambda, ...) load this module and require the
 *   default export to be a function or a server; without it the launcher
 *   aborts with "Invalid export found in module ... The default export must
 *   be a function or server".
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { z } from 'zod';
import type { Container } from './container.js';
import { loadConfig } from './config.js';
import { createContainer } from './container.js';
import { adminRoutes } from './routes/admin.js';
import { healthRoutes } from './routes/health.js';
import { orderRoutes } from './routes/orders.js';
import { AuthError, createAuthenticator } from './security/auth.js';

export interface BuildAppOptions {
  logger?: boolean;
  swagger?: boolean;
}

export async function buildApp(
  container: Container,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger === false ? false : { level: container.config.LOG_LEVEL },
    bodyLimit: 5 * 1024 * 1024,
  });

  if (options.swagger !== false) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'shopifytoodoo - Central Order Management',
          description:
            'Downloads Shopify orders into the central order tables, validates them, ' +
            'supports threshold based approvals and publishes sales orders to Odoo.',
          version: '1.0.0',
        },
        components: {
          securitySchemes: {
            apiKey: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
          },
        },
        security: [{ apiKey: [] }],
      },
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  const authenticate = createAuthenticator(container.userRepo);
  app.addHook('preHandler', async (request) => {
    // The health endpoints stay open so that orchestrators can probe them,
    // and the API documentation is public so that it can be shared.
    const url = request.url.split('?')[0] ?? '';
    if (url === '/health' || url === '/ready') return;
    if (url === '/docs' || url.startsWith('/docs/')) return;
    await authenticate(request);
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof AuthError) {
      return reply.code(error.statusCode).send({ error: 'unauthorized', message: error.message });
    }
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'The request payload is not valid',
        issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    const statusCode = error.statusCode ?? 500;
    request.log.error({ err: error }, 'request failed');
    return reply.code(statusCode).send({
      error: statusCode >= 500 ? 'internal_error' : 'request_failed',
      message: error.message,
    });
  });

  await app.register(healthRoutes, { container });
  await app.register(orderRoutes, { container });
  await app.register(adminRoutes, { container });

  return app;
}

// ---------------------------------------------------------------------------
// Serverless entry point
// ---------------------------------------------------------------------------

let serverPromise: Promise<FastifyInstance> | undefined;
let serverContainer: Container | undefined;

/**
 * Lazily builds the application (and its container) for the serverless
 * entry point.  The container is created on the first request and then
 * reused for the lifetime of the warm instance.
 */
export async function getServer(): Promise<FastifyInstance> {
  if (!serverPromise) {
    serverPromise = (async () => {
      const config = loadConfig();
      const container = await createContainer(config);
      await container.seed();
      serverContainer = container;
      const app = await buildApp(container);
      await app.ready();
      return app;
    })().catch((error: unknown) => {
      // A failed cold start must not poison the next invocation.
      serverPromise = undefined;
      serverContainer = undefined;
      throw error;
    });
  }
  return serverPromise;
}

/** Releases the container held by the serverless entry point. */
export async function closeServer(): Promise<void> {
  const pending = serverPromise;
  const container = serverContainer;
  serverPromise = undefined;
  serverContainer = undefined;
  if (pending) {
    const app = await pending.catch(() => undefined);
    if (app) await app.close();
  }
  if (container) await container.close();
}

/**
 * The default export: a `(req, res)` request handler for the serverless
 * platforms (Vercel, Lambda, ...) that load this module directly.
 */
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const app = await getServer();
    app.routing(req, res);
  } catch (error) {
    // The service could not start (the datastore is unreachable, ...).
    const message = error instanceof Error ? error.message : 'unknown error';
    if (!res.headersSent) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
    }
    res.end(JSON.stringify({ error: 'unavailable', message }));
  }
}
