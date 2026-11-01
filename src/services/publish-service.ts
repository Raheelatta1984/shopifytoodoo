/**
 * Publishing service.
 *
 * Takes a validated and approved central order and turns it into an Odoo
 * sales order through one of the three supported integration paths:
 *
 *  - `xmlrpc`  - Odoo XML-RPC external API (default),
 *  - `jsonrpc` - Odoo JSON-RPC external API,
 *  - `dmf`     - Data Migration File: import artefacts for Odoo's own import
 *                (optionally pushed through `base_import`).
 */
import { buildDmfArtifacts } from '../domain/dmf.js';
import { buildSaleOrderPayload, type ResolvedProduct, type ResolvedTax } from '../domain/odoo-mapper.js';
import type { CanonicalTaxLine, StoredHead, StoredLine } from '../domain/types.js';
import type { AuditRepository } from '../repositories/audit-repository.js';
import type { MappingRepository } from '../repositories/mapping-repository.js';
import type { OrderRepository } from '../repositories/order-repository.js';
import type { Settings, SettingsRepository } from '../repositories/settings-repository.js';
import type { Role } from '../repositories/user-repository.js';
import type { ApprovalService } from './approval-service.js';
import type { OdooGateway, PickingRecord } from './odoo-gateway.js';
import type { ValidationService } from './validation-service.js';

export type PublishMethod = 'xmlrpc' | 'jsonrpc' | 'dmf';

export interface PublishDeps {
  orders: OrderRepository;
  mappings: MappingRepository;
  settings: SettingsRepository;
  audit: AuditRepository;
  validation: ValidationService;
  approval: ApprovalService;
  defaultSettings: Settings;
  /** Creates a gateway for the live Odoo API (null when Odoo is not configured). */
  createGateway: (method: 'xmlrpc' | 'jsonrpc') => OdooGateway | null;
}

export interface PublishOptions {
  method: PublishMethod;
  actor: string;
  role: Role;
  ip?: string;
  comment?: string;
  /** Republish even when the order already has an Odoo id. */
  force?: boolean;
}

export interface PublishResult {
  status: 'published' | 'artifact_ready' | 'failed' | 'skipped';
  headId: string;
  method: PublishMethod;
  odooSaleOrderId?: number;
  partnerId?: number;
  warnings: string[];
  artifacts?: { kind: string; filename: string; mimeType: string; checksum: string }[];
  pickings?: PickingRecord[];
  error?: string;
}

export class PublishService {
  constructor(private readonly deps: PublishDeps) {}

  async publish(headId: string, options: PublishOptions): Promise<PublishResult> {
    const head = await this.deps.orders.getHead(headId);
    if (!head) {
      throw new Error(`Order ${headId} was not found`);
    }

    if (head.odooSaleOrderId && !options.force) {
      return {
        status: 'skipped',
        headId,
        method: options.method,
        odooSaleOrderId: head.odooSaleOrderId,
        warnings: [],
        error: 'The order has already been published to Odoo.',
      };
    }

    // 1. Re-run the validation rules so that nothing stale is published.
    const report = await this.deps.validation.validate(headId);
    if (report.status !== 'passed') {
      const error = `Validation failed: ${report.blockingFailures
        .map((failure) => `${failure.ruleCode} ${failure.message}`)
        .join('; ')}`;
      await this.deps.audit.record({
        actor: options.actor,
        role: options.role,
        action: 'order.publish',
        entity: 'sales_order_head',
        entityId: headId,
        result: 'failure',
        ip: options.ip,
        detail: { method: options.method, error },
      });
      return {
        status: 'failed',
        headId,
        method: options.method,
        warnings: [],
        error,
      };
    }

    // 2. Apply the approval threshold and check the approval state.
    await this.deps.approval.applyThreshold(headId);
    const refreshed = (await this.deps.orders.getHead(headId))!;
    const permission = await this.deps.approval.canPublish(refreshed);
    if (!permission.allowed) {
      await this.deps.audit.record({
        actor: options.actor,
        role: options.role,
        action: 'order.publish',
        entity: 'sales_order_head',
        entityId: headId,
        result: 'denied',
        ip: options.ip,
        detail: { method: options.method, reason: permission.reason },
      });
      return {
        status: 'failed',
        headId,
        method: options.method,
        warnings: [],
        error: permission.reason,
      };
    }

    const settings = await this.deps.settings.getAll(this.deps.defaultSettings);
    const lines = await this.deps.orders.getLines(headId, refreshed.currency);
    const warnings: string[] = [];

    // 3. Resolve the Odoo products and taxes for every line.
    const { lines: resolvedLines, resolveProduct, resolveTax } = await this.resolveMappings(
      lines,
      settings,
    );

    if (options.method === 'dmf') {
      return this.publishDmf(refreshed, resolvedLines, settings, options, warnings);
    }

    const gateway = this.deps.createGateway(options.method);
    if (!gateway) {
      return {
        status: 'failed',
        headId,
        method: options.method,
        warnings,
        error: 'No Odoo instance is configured (set ODOO_URL).',
      };
    }

    try {
      const partner = await gateway.resolvePartner(refreshed);
      const built = buildSaleOrderPayload(refreshed, resolvedLines, {
        partnerId: partner.partnerId,
        ...(settings.companyId ? { companyId: settings.companyId } : {}),
        ...(settings.warehouseId ? { warehouseId: settings.warehouseId } : {}),
        ...(settings.pricelistId ? { pricelistId: settings.pricelistId } : {}),
        ...(settings.paymentTermId ? { paymentTermId: settings.paymentTermId } : {}),
        ...(settings.currencyId ? { currencyId: settings.currencyId } : {}),
        includeCustomFields: settings.writeCustomFields !== false,
        resolveProduct,
        resolveTax,
        ...(settings.fallbackOdooTaxId ? { fallbackTaxId: settings.fallbackOdooTaxId } : {}),
      });
      warnings.push(...built.warnings);

      const reference = refreshed.sourceOrderName ?? refreshed.sourceOrderNumber ?? refreshed.sourceOrderId;
      const existing = await gateway.findSaleOrderByReference(reference);
      if (existing && !options.force) {
        await this.deps.orders.updateHead(headId, {
          odooSaleOrderId: existing,
          odooPartnerId: partner.partnerId,
          status: 'published',
        });
        await this.deps.orders.insertPublishAttempt(headId, {
          method: options.method,
          status: 'success',
          odooSaleOrderId: existing,
          response: { deduplicated: true, existingSaleOrderId: existing },
        });
        return {
          status: 'published',
          headId,
          method: options.method,
          odooSaleOrderId: existing,
          partnerId: partner.partnerId,
          warnings,
        };
      }

      let saleOrderId: number;
      try {
        saleOrderId = await gateway.createSaleOrder(built.payload);
      } catch (error) {
        // The custom fields are optional: retry without them when the target
        // database does not have the shopifytoodoo addon installed.
        const message = (error as Error).message;
        if (settings.writeCustomFields !== false && /x_shopify|Invalid field|unknown field/i.test(message)) {
          const retry = buildSaleOrderPayload(refreshed, resolvedLines, {
            partnerId: partner.partnerId,
            includeCustomFields: false,
            resolveProduct,
            resolveTax,
            ...(settings.fallbackOdooTaxId ? { fallbackTaxId: settings.fallbackOdooTaxId } : {}),
          });
          warnings.push(
            'The Odoo database does not know the x_shopify_* fields; the sales order was created without them.',
          );
          saleOrderId = await gateway.createSaleOrder(retry.payload);
        } else {
          throw error;
        }
      }

      let pickings: PickingRecord[] = [];
      if (settings.confirmSaleOrder !== false) {
        await gateway.confirmSaleOrder(saleOrderId);
        pickings = await gateway.fetchPickings(saleOrderId);
        if (pickings.length > 0) {
          await this.deps.orders.replacePickings(headId, pickings);
        }
      }

      await this.deps.orders.updateHead(headId, {
        odooSaleOrderId: saleOrderId,
        odooPartnerId: partner.partnerId,
        status: 'published',
      });
      await this.deps.orders.insertPublishAttempt(headId, {
        method: options.method,
        status: 'success',
        odooSaleOrderId: saleOrderId,
        request: built.payload,
        response: { saleOrderId, partnerId: partner.partnerId, warnings },
      });
      await this.deps.audit.record({
        actor: options.actor,
        role: options.role,
        action: 'order.publish',
        entity: 'sales_order_head',
        entityId: headId,
        result: 'success',
        ip: options.ip,
        detail: { method: options.method, saleOrderId, warnings },
      });

      return {
        status: 'published',
        headId,
        method: options.method,
        odooSaleOrderId: saleOrderId,
        partnerId: partner.partnerId,
        warnings,
        pickings,
      };
    } catch (error) {
      const message = (error as Error).message;
      await this.deps.orders.updateHead(headId, { status: 'failed' });
      await this.deps.orders.insertPublishAttempt(headId, {
        method: options.method,
        status: 'failed',
        error: message,
      });
      await this.deps.audit.record({
        actor: options.actor,
        role: options.role,
        action: 'order.publish',
        entity: 'sales_order_head',
        entityId: headId,
        result: 'failure',
        ip: options.ip,
        detail: { method: options.method, error: message },
      });
      return {
        status: 'failed',
        headId,
        method: options.method,
        warnings,
        error: message,
      };
    }
  }

  /** Generate the data migration files and (optionally) upload them to Odoo. */
  private async publishDmf(
    head: StoredHead,
    lines: StoredLine[],
    settings: Settings,
    options: PublishOptions,
    warnings: string[],
  ): Promise<PublishResult> {
    const bundle = buildDmfArtifacts(head, lines, {
      includePartnerRecord: true,
      includeCustomFields: settings.writeCustomFields !== false,
    });

    await this.deps.orders.insertArtifacts(
      head.id,
      bundle.artifacts.map((artifact) => ({
        id: '',
        headId: head.id,
        kind: artifact.kind,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        content: artifact.content,
        checksum: artifact.checksum,
        createdAt: new Date().toISOString(),
      })),
    );

    let uploaded = false;
    if (settings.dmfUploadEnabled) {
      const gateway = this.deps.createGateway('xmlrpc');
      if (gateway) {
        const csv = bundle.artifacts.find((artifact) => artifact.kind === 'sale-order-head');
        if (csv) {
          const result = await gateway.uploadImportFile(
            Buffer.from(csv.content, 'utf8').toString('base64'),
            'sale.order',
          );
          uploaded = result.imported;
          if (!result.imported) {
            warnings.push(
              `The DMF could not be uploaded automatically (${String(result.detail)}); the artefacts are available for a manual import.`,
            );
          }
        }
      }
    }

    await this.deps.orders.insertPublishAttempt(head.id, {
      method: 'dmf',
      status: uploaded ? 'success' : 'artifact_ready',
      request: { files: bundle.artifacts.map((artifact) => artifact.filename) },
      response: { uploaded, summary: bundle.summary },
    });
    await this.deps.audit.record({
      actor: options.actor,
      role: options.role,
      action: 'order.publish',
      entity: 'sales_order_head',
      entityId: head.id,
      result: 'success',
      ip: options.ip,
      detail: { method: 'dmf', uploaded, files: bundle.artifacts.length },
    });

    return {
      status: uploaded ? 'published' : 'artifact_ready',
      headId: head.id,
      method: 'dmf',
      warnings,
      artifacts: bundle.artifacts.map((artifact) => ({
        kind: artifact.kind,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        checksum: artifact.checksum,
      })),
    };
  }

  /** Resolve the Odoo product and tax for every line, persisting the results. */
  private async resolveMappings(
    lines: StoredLine[],
    settings: Settings,
  ): Promise<{
    lines: StoredLine[];
    resolveProduct: (line: StoredLine) => ResolvedProduct | null;
    resolveTax: (title: string, percentage: number) => ResolvedTax | null;
  }> {
    const productByLine = new Map<string, ResolvedProduct | null>();
    const taxByTitle = new Map<string, ResolvedTax | null>();

    for (const line of lines) {
      const mapping = await this.deps.mappings.findProduct({
        variantId: line.sourceVariantId ?? null,
        sku: line.sku ?? null,
      });
      let resolved: ResolvedProduct | null = null;
      if (mapping) {
        resolved = {
          productId: mapping.odooProductId,
          ...(mapping.odooUomId ? { uomId: mapping.odooUomId } : {}),
          ...(mapping.sku ? { defaultCode: mapping.sku } : {}),
        };
      } else if (settings.fallbackOdooProductId) {
        resolved = { productId: settings.fallbackOdooProductId };
      }
      productByLine.set(line.id, resolved);
      if (resolved) {
        await this.deps.orders.setLineProduct(line.id, resolved.productId);
        line.odooProductId = resolved.productId;
      }

      const taxes: CanonicalTaxLine[] = [];
      for (const tax of line.taxLines ?? []) {
        const taxMapping = await this.deps.mappings.findTax(tax.title);
        let resolvedTax: ResolvedTax | null = null;
        if (taxMapping) {
          resolvedTax = { taxId: taxMapping.odooTaxId, name: tax.title, percentage: tax.percentage };
        } else if (settings.fallbackOdooTaxId) {
          resolvedTax = { taxId: settings.fallbackOdooTaxId, name: tax.title, percentage: tax.percentage };
        }
        taxByTitle.set(tax.title, resolvedTax);
        taxes.push({ ...tax, ...(resolvedTax ? { odooTaxId: resolvedTax.taxId } : {}) });
      }
      if (taxes.length > 0) {
        await this.deps.orders.setLineTaxes(line.id, taxes);
        line.taxLines = taxes;
      }
    }

    return {
      lines,
      resolveProduct: (line) => productByLine.get(line.id) ?? null,
      resolveTax: (title) => taxByTitle.get(title) ?? null,
    };
  }
}
