/**
 * Canonical, source-agnostic order model.
 *
 * The canonical model is the contract between the ingestion layer (Shopify),
 * the central order tables, the validation engine and the Odoo publishing
 * layer.  All monetary values are integer minor units.
 */

export type OrderSource = 'shopify';

export type OrderStatus =
  | 'downloaded'
  | 'validated'
  | 'rejected'
  | 'approved'
  | 'published'
  | 'failed';

export type ValidationStatus = 'pending' | 'passed' | 'failed';

export type ApprovalStatus =
  | 'not_required'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'auto_approved';

export interface CanonicalAddress {
  name?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  countryCode?: string;
  countryName?: string;
  phone?: string;
  email?: string;
}

export interface CanonicalTaxLine {
  title: string;
  percentage: number;
  /** Tax amount for the scope it was reported on (line or order). */
  amount: number;
  /** Odoo tax id, populated when the tax mapping is known. */
  odooTaxId?: number;
}

export interface CanonicalDiscountAllocation {
  code?: string;
  title: string;
  allocationMethod: string;
  /** Amount allocated to the owning line, minor units. */
  amount: number;
}

export interface CanonicalLine {
  sourceLineId: string;
  sku?: string;
  name: string;
  variantTitle?: string;
  productId?: string;
  productVariantId?: string;
  quantity: number;
  uom: string;
  /** List (undiscounted) unit price, minor units. */
  listPrice: number;
  /** Undiscounted extended price, minor units. */
  originalTotal: number;
  /** Total discount applied to this line, minor units. */
  discountTotal: number;
  /** Net (discounted) extended price, minor units. */
  netTotal: number;
  /** Net unit price after discount, minor units. */
  netPrice: number;
  /** Tax charged on this line, minor units. */
  taxTotal: number;
  /** Net + tax, minor units. */
  lineTotal: number;
  taxLines: CanonicalTaxLine[];
  allocations: CanonicalDiscountAllocation[];
  note?: string;
}

export interface CanonicalDiscount {
  sourceDiscountId?: string;
  code?: string;
  title: string;
  description?: string;
  allocationMethod?: string;
  targetType?: string;
  valueType: 'amount' | 'percentage' | 'unknown';
  valueAmount?: number;
  valuePercentage?: number;
  /** Total amount of this discount applied to the order, minor units. */
  amount: number;
  scope: 'order' | 'line' | 'shipping';
}

export interface CanonicalTransaction {
  sourceTransactionId: string;
  parentTransactionId?: string;
  kind: string;
  status?: string;
  gateway?: string;
  amount: number;
  currency?: string;
  processedAt?: string;
  errorMessage?: string;
}

export interface CanonicalFulfillment {
  sourceFulfillmentId: string;
  status?: string;
  trackingNumbers: string[];
  trackingUrls: string[];
  createdAt?: string;
}

export interface CanonicalShippingLine {
  title: string;
  price: number;
  discount: number;
}

export interface CanonicalCustomer {
  id?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  ordersCount?: number;
}

/**
 * Amounts rebuilt from the individual order components (lines, shipping,
 * discounts and tax).  Validation compares these against the totals Shopify
 * reports on the order header so that a 100% download can be proven rather
 * than assumed (REQ-005 / EV-90F53E666F).
 */
export interface CanonicalOrderComputed {
  /** Sum of the undiscounted line totals. */
  lineSubtotal: number;
  /** Discount applied to the lines. */
  lineDiscountTotal: number;
  /** Sum of the net (discounted) line totals. */
  lineNetTotal: number;
  /** Tax charged on the lines. */
  lineTaxTotal: number;
  /** Gross shipping price before discounts. */
  shippingGrossTotal: number;
  /** Discount applied to shipping. */
  shippingDiscountTotal: number;
  /** Shipping price after discounts. */
  shippingNetTotal: number;
  /** Tax charged on shipping. */
  shippingTaxTotal: number;
  /** All discounts (lines + shipping + order level). */
  discountTotal: number;
  /** All tax. */
  taxTotal: number;
  /** Reconstructed grand total. */
  total: number;
}

export interface CanonicalOrder {
  source: OrderSource;
  /** Shopify numeric order id (stable, source scoped). */
  sourceOrderId: string;
  sourceOrderGid?: string;
  /** Shopify order name, e.g. "#1001". */
  name?: string;
  /** Shopify legacy order number, e.g. "1001". */
  number?: string;
  channel?: string;
  currency: string;
  createdAt?: string;
  updatedAt?: string;
  processedAt?: string;

  subtotal: number;
  /** Total of every discount (lines, shipping and order level), minor units. */
  discountTotal: number;
  /** The discount total as reported by Shopify, minor units. */
  reportedDiscountTotal: number;
  taxTotal: number;
  shippingTotal: number;
  shippingDiscountTotal: number;
  total: number;

  paid: number;
  refunded: number;
  outstanding: number;

  paymentGateway?: string;
  financialStatus?: string;
  fulfillmentStatus?: string;

  customer?: CanonicalCustomer;
  billingAddress?: CanonicalAddress;
  shippingAddress?: CanonicalAddress;

  taxLines: CanonicalTaxLine[];
  shippingLines: CanonicalShippingLine[];
  discounts: CanonicalDiscount[];
  lines: CanonicalLine[];
  transactions: CanonicalTransaction[];
  fulfillments: CanonicalFulfillment[];

  tags: string[];
  note?: string;
  /** Amounts rebuilt from the order components. */
  computed: CanonicalOrderComputed;
  /** Verbatim source payload, retained for audit and re-processing. */
  raw: unknown;
}

/** A sales order line as stored in `sales_order_line`. */
export interface StoredLine {
  id: string;
  lineNo: number;
  sourceLineId?: string;
  sourceVariantId?: string;
  sku?: string;
  productName: string;
  variantTitle?: string;
  description?: string;
  quantity: number;
  uom: string;
  /** List unit price, minor units. */
  listPrice: number;
  /** Discount applied to the line, minor units. */
  discountTotal: number;
  /** Tax charged on the line, minor units. */
  taxTotal: number;
  /** Net unit price after discount, minor units. */
  netPrice: number;
  /** Undiscounted extended price, minor units. */
  lineSubtotal: number;
  /** Net (discounted) extended price, minor units. */
  netTotal: number;
  /** Net + tax, minor units. */
  lineTotal: number;
  discountCodes: string[];
  taxLines: CanonicalTaxLine[];
  odooProductId?: number;
  odooLineId?: number;
}

/** A sales order head as stored in `sales_order_head`. */
export interface StoredHead {
  id: string;
  source: string;
  sourceOrderId: string;
  sourceOrderName?: string;
  sourceOrderNumber?: string;
  channel?: string;
  status: string;
  validationStatus: string;
  approvalStatus: string;
  approvedBy?: string;
  approvedAt?: string;
  approvalComment?: string;
  rejectedReason?: string;
  currency: string;
  subtotal: number;
  discountTotal: number;
  reportedDiscountTotal: number;
  taxTotal: number;
  shippingTotal: number;
  shippingDiscountTotal: number;
  total: number;
  paid: number;
  refunded: number;
  outstanding: number;
  paymentGateway?: string;
  financialStatus?: string;
  fulfillmentStatus?: string;
  customerRef?: string;
  customerEmail?: string;
  customerName?: string;
  customerPhone?: string;
  billingAddress?: CanonicalAddress;
  shippingAddress?: CanonicalAddress;
  taxLines: CanonicalTaxLine[];
  shippingLines: CanonicalShippingLine[];
  tags: string[];
  note?: string;
  sourceCreatedAt?: string;
  downloadedAt?: string;
  odooSaleOrderId?: number;
  odooPartnerId?: number;
}

export function orderTotalExTax(order: CanonicalOrder): number {
  return order.subtotal - order.discountTotal + order.shippingTotal - order.shippingDiscountTotal;
}

export function customerDisplayName(order: CanonicalOrder): string {
  const c = order.customer;
  if (c) {
    const full = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
    if (full) return full;
    if (c.email) return c.email;
  }
  if (order.shippingAddress?.name) return order.shippingAddress.name;
  if (order.billingAddress?.name) return order.billingAddress.name;
  return 'Shopify Customer';
}
