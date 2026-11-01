/**
 * Builds the Odoo `sale.order` payload from the central order tables.
 *
 * Two pricing strategies are supported per line:
 *  1. `percentage` - Odoo's native `discount` field is used with the list
 *     price.  Preferred because the discount stays visible in Odoo.
 *  2. `net-price`  - the discounted unit price is written directly.  Used
 *     when a percentage discount cannot reproduce the Shopify amount exactly
 *     (for example after a rounding adjustment).
 *
 * In both cases the sum of the lines is reconciled against the Shopify net
 * total so the sales order in Odoo carries the same money as the shop order.
 */
import { allocateProportionally, fromMinor, roundHalfAway, toMinor } from './money.js';
import type { StoredHead, StoredLine } from './types.js';

export interface ResolvedProduct {
  productId: number;
  uomId?: number;
  defaultCode?: string;
  name?: string;
}

export interface ResolvedTax {
  taxId: number;
  name: string;
  percentage?: number;
}

export interface OdooBuildOptions {
  partnerId: number;
  companyId?: number;
  warehouseId?: number;
  pricelistId?: number;
  paymentTermId?: number;
  currencyId?: number;
  /** Include the `x_shopify_*` custom fields (requires the Odoo addon). */
  includeCustomFields: boolean;
  /** Resolve the Odoo product for a line, or null when unmapped. */
  resolveProduct: (line: StoredLine) => ResolvedProduct | null;
  /** Resolve the Odoo tax for a title/percentage pair, or null when unmapped. */
  resolveTax: (title: string, percentage: number) => ResolvedTax | null;
  /** Tax applied to the shipping line. */
  resolveShippingTax?: (title: string, percentage: number) => ResolvedTax | null;
  /** Tax used when a Shopify tax title has no Odoo mapping. */
  fallbackTaxId?: number;
}

export interface BuiltLine {
  lineNo: number;
  productId?: number;
  uomId?: number;
  /** Unit price written to Odoo (major units). */
  priceUnit: number;
  /** Percentage discount written to Odoo. */
  discountPct: number;
  pricingMethod: 'percentage' | 'net-price';
  netTotal: number;
  taxTotal: number;
  warnings: string[];
}

export interface OdooBuildResult {
  payload: Record<string, unknown>;
  lines: BuiltLine[];
  warnings: string[];
  totals: {
    net: number;
    tax: number;
    grand: number;
  };
}

function odooDateTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

function odooDate(value: string | undefined): string | undefined {
  const dateTime = odooDateTime(value);
  return dateTime ? dateTime.slice(0, 10) : undefined;
}

/**
 * Compute the unit price and discount percentage for every line and
 * reconcile the result against the expected net total.
 */
export function resolvePricing(
  lines: StoredLine[],
  currency: string,
): { built: BuiltLine[]; warnings: string[]; netTotal: number } {
  const warnings: string[] = [];
  const built: BuiltLine[] = [];

  /** The extended (quantity multiplied) net price of a line, in minor units. */
  const extendedNet = (entry: BuiltLine, line: StoredLine): number => {
    const unitMinor = toMinor(entry.priceUnit, currency);
    if (entry.discountPct === 0) return roundHalfAway(unitMinor * line.quantity);
    return roundHalfAway(unitMinor * (1 - entry.discountPct / 100) * line.quantity);
  };

  for (const line of lines) {
    const quantity = line.quantity || 0;
    const listMinor = line.listPrice;
    const netMinor = line.netTotal;

    let priceUnitMinor = 0;
    let discountPct = 0;
    let method: 'percentage' | 'net-price' = 'net-price';

    if (listMinor > 0 && quantity > 0) {
      const pct = ((listMinor * quantity - netMinor) / (listMinor * quantity)) * 100;
      const candidate = roundHalfAway(pct * 100) / 100;
      const reproduced = toMinor(
        Number(fromMinor(listMinor, currency)) * (1 - candidate / 100) * quantity,
        currency,
      );
      if (Math.abs(reproduced - netMinor) <= 1) {
        method = 'percentage';
        discountPct = candidate;
        priceUnitMinor = listMinor;
      }
    }

    if (method === 'net-price') {
      priceUnitMinor = quantity > 0 ? roundHalfAway(line.netTotal / quantity) : line.netPrice;
    }

    built.push({
      lineNo: line.lineNo,
      productId: line.odooProductId,
      priceUnit: Number(fromMinor(priceUnitMinor, currency)),
      discountPct,
      pricingMethod: method,
      netTotal: line.netTotal,
      taxTotal: line.taxTotal,
      warnings: [],
    });
  }

  // Reconcile: the sum of the extended prices must match the Shopify net total.
  const expected = lines.reduce((sum, line) => sum + line.netTotal, 0);
  let computed = built.reduce((sum, entry, index) => sum + extendedNet(entry, lines[index]!), 0);
  const residual = expected - computed;

  if (residual !== 0) {
    // Prefer lines that already use the net price so that the discount stays
    // visible on the other lines.
    const candidates = built
      .map((entry, index) => ({ entry, line: lines[index]! }))
      .filter(
        ({ entry, line }) =>
          entry.discountPct === 0 && Number.isInteger(line.quantity) && line.quantity > 0,
      );

    if (candidates.length === 0 && built.length > 0) {
      // Every line uses a percentage discount: convert the last one to the
      // net price so that the rounding difference can be applied.
      const lastIndex = built.length - 1;
      const lastLine = lines[lastIndex]!;
      built[lastIndex]!.discountPct = 0;
      built[lastIndex]!.pricingMethod = 'net-price';
      built[lastIndex]!.priceUnit = Number(
        fromMinor(
          lastLine.quantity > 0
            ? roundHalfAway(lastLine.netTotal / lastLine.quantity)
            : lastLine.netPrice,
          currency,
        ),
      );
      computed = built.reduce((sum, entry, index) => sum + extendedNet(entry, lines[index]!), 0);
    }

    const remaining = expected - computed;
    if (remaining !== 0) {
      const adjustable = built
        .map((entry, index) => ({ entry, line: lines[index]! }))
        .filter(
          ({ entry, line }) =>
            entry.discountPct === 0 && Number.isInteger(line.quantity) && line.quantity > 0,
        );
      const shares = allocateProportionally(
        remaining,
        adjustable.map(({ line }) => line.quantity),
      );
      adjustable.forEach(({ entry, line }, index) => {
        const share = shares[index] ?? 0;
        if (share === 0) return;
        const perUnit = share / line.quantity;
        if (!Number.isInteger(perUnit)) {
          warnings.push(
            `Line ${entry.lineNo}: the ${share} rounding adjustment could not be applied to a fractional quantity`,
          );
          return;
        }
        entry.priceUnit = Number(
          fromMinor(toMinor(entry.priceUnit, currency) + perUnit, currency),
        );
      });
    }
  }

  return { built, warnings, netTotal: expected };
}

/**
 * Build the complete `sale.order` create payload.
 */
export function buildSaleOrderPayload(
  head: StoredHead,
  lines: StoredLine[],
  options: OdooBuildOptions,
): OdooBuildResult {
  const warnings: string[] = [];
  const { built, warnings: pricingWarnings, netTotal } = resolvePricing(lines, head.currency);
  warnings.push(...pricingWarnings);

  const orderLines: unknown[][] = [];
  const mappedLines: BuiltLine[] = [];

  for (const [index, line] of lines.entries()) {
    const entry = built[index]!;
    const product = options.resolveProduct(line);
    if (!product) {
      warnings.push(
        `Line ${line.lineNo} (${line.productName}) is not mapped to an Odoo product - it will be published as a free-text line`,
      );
    }

    const taxIds = new Set<number>();
    for (const tax of line.taxLines ?? []) {
      const resolved = options.resolveTax(tax.title, tax.percentage);
      if (resolved) taxIds.add(resolved.taxId);
      else warnings.push(`Line ${line.lineNo}: tax "${tax.title}" is not mapped to an Odoo tax`);
    }

    const values: Record<string, unknown> = {
      name: line.description ?? line.productName,
      product_uom_qty: line.quantity,
      price_unit: entry.priceUnit,
      discount: entry.discountPct,
      sequence: (line.lineNo + 1) * 10,
    };
    if (product) {
      values.product_id = product.productId;
      if (product.uomId) values.product_uom = product.uomId;
    }
    if (taxIds.size > 0) values.tax_id = [[6, 0, [...taxIds]]];
    else if (options.fallbackTaxId) {
      values.tax_id = [[6, 0, [options.fallbackTaxId]]];
    }
    if (line.discountCodes.length > 0) {
      values.name = `${values.name} [Shopify discount: ${line.discountCodes.join(', ')}]`;
    }

    orderLines.push([0, 0, values]);
    mappedLines.push({ ...entry, productId: product?.productId, uomId: product?.uomId });
  }

  const payload: Record<string, unknown> = {
    partner_id: options.partnerId,
    order_line: orderLines,
  };

  const reference = head.sourceOrderName ?? head.sourceOrderNumber ?? head.sourceOrderId;
  payload.client_order_ref = reference;

  const dateOrder = odooDateTime(head.sourceCreatedAt);
  if (dateOrder) payload.date_order = dateOrder;

  if (options.companyId) payload.company_id = options.companyId;
  if (options.warehouseId) payload.warehouse_id = options.warehouseId;
  if (options.pricelistId) payload.pricelist_id = options.pricelistId;
  if (options.paymentTermId) payload.payment_term_id = options.paymentTermId;
  if (options.currencyId) payload.currency_id = options.currencyId;

  const noteParts: string[] = [];
  if (head.note) noteParts.push(head.note);
  noteParts.push(
    `Imported from Shopify order ${reference} (source id ${head.sourceOrderId}) via shopifytoodoo.`,
  );
  if (head.paymentGateway) noteParts.push(`Payment gateway: ${head.paymentGateway}.`);
  if (head.financialStatus) noteParts.push(`Financial status: ${head.financialStatus}.`);
  if (head.customerEmail) noteParts.push(`Customer: ${head.customerEmail}.`);
  payload.client_order_note = noteParts.join(' ');

  if (options.includeCustomFields) {
    payload.x_shopify_order_id = head.sourceOrderId;
    payload.x_shopify_order_number = head.sourceOrderNumber ?? head.sourceOrderName ?? '';
    payload.x_shopify_source = head.source;
    payload.x_shopify_currency = head.currency;
    payload.x_shopify_total = head.total;
  }

  const taxTotal = lines.reduce((sum, line) => sum + line.taxTotal, 0);

  return {
    payload,
    lines: mappedLines,
    warnings,
    totals: {
      net: netTotal,
      tax: taxTotal,
      grand: netTotal + taxTotal,
    },
  };
}

export { odooDate, odooDateTime };
