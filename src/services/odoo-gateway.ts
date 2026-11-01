/**
 * Odoo gateway: the thin layer between the domain and the Odoo external API.
 *
 * It resolves partners, creates the sales order, confirms it and reads the
 * generated pickings back into the central order tables.
 */
import type { OdooClient } from '../integrations/odoo/client.js';
import type { StoredHead } from '../domain/types.js';

export interface PartnerResolution {
  partnerId: number;
  created: boolean;
}

export interface PickingRecord {
  odooPickingId?: number;
  name?: string;
  state?: string;
  scheduledDate?: string;
  origin?: string;
}

export interface OdooGatewayOptions {
  createMissingPartner: boolean;
  companyId?: number;
}

export class OdooGateway {
  constructor(
    private readonly client: OdooClient,
    private readonly options: OdooGatewayOptions,
  ) {}

  /**
   * Find the Odoo partner for the Shopify customer.  The customer reference is
   * matched on the email address first and on the Shopify customer id second.
   */
  async resolvePartner(head: StoredHead): Promise<PartnerResolution> {
    const email = head.customerEmail;
    const reference = head.customerRef;

    if (email) {
      const found = await this.client.searchRead<{ id: number }>(
        'res.partner',
        [['email', '=', email]],
        ['id'],
        { limit: 1 },
      );
      if (found[0]) return { partnerId: found[0].id, created: false };
    }

    if (reference) {
      const found = await this.client.searchRead<{ id: number }>(
        'res.partner',
        [['ref', '=', `shopify-${reference}`]],
        ['id'],
        { limit: 1 },
      );
      if (found[0]) return { partnerId: found[0].id, created: false };
    }

    if (!this.options.createMissingPartner) {
      throw new Error(
        `No Odoo partner matches the Shopify customer (${email ?? reference ?? 'unknown'}) and partner creation is disabled`,
      );
    }

    const values: Record<string, unknown> = {
      name: head.customerName ?? head.customerEmail ?? 'Shopify Customer',
    };
    if (head.customerEmail) values.email = head.customerEmail;
    if (head.customerPhone) values.phone = head.customerPhone;
    if (reference) values.ref = `shopify-${reference}`;

    const address = head.shippingAddress ?? head.billingAddress;
    if (address) {
      if (address.address1) values.street = address.address1;
      if (address.address2) values.street2 = address.address2;
      if (address.city) values.city = address.city;
      if (address.zip) values.zip = address.zip;
      if (address.state) values.state_id = address.state;
      if (address.countryCode) values.country_id = address.countryCode;
    }

    const partnerId = await this.client.create('res.partner', values);
    return { partnerId, created: true };
  }

  /** Find an existing sales order with the same client order reference. */
  async findSaleOrderByReference(reference: string): Promise<number | null> {
    const found = await this.client.searchRead<{ id: number }>(
      'sale.order',
      [['client_order_ref', '=', reference]],
      ['id'],
      { limit: 1 },
    );
    return found[0]?.id ?? null;
  }

  async createSaleOrder(payload: Record<string, unknown>): Promise<number> {
    return this.client.create('sale.order', payload);
  }

  async confirmSaleOrder(saleOrderId: number): Promise<void> {
    await this.client.call('sale.order', 'action_confirm', [[saleOrderId]]);
  }

  /** Read the stock pickings that were generated for the sales order. */
  async fetchPickings(saleOrderId: number): Promise<PickingRecord[]> {
    try {
      const pickings = await this.client.searchRead<{
        id: number;
        name?: string;
        state?: string;
        scheduled_date?: string;
        origin?: string;
      }>(
        'stock.picking',
        [['sale_id', '=', saleOrderId]],
        ['id', 'name', 'state', 'scheduled_date', 'origin'],
        { limit: 50 },
      );
      return pickings.map((picking) => ({
        odooPickingId: picking.id,
        name: picking.name,
        state: picking.state,
        scheduledDate: picking.scheduled_date,
        origin: picking.origin,
      }));
    } catch {
      // The Inventory application may not be installed on the target database.
      return [];
    }
  }

  /**
   * Upload a DMF (data migration file) through Odoo's `base_import` module.
   * Returns `null` when the module is not available so that the caller can
   * fall back to a manual / ETL upload.
   */
  async uploadImportFile(
    base64Content: string,
    model: string,
  ): Promise<{ imported: boolean; detail: unknown }> {
    try {
      const importIds = await this.client.call<number[]>('base_import.import', 'search', [
        [['base', '=', model]],
        ['id'],
      ]);
      if (!importIds?.length) return { imported: false, detail: 'no base_import record found' };

      await this.client.call('base_import.import', 'write', [
        importIds,
        { file: base64Content, base: model },
      ]);

      for (const method of ['load', 'dry_run']) {
        try {
          await this.client.call('base_import.import', method, [importIds]);
          break;
        } catch {
          continue;
        }
      }

      for (const method of ['commit', 'import']) {
        try {
          await this.client.call('base_import.import', method, [importIds]);
          return { imported: true, detail: { method, importIds } };
        } catch {
          continue;
        }
      }
      return { imported: false, detail: 'base_import did not expose a commit method' };
    } catch (error) {
      return { imported: false, detail: (error as Error).message };
    }
  }
}
