/**
 * Plan for the Vercel environment variables.
 *
 * The service needs a handful of environment variables in Vercel (the
 * datastore and the API keys are mandatory, the Shopify and Odoo credentials
 * are needed for the ingestion and the publishing).  They must never be
 * committed: `vercel.json` and the repository stay free of secrets.
 *
 * This module builds the list of `vercel env add` operations; the CLI
 * (`src/cli/vercel-env.cli.ts`) executes it.  The logic is kept separate and
 * pure so it can be tested without touching Vercel.
 */
import { generateApiKey } from '../repositories/user-repository.js';

export type EnvTarget = 'production' | 'preview';

export interface EnvVariableSpec {
  name: string;
  required: boolean;
  secret: boolean;
  description: string;
  /** Generates a value when none is supplied (the API keys). */
  generate?: () => string;
}

/**
 * The variables of the service.  `required` means: without it the deployment
 * is not usable (no datastore, or nobody can authenticate).
 */
export const VERCEL_ENV_SPECS: readonly EnvVariableSpec[] = [
  {
    name: 'DATABASE_URL',
    required: true,
    secret: true,
    description: 'Neon (or any Postgres) connection string, e.g. ...?sslmode=require',
  },
  {
    name: 'ADMIN_API_KEY',
    required: true,
    secret: true,
    description: 'API key of the administrator role (stored hashed)',
    generate: () => generateApiKey(),
  },
  {
    name: 'OPERATOR_API_KEY',
    required: true,
    secret: true,
    description: 'API key of the operator role (download, validate, publish)',
    generate: () => generateApiKey(),
  },
  {
    name: 'APPROVER_API_KEY',
    required: true,
    secret: true,
    description: 'API key of the approver role (approvals above the threshold)',
    generate: () => generateApiKey(),
  },
  {
    name: 'AUDITOR_API_KEY',
    required: true,
    secret: true,
    description: 'API key of the auditor role (read only access to the audit trail)',
    generate: () => generateApiKey(),
  },
  {
    name: 'SHOPIFY_SHOP_DOMAIN',
    required: false,
    secret: false,
    description: 'your-shop.myshopify.com',
  },
  {
    name: 'SHOPIFY_ACCESS_TOKEN',
    required: false,
    secret: true,
    description: 'the Shopify Admin API access token (shpat_…)',
  },
  {
    name: 'SHOPIFY_API_VERSION',
    required: false,
    secret: false,
    description: 'the Shopify Admin API version (default 2026-07)',
  },
  {
    name: 'ODOO_URL',
    required: false,
    secret: false,
    description: 'https://your-company.odoo.com',
  },
  {
    name: 'ODOO_DB',
    required: false,
    secret: false,
    description: 'the Odoo database name',
  },
  {
    name: 'ODOO_USERNAME',
    required: false,
    secret: false,
    description: 'the Odoo user (default admin)',
  },
  {
    name: 'ODOO_PASSWORD',
    required: false,
    secret: true,
    description: 'the Odoo password or API key',
  },
  {
    name: 'ODOO_PROTOCOL',
    required: false,
    secret: false,
    description: 'xmlrpc (default) or jsonrpc',
  },
  {
    name: 'APPROVAL_THRESHOLD_AMOUNT',
    required: false,
    secret: false,
    description: 'the approval threshold in major units (default 1000)',
  },
  {
    name: 'SUPPORTED_CURRENCIES',
    required: false,
    secret: false,
    description: 'the accepted currencies (default AUD,USD,EUR,GBP,NZD,CAD,JPY)',
  },
] as const;

/** The variables the deployment cannot work without. */
export const REQUIRED_ENV_NAMES = VERCEL_ENV_SPECS.filter((spec) => spec.required).map(
  (spec) => spec.name,
);

/** Reads a `KEY=value` file (the format of `.env.example`). */
export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (name) values[name] = value;
  }
  return values;
}

/** The variables that are required but have no value. */
export function missingVariables(
  values: Record<string, string>,
  specs: readonly EnvVariableSpec[] = VERCEL_ENV_SPECS,
): string[] {
  return specs
    .filter((spec) => spec.required && !(values[spec.name] ?? '').trim())
    .map((spec) => spec.name);
}

/**
 * Completes the values with the generated ones (the API keys) and returns
 * the plan: one entry per project, per target and per variable.
 */
export function buildEnvPlan(options: {
  values: Record<string, string>;
  projects: readonly string[];
  targets?: readonly EnvTarget[];
  specs?: readonly EnvVariableSpec[];
}): {
  entries: { project: string; target: EnvTarget; name: string; value: string; secret: boolean }[];
  values: Record<string, string>;
} {
  const specs = options.specs ?? VERCEL_ENV_SPECS;
  const targets = options.targets ?? (['production', 'preview'] as const);
  const values: Record<string, string> = { ...options.values };

  for (const spec of specs) {
    const current = (values[spec.name] ?? '').trim();
    if (!current && spec.generate) values[spec.name] = spec.generate();
  }

  const entries = options.projects.flatMap((project) =>
    targets.flatMap((target) =>
      specs
        .filter((spec) => (values[spec.name] ?? '').trim())
        .map((spec) => ({
          project,
          target,
          name: spec.name,
          value: values[spec.name]!,
          secret: spec.secret,
        })),
    ),
  );

  return { entries, values };
}

/** The command that adds one variable to one project (the value is piped). */
export function envAddCommand(entry: {
  project: string;
  target: EnvTarget;
  name: string;
  secret: boolean;
}): { command: string; args: string[] } {
  const args = [
    'vercel',
    'env',
    'add',
    entry.name,
    '--project',
    entry.project,
    '--target',
    entry.target,
    '--yes',
  ];
  if (entry.secret) args.push('--sensitive');
  return { command: 'npx', args };
}
