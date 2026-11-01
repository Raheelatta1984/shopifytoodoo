/**
 * Service entry point for the serverless platforms.
 *
 * The module has **no side effect**: importing it neither starts a listener
 * nor opens a database connection.  The default export is the `(req, res)`
 * request handler that the platforms require:
 *
 *   Invalid export found in module "/var/task/src/app.js".
 *   The default export must be a function or server.
 *
 * The long running server lives in `src/server.ts` (`npm start`).
 */
export { default } from './app.js';
export { buildApp, closeServer, getServer } from './app.js';
