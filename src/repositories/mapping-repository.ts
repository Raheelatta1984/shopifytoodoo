/**
 * Shopify -> Odoo mapping tables (products and taxes).
 */
import type { Db } from '../db/types.js';
import { num } from '../db/types.js';

export interface ProductMapping {
  id?: string;
  shopifyProductId?: string;
  shopifyVariantId?: string;
  sku?: string;
  odooProductId: number;
  odooUomId?: number;
  description?: string;
  active: boolean;
}

export interface TaxMapping {
  id?: string;
  shopifyTaxTitle: string;
  shopifyPercentage?: number;
  odooTaxId: number;
}

export class MappingRepository {
  constructor(private readonly db: Db) {}

  async findProduct(input: {
    variantId?: string | null;
    sku?: string | null;
  }): Promise<ProductMapping | null> {
    if (input.variantId) {
      const { rows } = await this.db.query(
        'SELECT * FROM product_mapping WHERE shopify_variant_id = $1 AND active',
        [input.variantId],
      );
      if (rows[0]) return mapProduct(rows[0]);
    }
    if (input.sku) {
      const { rows } = await this.db.query(
        'SELECT * FROM product_mapping WHERE sku = $1 AND active',
        [input.sku],
      );
      if (rows[0]) return mapProduct(rows[0]);
    }
    return null;
  }

  async upsertProduct(mapping: ProductMapping): Promise<ProductMapping> {
    const existing = await this.findProduct({
      variantId: mapping.shopifyVariantId ?? null,
      sku: mapping.sku ?? null,
    });
    if (existing?.id) {
      const { rows } = await this.db.query<Record<string, unknown>>(
        `UPDATE product_mapping SET
           shopify_product_id = $2, shopify_variant_id = $3, sku = $4, odoo_product_id = $5,
           odoo_uom_id = $6, description = $7, active = $8, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          existing.id,
          mapping.shopifyProductId ?? null,
          mapping.shopifyVariantId ?? null,
          mapping.sku ?? null,
          mapping.odooProductId,
          mapping.odooUomId ?? null,
          mapping.description ?? null,
          mapping.active,
        ],
      );
      return mapProduct(rows[0]!);
    }
    const { rows } = await this.db.query<Record<string, unknown>>(
      `INSERT INTO product_mapping (
         shopify_product_id, shopify_variant_id, sku, odoo_product_id, odoo_uom_id, description, active, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7, now()) RETURNING *`,
      [
        mapping.shopifyProductId ?? null,
        mapping.shopifyVariantId ?? null,
        mapping.sku ?? null,
        mapping.odooProductId,
        mapping.odooUomId ?? null,
        mapping.description ?? null,
        mapping.active,
      ],
    );
    return mapProduct(rows[0]!);
  }

  async listProducts(): Promise<ProductMapping[]> {
    const { rows } = await this.db.query('SELECT * FROM product_mapping ORDER BY sku NULLS LAST');
    return rows.map((row) => mapProduct(row));
  }

  async deleteProduct(id: string): Promise<void> {
    await this.db.query('DELETE FROM product_mapping WHERE id = $1', [id]);
  }

  async findTax(title: string): Promise<TaxMapping | null> {
    const { rows } = await this.db.query(
      'SELECT * FROM tax_mapping WHERE lower(shopify_tax_title) = lower($1)',
      [title],
    );
    return rows[0] ? mapTax(rows[0]) : null;
  }

  async upsertTax(mapping: TaxMapping): Promise<TaxMapping> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `INSERT INTO tax_mapping (shopify_tax_title, shopify_percentage, odoo_tax_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (shopify_tax_title) DO UPDATE SET
         shopify_percentage = EXCLUDED.shopify_percentage, odoo_tax_id = EXCLUDED.odoo_tax_id
       RETURNING *`,
      [mapping.shopifyTaxTitle, mapping.shopifyPercentage ?? null, mapping.odooTaxId],
    );
    return mapTax(rows[0]!);
  }

  async listTaxes(): Promise<TaxMapping[]> {
    const { rows } = await this.db.query('SELECT * FROM tax_mapping ORDER BY shopify_tax_title');
    return rows.map((row) => mapTax(row));
  }

  async deleteTax(id: string): Promise<void> {
    await this.db.query('DELETE FROM tax_mapping WHERE id = $1', [id]);
  }
}

function mapProduct(row: Record<string, unknown>): ProductMapping {
  return {
    id: row.id ? String(row.id) : undefined,
    shopifyProductId: row.shopify_product_id ? String(row.shopify_product_id) : undefined,
    shopifyVariantId: row.shopify_variant_id ? String(row.shopify_variant_id) : undefined,
    sku: row.sku ? String(row.sku) : undefined,
    odooProductId: num(row.odoo_product_id),
    odooUomId: row.odoo_uom_id !== null && row.odoo_uom_id !== undefined ? num(row.odoo_uom_id) : undefined,
    description: row.description ? String(row.description) : undefined,
    active: row.active === null || row.active === undefined ? true : Boolean(row.active),
  };
}

function mapTax(row: Record<string, unknown>): TaxMapping {
  return {
    id: row.id ? String(row.id) : undefined,
    shopifyTaxTitle: String(row.shopify_tax_title ?? ''),
    shopifyPercentage:
      row.shopify_percentage !== null && row.shopify_percentage !== undefined
        ? num(row.shopify_percentage)
        : undefined,
    odooTaxId: num(row.odoo_tax_id),
  };
}
