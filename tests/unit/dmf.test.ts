import { describe, expect, it } from 'vitest';
import { buildDmfArtifacts, pythonLiteral, toCsv } from '../../src/domain/dmf.js';
import type { StoredHead, StoredLine } from '../../src/domain/types.js';

const head: StoredHead = {
  id: 'head-1',
  source: 'shopify',
  sourceOrderId: '1001',
  sourceOrderName: '#1001',
  sourceOrderNumber: '1001',
  status: 'approved',
  validationStatus: 'passed',
  approvalStatus: 'approved',
  currency: 'AUD',
  subtotal: 8000,
  discountTotal: 1500,
  reportedDiscountTotal: 800,
  taxTotal: 720,
  shippingTotal: 0,
  shippingDiscountTotal: 700,
  total: 7920,
  paid: 7920,
  refunded: 0,
  outstanding: 0,
  customerEmail: 'jane.doe@example.com',
  customerName: 'Jane Doe',
  customerPhone: '+61 400 000 001',
  shippingAddress: {
    address1: '12 Example Street',
    city: 'Sydney',
    state: 'NSW',
    zip: '2000',
    countryCode: 'AU',
  },
  tags: ['online'],
  note: 'Leave at the front desk',
  sourceCreatedAt: '2026-10-01T09:15:00Z',
};

const lines: StoredLine[] = [
  {
    id: 'line-1',
    lineNo: 1,
    sku: 'TSHIRT-CLASSIC',
    productName: 'Classic T-Shirt',
    quantity: 2,
    uom: 'units',
    listPrice: 2500,
    discountTotal: 500,
    taxTotal: 450,
    netPrice: 2250,
    lineSubtotal: 5000,
    netTotal: 4500,
    lineTotal: 4950,
    discountCodes: ['SAVE10'],
    taxLines: [{ title: 'GST', percentage: 10, amount: 450, odooTaxId: 5 }],
    odooProductId: 101,
  },
  {
    id: 'line-2',
    lineNo: 2,
    sku: 'TOTE-CANVAS',
    productName: 'Canvas Tote Bag',
    quantity: 1,
    uom: 'units',
    listPrice: 3000,
    discountTotal: 300,
    taxTotal: 270,
    netPrice: 2700,
    lineSubtotal: 3000,
    netTotal: 2700,
    lineTotal: 2970,
    discountCodes: ['SAVE10'],
    taxLines: [{ title: 'GST', percentage: 10, amount: 270, odooTaxId: 5 }],
    odooProductId: 102,
  },
];

describe('DMF (data migration file) generation', () => {
  const bundle = buildDmfArtifacts(head, lines, {
    includePartnerRecord: true,
    includeCustomFields: true,
  });

  it('produces the head, line, xml and manifest artefacts', () => {
    expect(bundle.artifacts.map((artifact) => artifact.kind)).toEqual([
      'sale-order-head',
      'sale-order-lines',
      'sale-order-xml',
      'manifest',
    ]);
    for (const artifact of bundle.artifacts) {
      expect(artifact.filename).toMatch(/^shopify-1001/);
      expect(artifact.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('writes a head CSV that follows the Odoo import template', () => {
    const csv = bundle.artifacts[0]!.content;
    const rows = csv.trim().split('\r\n');
    expect(rows[0]).toBe('Order Reference,Customer,Notes,Payment Term,Date,Warehouse');
    expect(rows[1]).toContain('#1001');
    expect(rows[1]).toContain('jane.doe@example.com');
    expect(rows[1]).toContain('2026-10-01');
  });

  it('writes a line CSV that follows the Odoo import template', () => {
    const csv = bundle.artifacts[1]!.content;
    const rows = csv.trim().split('\r\n');
    expect(rows[0]).toBe('Order Reference,Product,Quantity,Unit Price,Discount,Taxes,Notes');
    expect(rows[1]).toContain('TSHIRT-CLASSIC');
    expect(rows[1]).toContain('25');
    expect(rows[1]).toContain('10');
    expect(rows[2]).toContain('TOTE-CANVAS');
  });

  it('writes an Odoo XML data file with the partner and the sales order', () => {
    const xml = bundle.artifacts[2]!.content;
    expect(xml).toContain('<odoo>');
    expect(xml).toContain('model="res.partner"');
    expect(xml).toContain('model="sale.order"');
    expect(xml).toContain('<field name="client_order_ref">#1001</field>');
    expect(xml).toContain('<field name="name"');
    expect(xml).toContain('order_line" eval="[');
    expect(xml).toContain("'product_id': 101");
    expect(xml).toContain("'tax_id': [[6, 0, [5]]]");
  });

  it('writes a manifest with the provenance and the checksums', () => {
    const manifest = JSON.parse(bundle.artifacts[3]!.content);
    expect(manifest.sourceOrderId).toBe('1001');
    expect(manifest.lineCount).toBe(2);
    expect(manifest.totals.grand).toBe('79.20');
    expect(manifest.discountCodes).toEqual(['SAVE10']);
    expect(manifest.files).toHaveLength(3);
    expect(manifest.fieldMapping['sale.order.client_order_ref']).toBe('#1001');
  });

  it('summarises the order', () => {
    expect(bundle.summary).toMatchObject({
      reference: '#1001',
      lines: 2,
      netTotal: 7200,
      taxTotal: 720,
      grandTotal: 7920,
      currency: 'AUD',
    });
  });
});

describe('CSV and Python literal helpers', () => {
  it('quotes the values that need it', () => {
    expect(toCsv([['a', 'b,c', 'd"e', 'f\ng']])).toBe('a,"b,c","d""e","f\ng"\r\n');
  });

  it('produces Python literals', () => {
    expect(pythonLiteral('a')).toBe("'a'");
    expect(pythonLiteral(1)).toBe('1');
    expect(pythonLiteral(1.5)).toBe('1.5');
    expect(pythonLiteral(true)).toBe('True');
    expect(pythonLiteral(null)).toBe('None');
    expect(pythonLiteral([1, 'a'])).toBe("[1, 'a']");
    expect(pythonLiteral({ a: 1 })).toBe("{'a': 1}");
    expect(pythonLiteral("it's")).toBe("'it\\'s'");
  });
});
