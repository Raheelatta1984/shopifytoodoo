/**
 * Runtime configuration.
 *
 * Values are read from the environment (12-factor) and can be overridden at
 * runtime through the `app_setting` table so that operational staff can tune
 * thresholds without a redeploy (REQ-006, EV-EA0FC6E04E "Approvals depend on
 * a threshold").
 */
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),

  // --- Datastore -----------------------------------------------------
  // `DATABASE_URL` is the Neon (or any Postgres) connection string.
  // When absent the app falls back to an embedded PGlite instance so the
  // solution can be started with zero external dependencies.
  DATABASE_URL: z.string().min(1).optional(),
  PGLITE_PATH: z.string().default('./data/pglite'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  DB_SSL: z
    .enum(['disable', 'require', 'verify-full'])
    .default('disable')
    .describe('Neon requires "require" (or verify-full for the direct endpoint)'),

  // --- Shopify --------------------------------------------------------
  SHOPIFY_SHOP_DOMAIN: z.string().min(1).optional(),
  SHOPIFY_ACCESS_TOKEN: z.string().min(1).optional(),
  SHOPIFY_API_VERSION: z.string().default('2026-07'),
  SHOPIFY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(30000),
  SHOPIFY_PAGE_SIZE: z.coerce.number().int().min(1).max(250).default(50),
  SHOPIFY_FIXTURE: z
    .string()
    .optional()
    .describe('Path to a local Shopify GraphQL payload used for offline demo runs'),

  // --- Odoo -----------------------------------------------------------
  ODOO_URL: z.string().min(1).optional(),
  ODOO_DB: z.string().default(''),
  ODOO_USERNAME: z.string().default('admin'),
  ODOO_PASSWORD: z.string().default(''),
  ODOO_PROTOCOL: z.enum(['xmlrpc', 'jsonrpc']).default('xmlrpc'),
  ODOO_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(30000),
  ODOO_CREATE_MISSING_PARTNER: z
    .enum(['true', 'false'])
    .default('true')
    .describe('Create res.partner records when the Shopify customer is unknown'),

  // --- Application users / API keys -----------------------------------
  ADMIN_API_KEY: z.string().min(8).optional(),
  OPERATOR_API_KEY: z.string().min(8).optional(),
  APPROVER_API_KEY: z.string().min(8).optional(),
  AUDITOR_API_KEY: z.string().min(8).optional(),

  // --- Business defaults (DB settings override these) -----------------
  APPROVAL_THRESHOLD_AMOUNT: z.coerce.number().min(0).default(1000),
  APPROVAL_THRESHOLD_CURRENCY: z
    .string()
    .default('')
    .describe('Empty means "use the currency of the order being approved"'),
  FALLBACK_ODOO_PRODUCT_ID: z.coerce.number().int().positive().optional(),
  FALLBACK_ODOO_TAX_ID: z.coerce.number().int().positive().optional(),
  DEFAULT_UOM_ID: z.coerce.number().int().positive().optional(),
  SUPPORTED_CURRENCIES: z.string().default('AUD,USD,EUR,GBP,NZD,CAD,JPY'),
  CONFIRM_SALE_ORDER: z
    .enum(['true', 'false'])
    .default('true')
    .describe('Automatically confirm the sales order and read back the pickings'),

  LOG_LEVEL: z.string().default('info'),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export interface ShopifySettings {
  shopDomain: string;
  accessToken: string;
  apiVersion: string;
  timeoutMs: number;
  pageSize: number;
  fixturePath?: string;
}

export interface OdooSettings {
  url: string;
  db: string;
  username: string;
  password: string;
  protocol: 'xmlrpc' | 'jsonrpc';
  timeoutMs: number;
  createMissingPartner: boolean;
}

export function shopifySettings(cfg: AppConfig): ShopifySettings | null {
  const fixture = cfg.SHOPIFY_FIXTURE;
  if (!cfg.SHOPIFY_SHOP_DOMAIN || !cfg.SHOPIFY_ACCESS_TOKEN) {
    // A local fixture allows the whole pipeline to run without credentials.
    if (!fixture) return null;
    return {
      shopDomain: cfg.SHOPIFY_SHOP_DOMAIN ?? 'fixture.local',
      accessToken: cfg.SHOPIFY_ACCESS_TOKEN ?? 'fixture-token',
      apiVersion: cfg.SHOPIFY_API_VERSION,
      timeoutMs: cfg.SHOPIFY_TIMEOUT_MS,
      pageSize: cfg.SHOPIFY_PAGE_SIZE,
      fixturePath: fixture,
    };
  }
  return {
    shopDomain: cfg.SHOPIFY_SHOP_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    accessToken: cfg.SHOPIFY_ACCESS_TOKEN,
    apiVersion: cfg.SHOPIFY_API_VERSION,
    timeoutMs: cfg.SHOPIFY_TIMEOUT_MS,
    pageSize: cfg.SHOPIFY_PAGE_SIZE,
    ...(fixture ? { fixturePath: fixture } : {}),
  };
}

export function odooSettings(cfg: AppConfig): OdooSettings | null {
  if (!cfg.ODOO_URL) return null;
  return {
    url: cfg.ODOO_URL.replace(/\/$/, ''),
    db: cfg.ODOO_DB,
    username: cfg.ODOO_USERNAME,
    password: cfg.ODOO_PASSWORD,
    protocol: cfg.ODOO_PROTOCOL,
    timeoutMs: cfg.ODOO_TIMEOUT_MS,
    createMissingPartner: cfg.ODOO_CREATE_MISSING_PARTNER === 'true',
  };
}
