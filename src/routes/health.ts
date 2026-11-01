import type { FastifyInstance } from 'fastify';
import type { Container } from '../container.js';

export async function healthRoutes(app: FastifyInstance, options: { container: Container }): Promise<void> {
  const { container } = options;
  app.get('/health', async (_request, reply) => {
    let database = 'down';
    try {
      await container.db.query('SELECT 1');
      database = 'up';
    } catch {
      database = 'down';
    }
    const healthy = database === 'up';
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      service: 'shopifytoodoo',
      version: '1.0.0',
      database,
      datastore: container.db.kind,
      shopify: container.shopify.settings ? 'configured' : 'not-configured',
      odoo: container.odoo.settings ? 'configured' : 'not-configured',
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/ready', async (_request, reply) => {
    try {
      await container.db.query('SELECT 1');
      return reply.send({ ready: true });
    } catch (error) {
      return reply.code(503).send({ ready: false, error: (error as Error).message });
    }
  });
}
