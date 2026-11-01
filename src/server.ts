/**
 * Long running server entry point.
 *
 * `npm start` (and the Docker image) run this file: it builds the container
 * and starts the HTTP listener.  The serverless platforms use the default
 * export of `src/app.ts` instead (see `src/app.ts`).
 */
import { buildApp } from './app.js';
import { createContainer } from './container.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const container = await createContainer(config);
  await container.seed();

  const app = await buildApp(container);
  await app.listen({ host: config.HOST, port: config.PORT });

  app.log.info(
    {
      datastore: container.db.kind,
      shopify: container.shopify.settings ? 'configured' : 'not-configured',
      odoo: container.odoo.settings ? 'configured' : 'not-configured',
    },
    'shopifytoodoo is ready',
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await container.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Failed to start shopifytoodoo:', error);
  process.exit(1);
});
