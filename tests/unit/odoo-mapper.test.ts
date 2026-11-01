import { describe, expect, it } from 'vitest';
import { buildSaleOrderPayload, resolvePricing } from '../../src/domain/odoo-mapper.js';
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
  tags: ['online'],
  note: 'Leave at the front desk',
  sourceCreatedAt: '2026-10-01T09:15:00Z',
};

const lines: StoredLine[] = [
  {
    id: 'line-1',
    lineNo: 1,
    sourceLineId: 'gid://shopify/LineItem/501',
    sku: 'TSHIRT-CLASSIC',
    productName: 'Classic T-Shirt',
    variantTitle: 'Blue / M',
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
    taxLines: [{ title: 'GST', percentage: 10, amount: 450 }],
  },
  {
    id: 'line-2',
    lineNo: 2,
    sourceLineId: 'gid://shopify/LineItem/502',
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
    taxLines: [{ title: 'GST', percentage: 10, amount: 270 }],
  },
];

const options = {
  partnerId: 17,
  includeCustomFields: true,
  resolveProduct: (line: StoredLine) => ({
    productId: line.sku === 'TSHIRT-CLASSIC' ? 101 : 102,
    uomId: 1,
    defaultCode: line.sku,
  }),
  resolveTax: () => ({ taxId: 5, name: 'GST', percentage: 10 }),
};

describe('Odoo sale.order payload', () => {
  it('uses the percentage discount when it reproduces the Shopify amount', () => {
    const { built } = resolvePricing(lines, 'AUD');
    expect(built[0]).toMatchObject({
      priceUnit: 25,
      discountPct: 10,
      pricingMethod: 'percentage',
    });
    expect(built[1]).toMatchObject({ priceUnit: 30, discountPct: 10, pricingMethod: 'percentage' });
  });

  it('falls back to the net price when a percentage cannot reproduce the amount', () => {
    // 500.00 with a third off cannot be reproduced by a two decimal
    // percentage, so the net price has to be written instead.
    const odd = [
      {
        ...lines[0]!,
        quantity: 1,
        listPrice: 50000,
        netTotal: 33333,
        lineSubtotal: 50000,
        discountTotal: 16667,
        netPrice: 33333,
      },
    ];
    const { built } = resolvePricing(odd, 'AUD');
    expect(built[0]!.pricingMethod).toBe('net-price');
    expect(built[0]!.discountPct).toBe(0);
  });

  it('reconciles the sum of the lines with the Shopify net total', () => {
    const { built, netTotal } = resolvePricing(lines, 'AUD');
    expect(netTotal).toBe(7200);
    const extended = built.reduce((sum, entry, index) => {
      const quantity = lines[index]!.quantity;
      return sum + Math.round(entry.priceUnit * 100 * (1 - entry.discountPct / 100) * quantity);
    }, 0);
    expect(extended).toBe(7200);
  });

  it('builds a sale.order payload with the header, the lines and the provenance', () => {
    const result = buildSaleOrderPayload(head, lines, options);

    expect(result.payload.partner_id).toBe(17);
    expect(result.payload.client_order_ref).toBe('#1001');
    expect(result.payload.date_order).toBe('2026-10-01 09:15:00');
    expect(result.payload.x_shopify_order_id).toBe('1001');
    expect(result.payload.x_shopify_currency).toBe('AUD');
    expect(String(result.payload.client_order_note)).toContain('Shopify order #1001');

    const orderLines = result.payload.order_line as unknown[][];
    expect(orderLines).toHaveLength(2);

    const [first, second] = orderLines;
    const firstValues = first![2] as Record<string, unknown>;
    expect(firstValues.product_id).toBe(101);
    expect(firstValues.product_uom_qty).toBe(2);
    expect(firstValues.price_unit).toBe(25);
    expect(firstValues.discount).toBe(10);
    expect(firstValues.tax_id).toEqual([[6, 0, [5]]]);

    const secondValues = second![2] as Record<string, unknown>;
    expect(secondValues.product_id).toBe(102);
    expect(secondValues.price_unit).toBe(30);
    expect(String(secondValues.name)).toContain('SAVE10');
  });

  it('reports the totals that were sent to Odoo', () => {
    const result = buildSaleOrderPayload(head, lines, options);
    expect(result.totals.net).toBe(7200);
    expect(result.totals.tax).toBe(720);
    expect(result.totals.grand).toBe(7920);
  });

  it('warns when a line has no Odoo product', () => {
    const result = buildSaleOrderPayload(head, lines, {
      ...options,
      resolveProduct: () => null,
    });
    expect(result.warnings.join(' ')).toContain('not mapped to an Odoo product');
  });

  it('omits the custom fields when they are switched off', () => {
    const result = buildSaleOrderPayload(head, lines, { ...options, includeCustomFields: false });
    expect(result.payload.x_shopify_order_id).toBeUndefined();
  });
});
