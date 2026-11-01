/**
 * HTTP application.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { z } from 'zod';
import type { Container } from './container.js';
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
