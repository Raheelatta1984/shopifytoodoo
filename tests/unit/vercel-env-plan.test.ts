import { describe, expect, it } from 'vitest';
import {
  REQUIRED_ENV_NAMES,
  VERCEL_ENV_SPECS,
  buildEnvPlan,
  envAddCommand,
  missingVariables,
  parseEnvFile,
} from '../../src/cli/vercel-env.js';

describe('Vercel environment plan', () => {
  it('requires a datastore and one API key per role', () => {
    expect(REQUIRED_ENV_NAMES).toEqual([
      'DATABASE_URL',
      'ADMIN_API_KEY',
      'OPERATOR_API_KEY',
      'APPROVER_API_KEY',
      'AUDITOR_API_KEY',
    ]);
  });

  it('marks the secrets', () => {
    const secret = VERCEL_ENV_SPECS.filter((spec) => spec.secret).map((spec) => spec.name);
    expect(secret).toContain('DATABASE_URL');
    expect(secret).toContain('ADMIN_API_KEY');
    expect(secret).toContain('SHOPIFY_ACCESS_TOKEN');
    expect(secret).toContain('ODOO_PASSWORD');
    // The non secret ones stay readable in the dashboard.
    expect(secret).not.toContain('SHOPIFY_SHOP_DOMAIN');
    expect(secret).not.toContain('APPROVAL_THRESHOLD_AMOUNT');
  });

  it('reports the variables that are required but missing', () => {
    expect(missingVariables({})).toEqual(REQUIRED_ENV_NAMES);
    expect(missingVariables({ DATABASE_URL: 'postgresql://x' })).toEqual(
      REQUIRED_ENV_NAMES.filter((name) => name !== 'DATABASE_URL'),
    );
    expect(
      missingVariables({
        DATABASE_URL: 'postgresql://x',
        ADMIN_API_KEY: 'a',
        OPERATOR_API_KEY: 'b',
        APPROVER_API_KEY: 'c',
        AUDITOR_API_KEY: 'd',
      }),
    ).toEqual([]);
  });

  it('reads an env file', () => {
    const values = parseEnvFile(
      [
        '# a comment',
        '',
        'DATABASE_URL=postgresql://user:pass@host/db?sslmode=require',
        'ADMIN_API_KEY="quoted-value"',
        "OPERATOR_API_KEY='single'",
        'not a pair',
        'EMPTY=',
      ].join('\n'),
    );
    expect(values.DATABASE_URL).toBe('postgresql://user:pass@host/db?sslmode=require');
    expect(values.ADMIN_API_KEY).toBe('quoted-value');
    expect(values.OPERATOR_API_KEY).toBe('single');
    expect(values.EMPTY).toBe('');
    expect(values['not a pair']).toBeUndefined();
  });

  it('generates a distinct API key per role when none is supplied', () => {
    const { values } = buildEnvPlan({ values: {}, projects: ['p'] });
    const keys = ['ADMIN_API_KEY', 'OPERATOR_API_KEY', 'APPROVER_API_KEY', 'AUDITOR_API_KEY'].map(
      (name) => values[name]!,
    );
    for (const key of keys) {
      expect(key.length).toBeGreaterThanOrEqual(8);
      expect(key).toMatch(/^[A-Za-z0-9_.-]+$/);
    }
    expect(new Set(keys).size).toBe(4);
  });

  it('keeps the supplied values', () => {
    const { values } = buildEnvPlan({
      values: { DATABASE_URL: 'postgresql://x', ADMIN_API_KEY: 'mine' },
      projects: ['p'],
    });
    expect(values.ADMIN_API_KEY).toBe('mine');
  });

  it('builds one entry per project, per target and per variable', () => {
    const { entries } = buildEnvPlan({
      values: { DATABASE_URL: 'postgresql://x' },
      projects: ['shopifytoodoo', 'shopifytoodoo2'],
      targets: ['production'],
    });
    // 2 projects x 1 target x (DATABASE_URL + 4 generated keys)
    expect(entries).toHaveLength(10);
    expect(entries.filter((entry) => entry.project === 'shopifytoodoo')).toHaveLength(5);
    expect(entries.every((entry) => entry.target === 'production')).toBe(true);
    expect(entries.every((entry) => entry.name !== '' && entry.value !== '')).toBe(true);
  });

  it('never puts a secret in the command line', () => {
    const { command, args } = envAddCommand({
      project: 'shopifytoodoo',
      target: 'production',
      name: 'ADMIN_API_KEY',
      secret: true,
    });
    expect(command).toBe('npx');
    expect(args).toContain('--sensitive');
    expect(args).toContain('--project');
    expect(args).toContain('shopifytoodoo');
    expect(args).toContain('production');
    // The value is piped on stdin, never passed as an argument.
    expect(args.join(' ')).not.toMatch(/sto_[a-f0-9]{10,}/);
  });
});
