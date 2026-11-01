/**
 * Service entry point.
 *
 * Two ways to run the service:
 *
 * - `node dist/index.js` (or `npm start`) starts a long running HTTP server
 *   that listens on `HOST`/`PORT`.
 * - serverless platforms (Vercel, ...) import this module and use its
 *   **default export** as the `(req, res)` request handler.
 *
 * Importing the module never starts a listener by itself, so it is safe to
 * load it from a test or from another module.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { createContainer } from './container.js';
import { loadConfig } from './config.js';

export { default } from './app.js';

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

/** True when this file is the process entry point (`node dist/index.js`). */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error('Failed to start shopifytoodoo:', error);
    process.exit(1);
  });
}
