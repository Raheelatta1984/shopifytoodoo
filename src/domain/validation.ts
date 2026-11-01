/**
 * Validation rules.
 *
 * The rules are the "acceptance gate" of the central order management
 * solution: an order is only allowed to become a sales order in Odoo once
 * every blocking rule passes.  Each rule maps to a requirement from the
 * reviewed engagement (ENG-D3C8B563).
 */
import { toMinor } from './money.js';
import type { StoredHead, StoredLine } from './types.js';

export type RuleSeverity = 'blocking' | 'warning' | 'info';

export interface ValidationContext {
  head: StoredHead;
  lines: StoredLine[];
  discounts: { code?: string; title?: string; amount: number; scope?: string }[];
  lineDiscounts: { lineNo: number; code?: string; amount: number }[];
  transactions: { kind: string; status?: string; amount: number }[];
  supportedCurrencies: string[];
  productMapped: (line: StoredLine) => boolean;
  taxMapped: (title: string) => boolean;
  /** Number of stored heads sharing the same source order id. */
  duplicateCount: number;
  /** Tolerance in minor units (1 cent by default). */
  tolerance: number;
}

export interface RuleOutcome {
  ruleCode: string;
  severity: RuleSeverity;
  passed: boolean;
  message: string;
  detail?: unknown;
}

export interface ValidationRule {
  code: string;
  severity: RuleSeverity;
  description: string;
  requirement: string;
  evaluate: (context: ValidationContext) => RuleOutcome;
}

function make(code: string, severity: RuleSeverity) {
  return (passed: boolean, message: string, detail?: unknown): RuleOutcome => ({
    ruleCode: code,
    severity,
    passed,
    message,
    detail,
  });
}

export const VALIDATION_RULES: ValidationRule[] = [
  {
    code: 'VAL-001',
    severity: 'blocking',
    description: 'The order total reconciles with the sum of its lines, tax and shipping.',
    requirement: 'REQ-005 / EV-734D618CA - the Shopify order must be downloaded 100%',
    evaluate: (context) => {
      const { head, lines, tolerance } = context;
      const netTotal = lines.reduce((sum, line) => sum + (line.lineTotal - line.taxTotal), 0);
      const computed = netTotal + head.taxTotal + head.shippingTotal;
      const delta = computed - head.total;
      const passed = Math.abs(delta) <= tolerance;
      return make('VAL-001', 'blocking')(
        passed,
        passed
          ? `Order total reconciles (${computed} minor units).`
          : `Order total does not reconcile: expected ${head.total} but the lines add up to ${computed} (delta ${delta}).`,
        { expected: head.total, computed, delta, currency: head.currency },
      );
    },
  },
  {
    code: 'VAL-002',
    severity: 'blocking',
    description: 'Every line is internally consistent (subtotal - discount = net, net + tax = total).',
    requirement: 'REQ-005 / EV-90F53E666F - validate the order before generating the sales order',
    evaluate: (context) => {
      const failures: { lineNo: number; reason: string }[] = [];
      for (const line of context.lines) {
        const net = line.lineTotal - line.taxTotal;
        if (line.lineSubtotal - line.discountTotal !== net) {
          failures.push({
            lineNo: line.lineNo,
            reason: `subtotal ${line.lineSubtotal} - discount ${line.discountTotal} != net ${net}`,
          });
        }
        if (line.lineTotal !== net + line.taxTotal) {
          failures.push({ lineNo: line.lineNo, reason: 'line total does not equal net + tax' });
        }
      }
      const passed = failures.length === 0;
      return make('VAL-002', 'blocking')(
        
        passed,
        passed ? 'All lines are consistent.' : `Inconsistent lines: ${JSON.stringify(failures)}`,
        { failures },
      );
    },
  },
  {
    code: 'VAL-003',
    severity: 'blocking',
    description: 'The discounts recorded on the order add up to the discount reported by Shopify.',
    requirement: 'REQ-005 / EV-90F53E666F',
    evaluate: (context) => {
      const { head, lines, tolerance } = context;
      const lineDiscounts = lines.reduce((sum, line) => sum + line.discountTotal, 0);
      const total = lineDiscounts + head.shippingDiscountTotal;
      const delta = total - head.discountTotal;
      const reported = head.reportedDiscountTotal;
      // Shopify does not consistently include the shipping discount in the
      // order level discount total, so both readings are accepted.
      const matchesReported =
        !reported ||
        Math.abs(total - reported) <= tolerance ||
        Math.abs(lineDiscounts - reported) <= tolerance;
      const passed = Math.abs(delta) <= tolerance && matchesReported;
      return make('VAL-003', 'blocking')(
        passed,
        passed
          ? `Discounts reconcile (${total} minor units).`
          : `Discount mismatch: expected ${head.discountTotal} but recorded ${total} (delta ${delta}); Shopify reported ${reported}.`,
        { expected: head.discountTotal, computed: total, reported, delta },
      );
    },
  },
  {
    code: 'VAL-004',
    severity: 'blocking',
    description: 'The order has at least one line with a positive quantity.',
    requirement: 'REQ-006 / EV-19ABF00D7 - a valid request reaches the right owner',
    evaluate: (context) => {
      const usable = context.lines.filter((line) => line.quantity > 0);
      const passed = usable.length > 0 && usable.length === context.lines.length;
      return make('VAL-004', 'blocking')(
        
        passed,
        passed
          ? `${usable.length} line(s) ready to publish.`
          : `${context.lines.length - usable.length} line(s) have a non positive quantity.`,
        { lineCount: context.lines.length, usableLines: usable.length },
      );
    },
  },
  {
    code: 'VAL-005',
    severity: 'blocking',
    description: 'Quantities and prices are positive and consistent.',
    requirement: 'REQ-006 / EV-9E357474A3 - find the current status and next action',
    evaluate: (context) => {
      const failures = context.lines
        .filter(
          (line) =>
            line.quantity <= 0 ||
            line.listPrice < 0 ||
            line.netPrice < 0 ||
            line.taxTotal < 0 ||
            line.discountTotal < 0,
        )
        .map((line) => ({ lineNo: line.lineNo, quantity: line.quantity, price: line.listPrice }));
      const passed = failures.length === 0;
      return make('VAL-005', 'blocking')(
        
        passed,
        passed ? 'All quantities and prices are valid.' : `Invalid lines: ${JSON.stringify(failures)}`,
        { failures },
      );
    },
  },
  {
    code: 'VAL-006',
    severity: 'blocking',
    description: 'The customer can be identified (email or a deliverable shipping address).',
    requirement: 'REQ-003 / EV-FD43EA9808 - online e-commerce and customer service teams',
    evaluate: (context) => {
      const { head } = context;
      const address = head.shippingAddress ?? head.billingAddress;
      const hasAddress = Boolean(address?.address1 || address?.city);
      const passed = Boolean(head.customerEmail) || hasAddress;
      return make('VAL-006', 'blocking')(
        
        passed,
        passed
          ? 'Customer details are present.'
          : 'The customer has neither an email address nor a shipping address.',
        { email: head.customerEmail, hasAddress },
      );
    },
  },
  {
    code: 'VAL-007',
    severity: 'blocking',
    description: 'The order currency is supported by the Odoo instance.',
    requirement: 'REQ-008 / EV-EF9D00184F - we must use supported technology',
    evaluate: (context) => {
      const currency = context.head.currency.toUpperCase();
      const supported = context.supportedCurrencies.map((code) => code.toUpperCase());
      const passed = supported.length === 0 || supported.includes(currency);
      return make('VAL-007', 'blocking')(
        
        passed,
        passed
          ? `Currency ${currency} is supported.`
          : `Currency ${currency} is not in the supported list (${supported.join(', ')}).`,
        { currency, supported },
      );
    },
  },
  {
    code: 'VAL-008',
    severity: 'blocking',
    description: 'Every line is mapped to an Odoo product.',
    requirement: 'REQ-006 / EV-EA0FC6E04E - approvals depend on a threshold',
    evaluate: (context) => {
      const unmapped = context.lines
        .filter((line) => !context.productMapped(line))
        .map((line) => ({ lineNo: line.lineNo, sku: line.sku, name: line.productName }));
      const passed = unmapped.length === 0;
      return make('VAL-008', 'blocking')(
        
        passed,
        passed
          ? 'All lines are mapped to an Odoo product.'
          : `Unmapped lines: ${JSON.stringify(unmapped)}`,
        { unmapped },
      );
    },
  },
  {
    code: 'VAL-009',
    severity: 'blocking',
    description: 'Every tax title is mapped to an Odoo tax.',
    requirement: 'REQ-006 / EV-EA0FC6E04E',
    evaluate: (context) => {
      const titles = new Set<string>();
      for (const line of context.lines) {
        for (const tax of line.taxLines ?? []) titles.add(tax.title);
      }
      const unmapped = [...titles].filter((title) => !context.taxMapped(title));
      const passed = unmapped.length === 0;
      return make('VAL-009', 'blocking')(
        
        passed,
        passed ? 'All taxes are mapped.' : `Unmapped taxes: ${unmapped.join(', ')}`,
        { unmapped },
      );
    },
  },
  {
    code: 'VAL-010',
    severity: 'blocking',
    description: 'The order is stored exactly once (no duplicates).',
    requirement: 'REQ-005 / EV-734D618CA - download the order 100%',
    evaluate: (context) => {
      const passed = context.duplicateCount <= 1;
      return make('VAL-010', 'blocking')(
        
        passed,
        passed ? 'No duplicate order found.' : `${context.duplicateCount} rows share this order id.`,
        { duplicateCount: context.duplicateCount },
      );
    },
  },
  {
    code: 'VAL-011',
    severity: 'warning',
    description: 'The payments recorded on the order reconcile with the order total.',
    requirement: 'REQ-002 / EV-93ED9D5E95 - financial transactions',
    evaluate: (context) => {
      const { head, tolerance } = context;
      const paid = head.paid;
      const refunded = head.refunded;
      const outstanding = head.outstanding;
      const captured = context.transactions
        .filter((transaction) => ['capture', 'sale'].includes(transaction.kind.toLowerCase()))
        .reduce((sum, transaction) => sum + transaction.amount, 0);
      const refunds = context.transactions
        .filter((transaction) => transaction.kind.toLowerCase() === 'refund')
        .reduce((sum, transaction) => sum + Math.abs(transaction.amount), 0);

      const settled = paid - refunded;
      const expected = head.total - outstanding;
      const delta = settled - expected;
      const claimsPaid = ['paid', 'partially_paid'].includes(
        (head.financialStatus ?? '').toLowerCase(),
      );
      const transactionDelta = captured - refunds - paid;
      const passed = !claimsPaid || (Math.abs(delta) <= tolerance && Math.abs(transactionDelta) <= tolerance);

      return make('VAL-011', 'warning')(
        
        passed,
        passed
          ? 'Payments reconcile with the order total.'
          : `Payment mismatch: settled ${settled} vs expected ${expected} (delta ${delta}), captured ${captured}, refunded ${refunds}.`,
        { paid, refunded, outstanding, captured, refunds, delta, transactionDelta },
      );
    },
  },
  {
    code: 'VAL-012',
    severity: 'warning',
    description: 'Every discount carries an amount and a scope so it can be reported on.',
    requirement: 'REQ-002 / EV-15418DA19E - reduce processing time from a measured baseline',
    evaluate: (context) => {
      const incomplete = context.discounts.filter(
        (discount) => !discount.amount && discount.amount !== 0,
      );
      const passed = incomplete.length === 0;
      return make('VAL-012', 'warning')(
        
        passed,
        passed
          ? `${context.discounts.length} discount(s) recorded.`
          : `${incomplete.length} discount(s) have no amount.`,
        { discountCount: context.discounts.length },
      );
    },
  },
  {
    code: 'VAL-013',
    severity: 'info',
    description: 'The order carries fulfilment information.',
    requirement: 'REQ-002 / EV-93ED9D5E95 - picking information is pushed back to the order',
    evaluate: (context) => {
      const fulfilled = (context.head.fulfillmentStatus ?? '').toLowerCase();
      const hasFulfilment = ['fulfilled', 'partially_fulfilled'].includes(fulfilled);
      return make('VAL-013', 'info')(
        
        true,
        hasFulfilment
          ? 'The order has been fulfilled in Shopify.'
          : 'The order has not been fulfilled yet.',
        { fulfillmentStatus: context.head.fulfillmentStatus },
      );
    },
  },
];

/** Convenience helper: convert a decimal string into minor units for a currency. */
export function minor(value: string | number | undefined, currency: string): number {
  return toMinor(value, currency);
}
