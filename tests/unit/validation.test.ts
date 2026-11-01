import { describe, expect, it } from 'vitest';
import { VALIDATION_RULES, type ValidationContext } from '../../src/domain/validation.js';
import type { StoredHead, StoredLine } from '../../src/domain/types.js';

const head: StoredHead = {
  id: 'head-1',
  source: 'shopify',
  sourceOrderId: '1001',
  sourceOrderName: '#1001',
  status: 'downloaded',
  validationStatus: 'pending',
  approvalStatus: 'not_required',
  currency: 'AUD',
  subtotal: 8000,
  discountTotal: 500,
  reportedDiscountTotal: 500,
  taxTotal: 450,
  shippingTotal: 0,
  shippingDiscountTotal: 0,
  total: 4950,
  paid: 4950,
  refunded: 0,
  outstanding: 0,
  customerEmail: 'jane@example.com',
};

const line: StoredLine = {
  id: 'line-1',
  lineNo: 1,
  sku: 'SKU-1',
  productName: 'Product',
  quantity: 2,
  uom: 'units',
  listPrice: 2500,
  discountTotal: 500,
  taxTotal: 450,
  netPrice: 2250,
  lineSubtotal: 5000,
  netTotal: 4500,
  lineTotal: 4950,
  discountCodes: [],
  taxLines: [{ title: 'GST', percentage: 10, amount: 450 }],
};

function context(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    head,
    lines: [line],
    discounts: [{ code: 'SAVE10', title: 'SAVE10', amount: 500, scope: 'line' }],
    lineDiscounts: [{ lineNo: 1, code: 'SAVE10', amount: 500 }],
    transactions: [{ kind: 'capture', status: 'success', amount: 4950 }],
    supportedCurrencies: ['AUD', 'USD'],
    productMapped: () => true,
    taxMapped: () => true,
    duplicateCount: 1,
    tolerance: 1,
    ...overrides,
  };
}

function run(ctx: ValidationContext, code: string) {
  const rule = VALIDATION_RULES.find((entry) => entry.code === code)!;
  return rule.evaluate(ctx);
}

describe('validation rules', () => {
  it('covers every requirement area with an executable rule', () => {
    expect(VALIDATION_RULES.length).toBeGreaterThanOrEqual(10);
    for (const rule of VALIDATION_RULES) {
      expect(rule.code).toMatch(/^VAL-\d{3}$/);
      expect(rule.description.length).toBeGreaterThan(10);
      expect(rule.requirement).toContain('REQ-');
    }
  });

  it('VAL-001 fails when the lines do not add up to the order total', () => {
    const outcome = run(context(), 'VAL-001');
    expect(outcome.passed).toBe(true);

    const broken = run(
      context({ head: { ...head, total: 7000 } }),
      'VAL-001',
    );
    expect(broken.passed).toBe(false);
    expect(broken.message).toContain('does not reconcile');
  });

  it('VAL-002 fails when a line is inconsistent', () => {
    const broken = run(
      context({ lines: [{ ...line, lineTotal: 5000 }] }),
      'VAL-002',
    );
    expect(broken.passed).toBe(false);
  });

  it('VAL-003 accepts the two readings of the Shopify discount total', () => {
    expect(run(context(), 'VAL-003').passed).toBe(true);

    // Shopify reports 8.00 while the shipping discount of 7.00 is not part of
    // it: the rule accepts both readings.
    const withShipping = run(
      context({
        lines: [{ ...line, discountTotal: 800, lineSubtotal: 5300 }],
        head: {
          ...head,
          discountTotal: 1500,
          reportedDiscountTotal: 800,
          shippingDiscountTotal: 700,
        },
      }),
      'VAL-003',
    );
    expect(withShipping.passed).toBe(true);

    const wrong = run(
      context({
        lines: [{ ...line, discountTotal: 800, lineSubtotal: 5300 }],
        head: {
          ...head,
          discountTotal: 1500,
          reportedDiscountTotal: 900,
          shippingDiscountTotal: 700,
        },
      }),
      'VAL-003',
    );
    expect(wrong.passed).toBe(false);
  });

  it('VAL-004 and VAL-005 reject lines without a usable quantity', () => {
    expect(run(context({ lines: [{ ...line, quantity: 0 }] }), 'VAL-004').passed).toBe(false);
    expect(run(context({ lines: [{ ...line, listPrice: -10 }] }), 'VAL-005').passed).toBe(false);
  });

  it('VAL-006 requires a customer email or a shipping address', () => {
    expect(run(context(), 'VAL-006').passed).toBe(true);
    const noCustomer = run(
      context({ head: { ...head, customerEmail: undefined, shippingAddress: undefined } }),
      'VAL-006',
    );
    expect(noCustomer.passed).toBe(false);
  });

  it('VAL-007 rejects an unsupported currency', () => {
    expect(run(context(), 'VAL-007').passed).toBe(true);
    const jpy = run(context({ head: { ...head, currency: 'JPY' } }), 'VAL-007');
    expect(jpy.passed).toBe(false);
  });

  it('VAL-008 and VAL-009 require the Odoo mappings', () => {
    expect(run(context(), 'VAL-008').passed).toBe(true);
    expect(run(context({ productMapped: () => false }), 'VAL-008').passed).toBe(false);
    expect(run(context({ taxMapped: () => false }), 'VAL-009').passed).toBe(false);
  });

  it('VAL-010 rejects a duplicated order', () => {
    expect(run(context(), 'VAL-010').passed).toBe(true);
    expect(run(context({ duplicateCount: 2 }), 'VAL-010').passed).toBe(false);
  });

  it('VAL-011 warns when the payments do not match the total', () => {
    const outcome = run(
      context({ head: { ...head, financialStatus: 'PAID', paid: 1000 } }),
      'VAL-011',
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.severity).toBe('warning');
  });
});
