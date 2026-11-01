import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers.js';

const addonRoot = join(repoRoot, 'odoo', 'addons', 'shopify_to_odoo');

function walk(directory: string): string[] {
  const entries: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) entries.push(...walk(path));
    else entries.push(path);
  }
  return entries;
}

describe('Odoo addon', () => {
  it('ships a valid manifest', () => {
    const manifest = readFileSync(join(addonRoot, '__manifest__.py'), 'utf8');
    // The manifest is a Python literal; the boolean keywords are normalised
    // so that it can be inspected as JSON.
    const parsed = JSON.parse(
      manifest.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null'),
    ) as Record<string, unknown>;
    expect(parsed.name).toBeTruthy();
    expect(parsed.version).toMatch(/^19\.0\./);
    expect(parsed.depends).toContain('sale');
    expect(parsed.installable).toBe(true);
  });

  it('declares the fields the integration writes', () => {
    const model = readFileSync(join(addonRoot, 'models', 'sale_order.py'), 'utf8');
    for (const field of [
      'x_shopify_order_id',
      'x_shopify_order_number',
      'x_shopify_source',
      'x_shopify_currency',
      'x_shopify_total',
    ]) {
      expect(model).toContain(field);
    }
    expect(model).toContain('_sql_constraints');
  });

  it('has an importable package layout', () => {
    const files = walk(addonRoot).map((path) => path.slice(addonRoot.length + 1));
    expect(files).toContain('__init__.py');
    expect(files).toContain('__manifest__.py');
    expect(files).toContain('models/__init__.py');
    expect(files).toContain('models/sale_order.py');
    expect(files).toContain('security/ir.model.access.csv');
  });

  it('has a well formed access file', () => {
    const csv = readFileSync(join(addonRoot, 'security', 'ir.model.access.csv'), 'utf8');
    const [header, ...rows] = csv.trim().split('\n');
    expect(header).toBe(
      'id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink',
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.split(',')).toHaveLength(8);
    }
  });
});
