/**
 * Data Migration File (DMF) generation.
 *
 * The DMF is the "file based" integration path: instead of calling the Odoo
 * external API, the solution produces import artefacts that Odoo (or any ETL
 * tool) can consume:
 *
 *  - `<ref>-sale-order.csv`      - head rows for the `sale.order` model
 *  - `<ref>-sale-order-line.csv` - line rows for the `sale.order.line` model
 *  - `<ref>-sale-order.xml`      - a self contained Odoo XML data file
 *  - `<ref>-manifest.json`       - provenance, checksums and field mapping
 *
 * The CSV column names follow Odoo's own import templates for Sales, so the
 * files can be uploaded through *Data > Import* without any custom work, while
 * the XML file can be loaded through *Settings > Technical > Import* or the
 * `base_import` service (see `dmf-uploader.ts`).
 */
import { createHash } from 'node:crypto';
import { fromMinor } from './money.js';
import { resolvePricing } from './odoo-mapper.js';
import type { StoredHead, StoredLine } from './types.js';

export interface DmfOptions {
  /** Create the `res.partner` record inside the XML file. */
  includePartnerRecord: boolean;
  /** Write the `x_shopify_*` custom fields (requires the Odoo addon). */
  includeCustomFields: boolean;
  paymentTermName?: string;
  warehouseName?: string;
}

export interface DmfArtifact {
  kind: string;
  filename: string;
  mimeType: string;
  content: string;
  checksum: string;
}

export interface DmfBundle {
  artifacts: DmfArtifact[];
  summary: {
    reference: string;
    lines: number;
    netTotal: number;
    taxTotal: number;
    grandTotal: number;
    currency: string;
  };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map((cell) => csvCell(cell)).join(',')).join('\r\n') + '\r\n';
}

function xmlEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Serialise a string as a Python string literal. */
export function pythonString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `'${escaped}'`;
}

/** Serialise a value as a Python literal (used inside Odoo `eval` fields). */
export function pythonLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === 'string') return pythonString(value);
  if (Array.isArray(value)) return `[${value.map((item) => pythonLiteral(item)).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${pythonLiteral(key)}: ${pythonLiteral(item)}`,
    );
    return `{${entries.join(', ')}}`;
  }
  return 'None';
}

function checksum(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function slug(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/**
 * Build every DMF artefact for a sales order.
 */
export function buildDmfArtifacts(
  head: StoredHead,
  lines: StoredLine[],
  options: DmfOptions,
): DmfBundle {
  const reference = head.sourceOrderName ?? head.sourceOrderNumber ?? head.sourceOrderId;
  const base = `shopify-${slug(reference) || head.sourceOrderId}`;
  const customer = head.customerEmail ?? head.customerName ?? 'Shopify Customer';
  const { built, warnings, netTotal } = resolvePricing(lines, head.currency);

  // ------------------------------------------------------------- CSV head --
  const headRows: unknown[][] = [
    [
      'Order Reference',
      'Customer',
      'Notes',
      'Payment Term',
      'Date',
      'Warehouse',
    ],
    [
      reference,
      customer,
      [
        head.note,
        `Shopify order ${head.sourceOrderId}`,
        `Shopify total ${fromMinor(head.total, head.currency)} ${head.currency}`,
      ]
        .filter(Boolean)
        .join(' | '),
      options.paymentTermName ?? '',
      head.sourceCreatedAt ? head.sourceCreatedAt.slice(0, 10) : '',
      options.warehouseName ?? '',
    ],
  ];

  // ----------------------------------------------------------- CSV lines --
  const lineRows: unknown[][] = [
    ['Order Reference', 'Product', 'Quantity', 'Unit Price', 'Discount', 'Taxes', 'Notes'],
  ];
  lines.forEach((line, index) => {
    const entry = built[index]!;
    const taxNames = (line.taxLines ?? [])
      .map((tax) => tax.title)
      .filter(Boolean)
      .join(', ');
    lineRows.push([
      reference,
      line.sku ?? line.productName,
      line.quantity,
      entry.priceUnit,
      entry.discountPct,
      taxNames,
      [
        line.variantTitle,
        line.discountCodes.length ? `discount: ${line.discountCodes.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' | '),
    ]);
  });

  // ---------------------------------------------------------------- XML ---
  const partnerId = `shopify_partner_${slug(customer || 'customer')}`;
  const orderId = `shopify_sale_order_${slug(head.sourceOrderId)}`;
  const partnerFields: string[] = [];
  const address = head.shippingAddress ?? head.billingAddress;
  partnerFields.push(`      <field name="name">${xmlEscape(head.customerName ?? customer)}</field>`);
  if (head.customerEmail) {
    partnerFields.push(`      <field name="email">${xmlEscape(head.customerEmail)}</field>`);
  }
  if (head.customerPhone) {
    partnerFields.push(`      <field name="phone">${xmlEscape(head.customerPhone)}</field>`);
  }
  if (address?.address1) {
    partnerFields.push(`      <field name="street">${xmlEscape(address.address1)}</field>`);
  }
  if (address?.address2) {
    partnerFields.push(`      <field name="street2">${xmlEscape(address.address2)}</field>`);
  }
  if (address?.city) {
    partnerFields.push(`      <field name="city">${xmlEscape(address.city)}</field>`);
  }
  if (address?.zip) {
    partnerFields.push(`      <field name="zip">${xmlEscape(address.zip)}</field>`);
  }
  if (address?.countryCode) {
    partnerFields.push(
      `      <field name="country_id" search="[('code','=','${xmlEscape(address.countryCode).toUpperCase()}')]"/>`,
    );
  }
  if (address?.state) {
    partnerFields.push(
      `      <field name="state_id" search="[('code','=','${xmlEscape(address.state).toUpperCase()}')]"/>`,
    );
  }

  const lineValues = lines.map((line, index) => {
    const entry = built[index]!;
    const values: Record<string, unknown> = {
      name: line.description ?? line.productName,
      product_uom_qty: line.quantity,
      price_unit: entry.priceUnit,
      discount: entry.discountPct,
      sequence: (line.lineNo + 1) * 10,
    };
    if (line.odooProductId) values.product_id = line.odooProductId;
    const taxIds = (line.taxLines ?? [])
      .map((tax) => tax.odooTaxId)
      .filter((id): id is number => typeof id === 'number');
    if (taxIds.length > 0) values.tax_id = [[6, 0, taxIds]];
    return values;
  });

  const orderFields: string[] = [];
  orderFields.push(`      <field name="client_order_ref">${xmlEscape(reference)}</field>`);
  if (options.includePartnerRecord) {
    orderFields.push(`      <field name="partner_id" ref="${partnerId}"/>`);
  } else if (head.customerEmail) {
    orderFields.push(
      `      <field name="partner_id" search="[('email','=','${xmlEscape(head.customerEmail)}')]"/>`,
    );
  }
  if (head.sourceCreatedAt) {
    const date = new Date(head.sourceCreatedAt);
    if (!Number.isNaN(date.getTime())) {
      const pad = (n: number) => String(n).padStart(2, '0');
      orderFields.push(
        `      <field name="date_order">${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}</field>`,
      );
    }
  }
  if (options.paymentTermName) {
    orderFields.push(
      `      <field name="payment_term_id" search="[('name','=','${xmlEscape(options.paymentTermName)}')]"/>`,
    );
  }
  if (options.warehouseName) {
    orderFields.push(
      `      <field name="warehouse_id" search="[('name','=','${xmlEscape(options.warehouseName)}')]"/>`,
    );
  }
  orderFields.push(
    `      <field name="client_order_note">${xmlEscape(
      `Imported from Shopify order ${reference} (source id ${head.sourceOrderId}).`,
    )}</field>`,
  );
  if (options.includeCustomFields) {
    orderFields.push(`      <field name="x_shopify_order_id">${xmlEscape(head.sourceOrderId)}</field>`);
    orderFields.push(
      `      <field name="x_shopify_order_number">${xmlEscape(head.sourceOrderNumber ?? '')}</field>`,
    );
    orderFields.push(`      <field name="x_shopify_source">${xmlEscape(head.source)}</field>`);
    orderFields.push(`      <field name="x_shopify_currency">${xmlEscape(head.currency)}</field>`);
    orderFields.push(
      `      <field name="x_shopify_total">${xmlEscape(fromMinor(head.total, head.currency))}</field>`,
    );
  }
  orderFields.push(`      <field name="order_line" eval="${xmlEscape(pythonLiteral(lineValues))}"/>`);

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by shopifytoodoo - Odoo data migration file for Shopify order ${xmlEscape(reference)} -->
<odoo>
  <data>
${
  options.includePartnerRecord
    ? `    <record id="${partnerId}" model="res.partner">\n${partnerFields.join('\n')}\n    </record>\n`
    : ''
}    <record id="${orderId}" model="sale.order">
${orderFields.join('\n')}
    </record>
  </data>
</odoo>
`;

  const taxTotal = lines.reduce((sum, line) => sum + line.taxTotal, 0);

  const artifacts: DmfArtifact[] = [
    {
      kind: 'sale-order-head',
      filename: `${base}-sale-order.csv`,
      mimeType: 'text/csv',
      content: toCsv(headRows),
      checksum: '',
    },
    {
      kind: 'sale-order-lines',
      filename: `${base}-sale-order-line.csv`,
      mimeType: 'text/csv',
      content: toCsv(lineRows),
      checksum: '',
    },
    {
      kind: 'sale-order-xml',
      filename: `${base}-sale-order.xml`,
      mimeType: 'text/xml',
      content: xml,
      checksum: '',
    },
  ];

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: head.source,
    sourceOrderId: head.sourceOrderId,
    reference,
    currency: head.currency,
    customer: {
      name: head.customerName,
      email: head.customerEmail,
      phone: head.customerPhone,
    },
    totals: {
      net: fromMinor(netTotal, head.currency),
      tax: fromMinor(taxTotal, head.currency),
      grand: fromMinor(head.total, head.currency),
    },
    lineCount: lines.length,
    discountCodes: [...new Set(lines.flatMap((line) => line.discountCodes))],
    warnings,
    fieldMapping: {
      'sale.order.client_order_ref': reference,
      'sale.order.partner_id': options.includePartnerRecord ? partnerId : 'search by email',
      'sale.order.date_order': head.sourceCreatedAt ?? null,
      'sale.order.order_line': 'sale.order.line rows',
      'sale.order.line.product_id': 'Odoo product id from product_mapping',
      'sale.order.line.price_unit': 'net unit price (discount applied)',
      'sale.order.line.discount': 'percentage discount when it reconciles exactly',
      'sale.order.line.tax_id': 'Odoo tax id from tax_mapping',
    },
    files: artifacts.map((artifact) => ({
      kind: artifact.kind,
      filename: artifact.filename,
      sha256: checksum(artifact.content),
    })),
  };

  artifacts.push({
    kind: 'manifest',
    filename: `${base}-manifest.json`,
    mimeType: 'application/json',
    content: `${JSON.stringify(manifest, null, 2)}\n`,
    checksum: '',
  });

  for (const artifact of artifacts) artifact.checksum = checksum(artifact.content);

  return {
    artifacts,
    summary: {
      reference,
      lines: lines.length,
      netTotal,
      taxTotal,
      grandTotal: head.total,
      currency: head.currency,
    },
  };
}
