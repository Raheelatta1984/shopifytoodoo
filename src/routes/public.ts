/**
 * Public entry point of the service.
 *
 * `/` is the landing page: it is what a browser (or a health checker) hits
 * when the deployment URL is opened.  It used to answer `401 unauthorised`,
 * which looked like a broken deployment.
 */
import type { FastifyInstance } from 'fastify';
import type { Container } from '../container.js';

const SERVICE_VERSION = '1.0.0';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function publicRoutes(app: FastifyInstance, options: { container: Container }): Promise<void> {
  const { container } = options;

  app.get('/', async (_request, reply) => {
    const datastore = escapeHtml(container.db.kind);
    const shopify = container.shopify.settings ? 'configured' : 'not configured';
    const odoo = container.odoo.settings ? 'configured' : 'not configured';

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>shopifytoodoo &middot; Central Order Management</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 2.5rem 1.25rem; font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 44rem; margin: 0 auto; }
  h1 { margin: 0 0 .25rem; font-size: 1.6rem; letter-spacing: -.01em; }
  .lead { margin: 0 0 1.75rem; opacity: .8; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .45rem 1.25rem; margin: 0 0 1.75rem; }
  dt { font-weight: 600; }
  dd { margin: 0; opacity: .8; }
  a { color: inherit; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; }
  .note { padding: .9rem 1.1rem; border: 1px solid currentColor; border-radius: .6rem; opacity: .9; }
  .meta { margin-top: 2rem; font-size: .85rem; opacity: .6; }
</style>
</head>
<body>
<main>
  <h1>shopifytoodoo</h1>
  <p class="lead">Central Order Management &mdash; the Shopify orders are downloaded into the central tables, validated, approved and published as Odoo sales orders.</p>
  <dl>
    <dt><a href="/health">/health</a></dt><dd>service and datastore status</dd>
    <dt><a href="/ready">/ready</a></dt><dd>readiness probe</dd>
    <dt><a href="/docs">/docs</a></dt><dd>OpenAPI documentation and Swagger UI</dd>
    <dt><code>/api/v1/&hellip;</code></dt><dd>the API &mdash; an API key is required</dd>
  </dl>
  <p class="note">The API requires an API key: send it in the <code>X-API-Key</code> header (or <code>Authorization: Bearer &lt;key&gt;</code>). The keys are created from the <code>ADMIN_API_KEY</code>, <code>OPERATOR_API_KEY</code>, <code>APPROVER_API_KEY</code> and <code>AUDITOR_API_KEY</code> environment variables; each one is stored hashed.</p>
  <p class="meta">version ${SERVICE_VERSION} &middot; datastore ${datastore} &middot; Shopify ${shopify} &middot; Odoo ${odoo}</p>
</main>
</body>
</html>
`;

    return reply
      .code(200)
      .header('Content-Type', 'text/html; charset=utf-8')
      .send(html);
  });
}
