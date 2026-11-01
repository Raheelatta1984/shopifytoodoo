/**
 * Persistence for the central order tables.
 *
 * Re-ingesting the same Shopify order is idempotent: the head row is updated
 * in place and the child rows are replaced, so a re-run never duplicates
 * lines, discounts or transactions.
 */
import { fromMinor, toMinor } from '../domain/money.js';
import type {
  CanonicalDiscount,
  CanonicalFulfillment,
  CanonicalOrder,
  CanonicalTaxLine,
  CanonicalTransaction,
  StoredHead,
  StoredLine,
} from '../domain/types.js';
import { json, num, type Db } from '../db/types.js';

export interface ValidationResultRecord {
  ruleCode: string;
  severity: 'blocking' | 'warning' | 'info';
  passed: boolean;
  message: string;
  detail?: unknown;
}

export interface PublishAttemptRecord {
  id: string;
  headId: string;
  method: string;
  status: string;
  odooSaleOrderId?: number;
  request?: unknown;
  response?: unknown;
  error?: string;
  createdAt: string;
}

export interface ArtifactRecord {
  id: string;
  headId: string;
  kind: string;
  filename: string;
  mimeType: string;
  content: string;
  checksum?: string;
  createdAt: string;
}

export interface HeadPatch {
  status?: string | null;
  validationStatus?: string | null;
  approvalStatus?: string | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
  approvalComment?: string | null;
  rejectedReason?: string | null;
  odooSaleOrderId?: number | null;
  odooPartnerId?: number | null;
}

export interface HeadFilter {
  status?: string;
  validationStatus?: string;
  approvalStatus?: string;
  sourceOrderId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export class OrderRepository {
  constructor(private readonly db: Db) {}

  /**
   * Insert or update the sales order head and all of its child rows.
   */
  async upsertOrder(order: CanonicalOrder): Promise<{ id: string; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const existing = await tx.query<{ id: string }>(
        'SELECT id FROM sales_order_head WHERE source = $1 AND source_order_id = $2',
        [order.source, order.sourceOrderId],
      );

      const headId = existing.rows[0]?.id ?? (await this.insertHead(tx, order));
      const created = existing.rows.length === 0;

      if (!created) {
        await tx.query(
          `UPDATE sales_order_head SET
             source_order_gid = $2, source_order_name = $3, source_order_number = $4,
             channel = $5, currency = $6, subtotal = $7, discount_total = $8, tax_total = $9,
             shipping_total = $10, shipping_discount_total = $11, total = $12,
             total_paid = $13, total_refunded = $14, outstanding = $15,
             payment_gateway = $16, financial_status = $17, fulfillment_status = $18,
             customer_ref = $19, customer_email = $20, customer_name = $21, customer_phone = $22,
             billing_address = $23, shipping_address = $24, tax_lines = $25, shipping_lines = $26,
             order_tags = $27, note = $28, source_created_at = $29, source_updated_at = $30,
             source_processed_at = $31, raw = $32, source_discount_total = $33, updated_at = now()
           WHERE id = $1`,
          [
            headId,
            order.sourceOrderGid ?? null,
            order.name ?? null,
            order.number ?? null,
            order.channel ?? null,
            order.currency,
            fromMinor(order.subtotal, order.currency),
            fromMinor(order.discountTotal, order.currency),
            fromMinor(order.taxTotal, order.currency),
            fromMinor(order.shippingTotal, order.currency),
            fromMinor(order.shippingDiscountTotal, order.currency),
            fromMinor(order.total, order.currency),
            fromMinor(order.paid, order.currency),
            fromMinor(order.refunded, order.currency),
            fromMinor(order.outstanding, order.currency),
            order.paymentGateway ?? null,
            order.financialStatus ?? null,
            order.fulfillmentStatus ?? null,
            order.customer?.id ?? null,
            order.customer?.email ?? null,
            customerName(order),
            order.customer?.phone ?? null,
            JSON.stringify(order.billingAddress ?? null),
            JSON.stringify(order.shippingAddress ?? null),
            JSON.stringify(order.taxLines ?? []),
            JSON.stringify(order.shippingLines ?? []),
            order.tags.join(','),
            order.note ?? null,
            order.createdAt ?? null,
            order.updatedAt ?? null,
            order.processedAt ?? null,
            JSON.stringify(order.raw ?? null),
            fromMinor(order.reportedDiscountTotal, order.currency),
          ],
        );
      }

      await this.replaceChildren(tx, headId, order);
      return { id: headId, created };
    });
  }

  private async insertHead(tx: Db, order: CanonicalOrder): Promise<string> {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO sales_order_head (
         source, source_order_id, source_order_gid, source_order_name, source_order_number,
         channel, currency, subtotal, discount_total, tax_total, shipping_total,
         shipping_discount_total, total, total_paid, total_refunded, outstanding,
         payment_gateway, financial_status, fulfillment_status,
         customer_ref, customer_email, customer_name, customer_phone,
         billing_address, shipping_address, tax_lines, shipping_lines, order_tags, note,
         source_created_at, source_updated_at, source_processed_at, raw, source_discount_total
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
         $24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34
       ) RETURNING id`,
      [
        order.source,
        order.sourceOrderId,
        order.sourceOrderGid ?? null,
        order.name ?? null,
        order.number ?? null,
        order.channel ?? null,
        order.currency,
        fromMinor(order.subtotal, order.currency),
        fromMinor(order.discountTotal, order.currency),
        fromMinor(order.taxTotal, order.currency),
        fromMinor(order.shippingTotal, order.currency),
        fromMinor(order.shippingDiscountTotal, order.currency),
        fromMinor(order.total, order.currency),
        fromMinor(order.paid, order.currency),
        fromMinor(order.refunded, order.currency),
        fromMinor(order.outstanding, order.currency),
        order.paymentGateway ?? null,
        order.financialStatus ?? null,
        order.fulfillmentStatus ?? null,
        order.customer?.id ?? null,
        order.customer?.email ?? null,
        customerName(order),
        order.customer?.phone ?? null,
        JSON.stringify(order.billingAddress ?? null),
        JSON.stringify(order.shippingAddress ?? null),
        JSON.stringify(order.taxLines ?? []),
        JSON.stringify(order.shippingLines ?? []),
        order.tags.join(','),
        order.note ?? null,
        order.createdAt ?? null,
        order.updatedAt ?? null,
        order.processedAt ?? null,
        JSON.stringify(order.raw ?? null),
        fromMinor(order.reportedDiscountTotal, order.currency),
      ],
    );
    return rows[0]!.id;
  }

  private async replaceChildren(tx: Db, headId: string, order: CanonicalOrder): Promise<void> {
    await tx.query('DELETE FROM sales_order_line_discount WHERE head_id = $1', [headId]);
    await tx.query('DELETE FROM sales_order_line WHERE head_id = $1', [headId]);
    await tx.query('DELETE FROM sales_order_discount WHERE head_id = $1', [headId]);
    await tx.query('DELETE FROM sales_order_transaction WHERE head_id = $1', [headId]);
    await tx.query('DELETE FROM sales_order_fulfillment WHERE head_id = $1', [headId]);

    for (const [index, line] of order.lines.entries()) {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO sales_order_line (
           head_id, line_no, source_line_id, source_product_id, source_variant_id, sku,
           product_name, variant_title, description, uom, quantity, list_price, discount_total,
           tax_total, net_price, line_subtotal, line_total, discount_codes, tax_lines
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         RETURNING id`,
        [
          headId,
          index + 1,
          line.sourceLineId ?? null,
          line.productId ?? null,
          line.productVariantId ?? null,
          line.sku ?? null,
          line.name,
          line.variantTitle ?? null,
          line.note ?? null,
          line.uom,
          line.quantity,
          fromMinor(line.listPrice, order.currency),
          fromMinor(line.discountTotal, order.currency),
          fromMinor(line.taxTotal, order.currency),
          fromMinor(line.netPrice, order.currency),
          fromMinor(line.originalTotal, order.currency),
          fromMinor(line.lineTotal, order.currency),
          [...new Set(line.allocations.map((allocation) => allocation.code).filter(Boolean))].join(','),
          JSON.stringify(line.taxLines ?? []),
        ],
      );
      const lineId = rows[0]!.id;

      for (const allocation of line.allocations) {
        await tx.query(
          `INSERT INTO sales_order_line_discount (head_id, line_id, code, title, allocation_method, amount)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            headId,
            lineId,
            allocation.code ?? null,
            allocation.title ?? null,
            allocation.allocationMethod ?? null,
            fromMinor(allocation.amount, order.currency),
          ],
        );
      }
    }

    for (const discount of order.discounts) {
      await this.insertDiscount(tx, headId, discount, order.currency);
    }

    for (const transaction of order.transactions) {
      await this.insertTransaction(tx, headId, transaction, order.currency);
    }

    for (const fulfillment of order.fulfillments) {
      await this.insertFulfillment(tx, headId, fulfillment);
    }
  }

  private async insertDiscount(
    tx: Db,
    headId: string,
    discount: CanonicalDiscount,
    currency: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO sales_order_discount (
         head_id, source_discount_id, code, title, description, allocation_method, target_type,
         value_type, value_amount, value_percentage, amount, scope
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        headId,
        discount.sourceDiscountId ?? null,
        discount.code ?? null,
        discount.title,
        discount.description ?? null,
        discount.allocationMethod ?? null,
        discount.targetType ?? null,
        discount.valueType,
        discount.valueAmount !== undefined ? fromMinor(discount.valueAmount, currency) : null,
        discount.valuePercentage ?? null,
        fromMinor(discount.amount, currency),
        discount.scope,
      ],
    );
  }

  private async insertTransaction(
    tx: Db,
    headId: string,
    transaction: CanonicalTransaction,
    currency: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO sales_order_transaction (
         head_id, source_transaction_id, parent_transaction_id, kind, status, gateway,
         amount, currency, processed_at, error_message, raw
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (head_id, source_transaction_id) DO NOTHING`,
      [
        headId,
        transaction.sourceTransactionId,
        transaction.parentTransactionId ?? null,
        transaction.kind,
        transaction.status ?? null,
        transaction.gateway ?? null,
        fromMinor(transaction.amount, currency),
        transaction.currency ?? currency,
        transaction.processedAt ?? null,
        transaction.errorMessage ?? null,
        JSON.stringify(transaction),
      ],
    );
  }

  private async insertFulfillment(
    tx: Db,
    headId: string,
    fulfillment: CanonicalFulfillment,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO sales_order_fulfillment (
         head_id, source_fulfillment_id, status, tracking_numbers, tracking_urls, source_created_at, raw
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (head_id, source_fulfillment_id) DO NOTHING`,
      [
        headId,
        fulfillment.sourceFulfillmentId,
        fulfillment.status ?? null,
        fulfillment.trackingNumbers.join(','),
        fulfillment.trackingUrls.join(','),
        fulfillment.createdAt ?? null,
        JSON.stringify(fulfillment),
      ],
    );
  }

  // ------------------------------------------------------------- readers --
  async getHead(id: string): Promise<StoredHead | null> {
    const { rows } = await this.db.query('SELECT * FROM sales_order_head WHERE id = $1', [id]);
    const row = rows[0];
    return row ? mapHead(row) : null;
  }

  async getHeadBySource(source: string, sourceOrderId: string): Promise<StoredHead | null> {
    const { rows } = await this.db.query(
      'SELECT * FROM sales_order_head WHERE source = $1 AND source_order_id = $2',
      [source, sourceOrderId],
    );
    const row = rows[0];
    return row ? mapHead(row) : null;
  }

  async listHeads(filter: HeadFilter = {}): Promise<{ items: StoredHead[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const push = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (filter.status) conditions.push(`status = ${push(filter.status)}`);
    if (filter.validationStatus) {
      conditions.push(`validation_status = ${push(filter.validationStatus)}`);
    }
    if (filter.approvalStatus) {
      conditions.push(`approval_status = ${push(filter.approvalStatus)}`);
    }
    if (filter.sourceOrderId) {
      conditions.push(`source_order_id = ${push(filter.sourceOrderId)}`);
    }
    if (filter.search) {
      const placeholder = push(`%${filter.search}%`);
      conditions.push(
        `(source_order_id ILIKE ${placeholder} OR source_order_name ILIKE ${placeholder} OR customer_email ILIKE ${placeholder})`,
      );
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);
    const limitParam = push(limit);
    const offsetParam = push(offset);

    const { rows } = await this.db.query(
      `SELECT * FROM sales_order_head ${where} ORDER BY downloaded_at DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    );
    const countResult = await this.db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM sales_order_head ${where}`,
      params.slice(0, params.length - 2),
    );

    return {
      items: rows.map((row) => mapHead(row)),
      total: num(countResult.rows[0]?.count, rows.length),
    };
  }

  async getLines(headId: string, currency = 'USD'): Promise<StoredLine[]> {
    const { rows } = await this.db.query(
      'SELECT * FROM sales_order_line WHERE head_id = $1 ORDER BY line_no',
      [headId],
    );
    return rows.map((row) => mapLine(row, currency));
  }

  async getDiscounts(headId: string, currency = 'USD'): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query(
      'SELECT * FROM sales_order_discount WHERE head_id = $1 ORDER BY id',
      [headId],
    );
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      title: row.title,
      description: row.description,
      allocationMethod: row.allocation_method,
      targetType: row.target_type,
      valueType: row.value_type,
      valueAmount: row.value_amount !== null ? toMinor(row.value_amount, currency) : undefined,
      valuePercentage: row.value_percentage !== null ? num(row.value_percentage) : undefined,
      amount: toMinor(row.amount, currency),
      scope: row.scope,
    }));
  }

  async getLineDiscounts(headId: string, currency = 'USD'): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query(
      `SELECT ld.*, sl.line_no FROM sales_order_line_discount ld
       JOIN sales_order_line sl ON sl.id = ld.line_id
       WHERE ld.head_id = $1 ORDER BY sl.line_no, ld.id`,
      [headId],
    );
    return rows.map((row) => ({
      lineNo: num(row.line_no),
      code: row.code,
      title: row.title,
      allocationMethod: row.allocation_method,
      amount: toMinor(row.amount, currency),
    }));
  }

  async getTransactions(headId: string, currency = 'USD'): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query(
      'SELECT * FROM sales_order_transaction WHERE head_id = $1 ORDER BY id',
      [headId],
    );
    return rows.map((row) => ({
      id: row.id,
      sourceTransactionId: row.source_transaction_id,
      parentTransactionId: row.parent_transaction_id,
      kind: row.kind,
      status: row.status,
      gateway: row.gateway,
      amount: toMinor(row.amount, currency),
      currency: row.currency,
      processedAt: row.processed_at,
      errorMessage: row.error_message,
    }));
  }

  async getFulfillments(headId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query(
      'SELECT * FROM sales_order_fulfillment WHERE head_id = $1 ORDER BY id',
      [headId],
    );
    return rows.map((row) => ({
      sourceFulfillmentId: row.source_fulfillment_id,
      status: row.status,
      trackingNumbers: String(row.tracking_numbers ?? '')
        .split(',')
        .filter(Boolean),
      trackingUrls: String(row.tracking_urls ?? '')
        .split(',')
        .filter(Boolean),
      sourceCreatedAt: row.source_created_at,
    }));
  }

  async getValidations(headId: string): Promise<ValidationResultRecord[]> {
    const { rows } = await this.db.query(
      'SELECT * FROM sales_order_validation WHERE head_id = $1 ORDER BY checked_at DESC, rule_code',
      [headId],
    );
    return rows.map((row) => ({
      ruleCode: String(row.rule_code),
      severity: String(row.severity) as ValidationResultRecord['severity'],
      passed: Boolean(row.passed),
      message: String(row.message ?? ''),
      detail: json(row.detail, undefined),
    }));
  }

  async getPickings(headId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query(
      'SELECT * FROM sales_order_picking WHERE head_id = $1 ORDER BY id',
      [headId],
    );
    return rows.map((row) => ({
      id: row.id,
      odooPickingId: row.odoo_picking_id,
      name: row.name,
      state: row.state,
      scheduledDate: row.scheduled_date,
      origin: row.origin,
    }));
  }

  async getPublishAttempts(headId: string): Promise<PublishAttemptRecord[]> {
    const { rows } = await this.db.query(
      'SELECT * FROM publish_attempt WHERE head_id = $1 ORDER BY created_at DESC',
      [headId],
    );
    return rows.map((row) => ({
      id: String(row.id),
      headId: String(row.head_id),
      method: String(row.method),
      status: String(row.status),
      odooSaleOrderId:
        row.odoo_sale_order_id === null || row.odoo_sale_order_id === undefined
          ? undefined
          : num(row.odoo_sale_order_id),
      request: json(row.request, undefined),
      response: json(row.response, undefined),
      error: row.error ? String(row.error) : undefined,
      createdAt: String(row.created_at),
    }));
  }

  async getArtifacts(headId: string): Promise<ArtifactRecord[]> {
    const { rows } = await this.db.query(
      'SELECT * FROM publish_artifact WHERE head_id = $1 ORDER BY created_at',
      [headId],
    );
    return rows.map((row) => ({
      id: String(row.id),
      headId: String(row.head_id),
      kind: String(row.kind),
      filename: String(row.filename),
      mimeType: String(row.mime_type),
      content: String(row.content),
      checksum: row.checksum ? String(row.checksum) : undefined,
      createdAt: String(row.created_at),
    }));
  }

  // ------------------------------------------------------------- writers --
  async updateHead(headId: string, patch: HeadPatch): Promise<void> {
    const fields: string[] = [];
    const params: unknown[] = [];
    const push = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    const columns: Record<keyof HeadPatch, string> = {
      status: 'status',
      validationStatus: 'validation_status',
      approvalStatus: 'approval_status',
      approvedBy: 'approved_by',
      approvedAt: 'approved_at',
      approvalComment: 'approval_comment',
      rejectedReason: 'rejected_reason',
      odooSaleOrderId: 'odoo_sale_order_id',
      odooPartnerId: 'odoo_partner_id',
    };

    for (const key of Object.keys(columns) as (keyof HeadPatch)[]) {
      const value = patch[key];
      if (value === undefined) continue;
      fields.push(`${columns[key]} = ${push(value)}`);
    }
    if (fields.length === 0) return;

    params.push(headId);
    await this.db.query(
      `UPDATE sales_order_head SET ${fields.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
      params,
    );
  }

  async replaceValidations(headId: string, results: ValidationResultRecord[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('DELETE FROM sales_order_validation WHERE head_id = $1', [headId]);
      for (const result of results) {
        await tx.query(
          `INSERT INTO sales_order_validation (head_id, rule_code, severity, passed, message, detail)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            headId,
            result.ruleCode,
            result.severity,
            result.passed,
            result.message,
            JSON.stringify(result.detail ?? null),
          ],
        );
      }
    });
  }

  async insertPublishAttempt(
    headId: string,
    attempt: {
      method: string;
      status: string;
      odooSaleOrderId?: number;
      request?: unknown;
      response?: unknown;
      error?: string;
    },
  ): Promise<PublishAttemptRecord> {
    const { rows } = await this.db.query<{
      id: string;
      created_at: string;
    }>(
      `INSERT INTO publish_attempt (head_id, method, status, odoo_sale_order_id, request, response, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
      [
        headId,
        attempt.method,
        attempt.status,
        attempt.odooSaleOrderId ?? null,
        JSON.stringify(attempt.request ?? null),
        JSON.stringify(attempt.response ?? null),
        attempt.error ?? null,
      ],
    );
    return {
      id: String(rows[0]!.id),
      headId,
      method: attempt.method,
      status: attempt.status,
      odooSaleOrderId: attempt.odooSaleOrderId,
      request: attempt.request,
      response: attempt.response,
      error: attempt.error,
      createdAt: String(rows[0]!.created_at),
    };
  }

  async insertArtifacts(headId: string, artifacts: ArtifactRecord[]): Promise<void> {
    for (const artifact of artifacts) {
      await this.db.query(
        `INSERT INTO publish_artifact (head_id, kind, filename, mime_type, content, checksum)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          headId,
          artifact.kind,
          artifact.filename,
          artifact.mimeType,
          artifact.content,
          artifact.checksum ?? null,
        ],
      );
    }
  }

  async replacePickings(
    headId: string,
    pickings: { odooPickingId?: number; name?: string; state?: string; scheduledDate?: string; origin?: string }[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('DELETE FROM sales_order_picking WHERE head_id = $1', [headId]);
      for (const picking of pickings) {
        await tx.query(
          `INSERT INTO sales_order_picking (head_id, odoo_picking_id, name, state, scheduled_date, origin)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            headId,
            picking.odooPickingId ?? null,
            picking.name ?? null,
            picking.state ?? null,
            picking.scheduledDate ?? null,
            picking.origin ?? null,
          ],
        );
      }
    });
  }

  /** Persist the Odoo product resolved for a line. */
  async setLineProduct(lineId: string, odooProductId: number | null): Promise<void> {
    await this.db.query(
      'UPDATE sales_order_line SET odoo_product_id = $2, updated_at = now() WHERE id = $1',
      [lineId, odooProductId],
    );
  }

  /** Persist the tax breakdown of a line, including the resolved Odoo tax ids. */
  async setLineTaxes(lineId: string, taxLines: unknown): Promise<void> {
    await this.db.query(
      'UPDATE sales_order_line SET tax_lines = $2, updated_at = now() WHERE id = $1',
      [lineId, JSON.stringify(taxLines)],
    );
  }

  async countBySource(source: string, sourceOrderId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM sales_order_head WHERE source = $1 AND source_order_id = $2',
      [source, sourceOrderId],
    );
    return num(rows[0]?.count, 0);
  }
}

function customerName(order: CanonicalOrder): string | null {
  const full = [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ');
  return full || order.customer?.email || null;
}

function iso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function mapHead(row: Record<string, unknown>): StoredHead {
  const currency = String(row.currency ?? 'USD');
  return {
    id: String(row.id),
    source: String(row.source),
    sourceOrderId: String(row.source_order_id),
    sourceOrderName: row.source_order_name ? String(row.source_order_name) : undefined,
    sourceOrderNumber: row.source_order_number ? String(row.source_order_number) : undefined,
    channel: row.channel ? String(row.channel) : undefined,
    status: String(row.status),
    validationStatus: String(row.validation_status),
    approvalStatus: String(row.approval_status),
    approvedBy: row.approved_by ? String(row.approved_by) : undefined,
    approvedAt: iso(row.approved_at),
    approvalComment: row.approval_comment ? String(row.approval_comment) : undefined,
    rejectedReason: row.rejected_reason ? String(row.rejected_reason) : undefined,
    currency,
    subtotal: toMinor(row.subtotal, currency),
    discountTotal: toMinor(row.discount_total, currency),
    reportedDiscountTotal: toMinor(row.source_discount_total, currency),
    taxTotal: toMinor(row.tax_total, currency),
    shippingTotal: toMinor(row.shipping_total, currency),
    shippingDiscountTotal: toMinor(row.shipping_discount_total, currency),
    total: toMinor(row.total, currency),
    paid: toMinor(row.total_paid, currency),
    refunded: toMinor(row.total_refunded, currency),
    outstanding: toMinor(row.outstanding, currency),
    paymentGateway: row.payment_gateway ? String(row.payment_gateway) : undefined,
    financialStatus: row.financial_status ? String(row.financial_status) : undefined,
    fulfillmentStatus: row.fulfillment_status ? String(row.fulfillment_status) : undefined,
    customerRef: row.customer_ref ? String(row.customer_ref) : undefined,
    customerEmail: row.customer_email ? String(row.customer_email) : undefined,
    customerName: row.customer_name ? String(row.customer_name) : undefined,
    customerPhone: row.customer_phone ? String(row.customer_phone) : undefined,
    billingAddress: json(row.billing_address, undefined),
    shippingAddress: json(row.shipping_address, undefined),
    taxLines: json<CanonicalTaxLine[]>(row.tax_lines, []),
    shippingLines: json(row.shipping_lines, []),
    tags: String(row.order_tags ?? '')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
    note: row.note ? String(row.note) : undefined,
    sourceCreatedAt: iso(row.source_created_at),
    downloadedAt: iso(row.downloaded_at),
    odooSaleOrderId: row.odoo_sale_order_id !== null && row.odoo_sale_order_id !== undefined
      ? num(row.odoo_sale_order_id)
      : undefined,
    odooPartnerId:
      row.odoo_partner_id !== null && row.odoo_partner_id !== undefined
        ? num(row.odoo_partner_id)
        : undefined,
  };
}

function mapLine(row: Record<string, unknown>, currency: string): StoredLine {
  return {
    id: String(row.id),
    lineNo: num(row.line_no, 0),
    sourceLineId: row.source_line_id ? String(row.source_line_id) : undefined,
    sourceVariantId: row.source_variant_id ? String(row.source_variant_id) : undefined,
    sku: row.sku ? String(row.sku) : undefined,
    productName: String(row.product_name ?? ''),
    variantTitle: row.variant_title ? String(row.variant_title) : undefined,
    description: row.description ? String(row.description) : undefined,
    quantity: num(row.quantity, 0),
    uom: String(row.uom ?? 'units'),
    listPrice: toMinor(row.list_price, currency),
    discountTotal: toMinor(row.discount_total, currency),
    taxTotal: toMinor(row.tax_total, currency),
    netPrice: toMinor(row.net_price, currency),
    lineSubtotal: toMinor(row.line_subtotal, currency),
    netTotal: toMinor(row.line_subtotal, currency) - toMinor(row.discount_total, currency),
    lineTotal: toMinor(row.line_total, currency),
    discountCodes: String(row.discount_codes ?? '')
      .split(',')
      .map((code) => code.trim())
      .filter(Boolean),
    taxLines: json<CanonicalTaxLine[]>(row.tax_lines, []),
    odooProductId:
      row.odoo_product_id !== null && row.odoo_product_id !== undefined
        ? num(row.odoo_product_id)
        : undefined,
    odooLineId:
      row.odoo_line_id !== null && row.odoo_line_id !== undefined
        ? num(row.odoo_line_id)
        : undefined,
  };
}
