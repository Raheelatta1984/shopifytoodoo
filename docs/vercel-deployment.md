# Deploying on Vercel (serverless)

The solution is deployed as a **single serverless function**.  The entry point
is `src/app.ts`, whose **default export** is the `(req, res)` request handler.

## 1. Why the default export matters

Vercel loads the entry module and starts the function with its launcher.  The
launcher requires the module to **default export a function or a server**:

```
Invalid export found in module "/var/task/src/app.js".

The default export must be a function or server.

Node.js process exited with exit status: 1.
```

The launcher aborts **before** handling a single request, so every route
answers `500 FUNCTION_INVOCATION_FAILED`.  `src/app.ts` therefore exports:

```ts
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await getServer();   // the container is created on the first request
  app.routing(req, res);           // Fastify handles the raw Node request
}
```

`src/index.ts` re-exports the same handler, so the function works whichever of
the two files the platform picks as the entry point.

The contract is protected by `tests/integration/serverless-entrypoint.test.ts`,
which uses the default export as the request listener of a plain Node HTTP
server — exactly what the platform does.

## 2. Project settings

| Setting | Value |
|---|---|
| Framework preset | **Other** (the repository ships its own entry point) |
| Root directory | the repository root |
| Node.js version | 22 (`engines.node >= 20.11.0`) |
| Install command | `npm ci` |
| Build command | `npm run build` (optional, the platform compiles the TypeScript entry) |

`package.json#main` points at `src/app.ts` and `vercel.json` sets the maximum
duration of the function to 60 seconds:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "functions": { "src/app.ts": { "maxDuration": 60 } }
}
```

## 3. Environment variables

The function needs a datastore: set `DATABASE_URL` to the Neon (or any
Postgres) connection string.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | **yes in production** | Neon connection string, `?sslmode=require` |
| `DB_SSL` | recommended | `require` (or `verify-full` with the direct endpoint) |
| `ADMIN_API_KEY` | yes | the administrator API key (minimum 8 characters) |
| `OPERATOR_API_KEY`, `APPROVER_API_KEY`, `AUDITOR_API_KEY` | recommended | one key per role |
| `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ACCESS_TOKEN` | for the ingestion | the Shopify Admin API credentials |
| `SHOPIFY_API_VERSION` | no | defaults to `2026-07` |
| `ODOO_URL`, `ODOO_DB`, `ODOO_USERNAME`, `ODOO_PASSWORD` | for the publishing | the Odoo 19 external API |
| `ODOO_PROTOCOL` | no | `xmlrpc` (default) or `jsonrpc` |
| `APPROVAL_THRESHOLD_AMOUNT` | no | defaults to `1000` |

When `DATABASE_URL` is missing the function falls back to the embedded
Postgres (PGlite).  A serverless runtime has a read only filesystem outside of
`/tmp`, so the data directory is automatically redirected to the temporary
directory (and to an in memory database if that fails as well).  **The data is
lost when the instance is recycled — always set `DATABASE_URL`.**

## 4. Behaviour of the function

* The container (and the database connection) is created on the **first
  request** and reused while the instance stays warm.
* A failed cold start answers `503 {"error":"unavailable"}` instead of
  crashing, and the next invocation retries the initialisation.
* The migrations run automatically when the container is created, so a fresh
  Neon branch is usable without a manual step.
* The Shopify and Odoo credentials are only read from the environment; they
  are never written to the database or to the logs.

## 5. Verifying the deployment

```bash
curl -s https://<your-deployment>/health
curl -s -o /dev/null -w "%{http_code}\n" https://<your-deployment>/docs
curl -s -H "X-API-Key: $ADMIN_API_KEY" https://<your-deployment>/api/v1/orders
```

The deployment logs must not contain `Invalid export found` any more.

## 6. Docker (a long running instance)

When the service must stay warm (or when the Odoo import needs a long
timeout), use the container instead:

```bash
docker compose up -d
docker compose logs -f shopifytoodoo
```

`npm start` runs the same code as a plain Node server (`dist/index.js`).
