/**
 * Runtime settings, stored in `app_setting` so that operational thresholds can
 * be changed without a redeploy.  Environment variables provide the defaults.
 */
import type { Db } from '../db/types.js';
import { json } from '../db/types.js';

export const SETTING_KEYS = {
  approvalThresholdAmount: 'approval.threshold_amount',
  approvalThresholdCurrency: 'approval.threshold_currency',
  supportedCurrencies: 'order.supported_currencies',
  fallbackOdooProductId: 'odoo.fallback_product_id',
  fallbackOdooTaxId: 'odoo.fallback_tax_id',
  defaultUomId: 'odoo.default_uom_id',
  companyId: 'odoo.company_id',
  warehouseId: 'odoo.warehouse_id',
  pricelistId: 'odoo.pricelist_id',
  paymentTermId: 'odoo.payment_term_id',
  currencyId: 'odoo.currency_id',
  confirmSaleOrder: 'odoo.confirm_sale_order',
  createMissingPartner: 'odoo.create_missing_partner',
  writeCustomFields: 'odoo.write_custom_fields',
  dmfUploadEnabled: 'dmf.upload_enabled',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

export interface Settings extends Record<string, unknown> {
  approvalThresholdAmount: number;
  approvalThresholdCurrency: string;
  supportedCurrencies: string[];
  fallbackOdooProductId?: number;
  fallbackOdooTaxId?: number;
  defaultUomId?: number;
  companyId?: number;
  warehouseId?: number;
  pricelistId?: number;
  paymentTermId?: number;
  currencyId?: number;
  confirmSaleOrder: boolean;
  createMissingPartner: boolean;
  writeCustomFields: boolean;
  dmfUploadEnabled: boolean;
}

export class SettingsRepository {
  constructor(private readonly db: Db) {}

  async getAll(defaults: Settings): Promise<Settings> {
    const { rows } = await this.db.query('SELECT key, value FROM app_setting');
    const result: Record<string, unknown> = { ...defaults };
    for (const [property, dbKey] of Object.entries(SETTING_KEYS)) {
      const row = rows.find((entry) => String(entry.key) === dbKey);
      if (!row) continue;
      result[property] = json(row.value, result[property]);
    }
    return result as Settings;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO app_setting (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  async setMany(values: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(values)) {
      await this.set(key, value);
    }
  }

  async list(): Promise<{ key: string; value: unknown; updatedAt?: string }[]> {
    const { rows } = await this.db.query(
      'SELECT key, value, updated_at FROM app_setting ORDER BY key',
    );
    return rows.map((row) => ({
      key: String(row.key),
      value: json(row.value, undefined),
      updatedAt: row.updated_at ? String(row.updated_at) : undefined,
    }));
  }
}
