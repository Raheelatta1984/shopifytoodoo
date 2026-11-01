/**
 * Maps a raw Shopify order (Admin GraphQL payload) onto the canonical order
 * model.
 *
 * The mapping is deliberately defensive: Shopify has renamed money fields
 * several times (`price` -> `priceSet`, `allocatedAmount` -> `allocatedAmountSet`)
 * and older/newer API versions can be in flight at the same time.
 */
import { allocateProportionally, percentOf, roundHalfAway, toMinor } from '../../domain/money.js';
import type {
  CanonicalAddress,
  CanonicalDiscount,
  CanonicalDiscountAllocation,
  CanonicalFulfillment,
  CanonicalLine,
  CanonicalOrder,
  CanonicalShippingLine,
  CanonicalTaxLine,
  CanonicalTransaction,
} from '../../domain/types.js';

type Dict = Record<string, unknown>;

export class ShopifyMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopifyMappingError';
  }
}

function dig(source: unknown, ...path: string[]): unknown {
  let current: unknown = source;
  for (const key of path) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Dict)[key];
  }
  return current;
}

function asDict(value: unknown): Dict {
  return value && typeof value === 'object' ? (value as Dict) : {};
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  const dict = value as Dict;
  if (Array.isArray(dict.nodes)) return dict.nodes;
  if (Array.isArray(dict.edges)) return dict.edges.map((edge) => dig(edge, 'node'));
  return [];
}

function str(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/** Read a monetary amount from a MoneyBag / MoneyV2 / raw scalar. */
export function readMoney(node: unknown, currency: string): number {
  if (node === null || node === undefined) return 0;
  if (typeof node === 'number' || typeof node === 'string') return toMinor(node, currency);
  const dict = node as Dict;
  if ('shopMoney' in dict) return readMoney(dict.shopMoney, currency);
  if ('presentmentMoney' in dict) return readMoney(dict.presentmentMoney, currency);
  if ('amount' in dict) return readMoney(dict.amount, currency);
  return 0;
}

function mapAddress(node: unknown): CanonicalAddress | undefined {
  if (!node) return undefined;
  const dict = asDict(node);
  const address: CanonicalAddress = {
    name: str(dict.name),
    firstName: str(dict.firstName),
    lastName: str(dict.lastName),
    company: str(dict.company),
    address1: str(dict.address1),
    address2: str(dict.address2),
    city: str(dict.city),
    state: str(dig(dict, 'provinceCode')) ?? str(dict.province),
    zip: str(dict.zip),
    countryCode: str(dict.countryCodeV2) ?? str(dict.country),
    countryName: str(dict.country),
    phone: str(dict.phone),
  };
  const hasValue = Object.values(address).some((value) => value !== undefined);
  return hasValue ? address : undefined;
}

function mapTaxLines(node: unknown, currency: string): CanonicalTaxLine[] {
  return asList(node)
    .map((entry) => {
      const dict = asDict(entry);
      return {
        title: str(dict.title) ?? 'Tax',
        percentage: Number(dict.percentage ?? 0),
        amount: readMoney(dig(dict, 'priceSet'), currency),
      };
    })
    .filter((tax) => tax.amount !== 0 || tax.percentage !== 0);
}

interface RawAllocation {
  amount: number;
  appIndex?: number;
  code?: string;
  allocationMethod: string;
  title: string;
}

function readAllocations(node: unknown, currency: string): RawAllocation[] {
  return asList(node).map((entry) => {
    const dict = asDict(entry);
    const app = asDict(dict.discountApplication);
    const amount = readMoney(dict.allocatedAmountSet ?? dict.allocatedAmount, currency);
    const code = str(app.code);
    const typeName = str(app.__typename) ?? 'Discount';
    return {
      amount,
      appIndex: typeof app.index === 'number' ? app.index : undefined,
      code,
      allocationMethod: str(app.allocationMethod) ?? 'ACROSS',
      title: code ?? typeName,
    };
  });
}

function mapTransactions(node: unknown, currency: string): CanonicalTransaction[] {
  return asList(node).map((entry) => {
    const dict = asDict(entry);
    const amount = readMoney(dig(dict, 'amountSet'), currency);
    return {
      sourceTransactionId: str(dict.id) ?? `txn-${Math.random().toString(36).slice(2)}`,
      parentTransactionId: str(dig(dict, 'parentTransaction', 'id')),
      kind: str(dict.kind) ?? 'unknown',
      status: str(dict.status),
      gateway: str(dict.gateway),
      amount,
      currency: str(dig(dict, 'amountSet', 'shopMoney', 'currencyCode')) ?? currency,
      processedAt: str(dict.processedAt),
      errorMessage: str(dict.errorMessage),
    };
  });
}

function mapFulfillments(node: unknown): CanonicalFulfillment[] {
  return asList(node).map((entry) => {
    const dict = asDict(entry);
    const trackingNumbers: string[] = [];
    const trackingUrls: string[] = [];
    for (const info of asList(dict.trackingInfo)) {
      const tracking = asDict(info);
      const number = str(tracking.number);
      const url = str(tracking.url);
      if (number) trackingNumbers.push(number);
      if (url) trackingUrls.push(url);
    }
    return {
      sourceFulfillmentId: str(dict.id) ?? `ful-${Math.random().toString(36).slice(2)}`,
      status: str(dict.status),
      trackingNumbers,
      trackingUrls,
      createdAt: str(dict.createdAt),
    };
  });
}

/**
 * Convert a Shopify order node into the canonical order model.
 */
export function mapShopifyOrder(node: Record<string, unknown>): CanonicalOrder {
  const source = asDict(node);
  const currency = str(source.currencyCode) ?? 'USD';
  const gid = str(source.id);

  const sourceOrderId = String(
    source.legacyResourceId ?? (gid ? gid.split('/').pop() ?? gid : ''),
  );
  if (!sourceOrderId) {
    throw new ShopifyMappingError('Shopify order is missing an identifier');
  }

  // ------------------------------------------------------------ discounts --
  const discountApplications = asList(dig(source, 'discountApplications')).map((entry) => {
    const dict = asDict(entry);
    const value = asDict(dict.value);
    const valueTypeName = str(value.__typename);
    const code = str(dict.code);
    const title = code ?? str(dict.title) ?? str(value.__typename) ?? 'Discount';
    return {
      index: typeof dict.index === 'number' ? dict.index : undefined,
      typeName: str(dict.__typename) ?? 'DiscountApplication',
      code,
      title,
      allocationMethod: str(dict.allocationMethod) ?? 'ACROSS',
      targetType: str(dict.targetType) ?? 'LINE_ITEM',
      valueType:
        valueTypeName === 'MoneyV2'
          ? ('amount' as const)
          : valueTypeName === 'PricingPercentageValue'
            ? ('percentage' as const)
            : ('unknown' as const),
      valueAmount: valueTypeName === 'MoneyV2' ? readMoney(value, currency) : undefined,
      valuePercentage:
        valueTypeName === 'PricingPercentageValue' ? Number(value.percentage ?? 0) : undefined,
      allocations: 0,
      amount: 0,
    };
  });

  const appByIndex = new Map<number, (typeof discountApplications)[number]>();
  const appByCode = new Map<string, (typeof discountApplications)[number]>();
  for (const app of discountApplications) {
    if (app.index !== undefined) appByIndex.set(app.index, app);
    if (app.code) appByCode.set(app.code.toUpperCase(), app);
  }

  const registerAllocation = (allocation: RawAllocation): void => {
    let app =
      allocation.appIndex !== undefined ? appByIndex.get(allocation.appIndex) : undefined;
    if (!app && allocation.code) app = appByCode.get(allocation.code.toUpperCase());
    if (!app) {
      app = {
        index: allocation.appIndex,
        typeName: 'DiscountApplication',
        code: allocation.code,
        title: allocation.title,
        allocationMethod: allocation.allocationMethod,
        targetType: 'LINE_ITEM',
        valueType: 'unknown',
        valueAmount: undefined,
        valuePercentage: undefined,
        allocations: 0,
        amount: 0,
      };
      if (app.index !== undefined) appByIndex.set(app.index, app);
      if (app.code) appByCode.set(app.code.toUpperCase(), app);
      discountApplications.push(app);
    }
    app.allocations += 1;
    app.amount += allocation.amount;
  };

  // ---------------------------------------------------------------- lines --
  const rawLines = asList(dig(source, 'lineItems'));
  const lines: CanonicalLine[] = [];

  rawLines.forEach((entry, index) => {
    const dict = asDict(entry);
    const quantity = Number(dict.quantity ?? 0);
    const listPrice = readMoney(dig(dict, 'originalUnitPriceSet'), currency);
    const originalTotal = readMoney(dig(dict, 'originalTotalSet'), currency);
    const allocations = readAllocations(dict.discountAllocations, currency);
    const discountTotal = allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
    const taxLines = mapTaxLines(dict.taxLines, currency);
    const taxTotal = taxLines.reduce((sum, tax) => sum + tax.amount, 0);
    const netTotal = originalTotal - discountTotal;

    const canonicalAllocations: CanonicalDiscountAllocation[] = allocations.map((allocation) => ({
      code: allocation.code,
      title: allocation.title,
      allocationMethod: allocation.allocationMethod,
      amount: allocation.amount,
    }));

    lines.push({
      sourceLineId: str(dict.id) ?? `line-${index + 1}`,
      sku: str(dict.sku) ?? str(dig(dict, 'variant', 'sku')),
      name: str(dict.name) ?? str(dict.title) ?? 'Line item',
      variantTitle: str(dict.variantTitle),
      productId: str(dig(dict, 'product', 'id')),
      productVariantId: str(dig(dict, 'variant', 'id')),
      quantity,
      uom: 'units',
      listPrice,
      originalTotal,
      discountTotal,
      netTotal,
      netPrice: quantity > 0 ? roundHalfAway(netTotal / quantity) : netPriceFallback(listPrice, discountTotal, quantity),
      taxTotal,
      lineTotal: netTotal + taxTotal,
      taxLines,
      allocations: canonicalAllocations,
    });

    for (const allocation of allocations) registerAllocation(allocation);
  });

  // ------------------------------------------------------------ shipping ---
  const shippingLines: CanonicalShippingLine[] = [];
  let shippingGrossTotal = 0;
  let shippingDiscountTotal = 0;
  let shippingNetTotal = 0;
  let shippingTaxTotal = 0;

  for (const entry of asList(dig(source, 'shippingLines'))) {
    const dict = asDict(entry);
    const gross = readMoney(dig(dict, 'originalPriceSet'), currency);
    const discounted = readMoney(dig(dict, 'discountedPriceSet'), currency);
    const allocations = readAllocations(dict.discountAllocations, currency);
    const allocated = allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
    const net = discounted || gross - allocated;
    const tax = mapTaxLines(dict.taxLines, currency).reduce((sum, taxLine) => sum + taxLine.amount, 0);

    shippingLines.push({
      title: str(dict.title) ?? 'Shipping',
      price: gross !== 0 ? gross : net + allocated,
      discount: allocated,
    });
    shippingGrossTotal += gross !== 0 ? gross : net + allocated;
    shippingDiscountTotal += allocated;
    shippingNetTotal += net;
    shippingTaxTotal += tax;
    for (const allocation of allocations) registerAllocation(allocation);
  }

  // ------------------------------------------- order level (unallocated) --
  // Shopify normally allocates every discount to a line or to shipping.  When
  // an order-level discount has no allocation we derive its value and spread
  // it over the lines proportionally (largest remainder) so the sales order
  // still reconciles to the penny.
  const unallocated = discountApplications.filter((app) => app.allocations === 0);
  if (unallocated.length > 0 && lines.length > 0) {
    const subtotal = lines.reduce((sum, line) => sum + line.originalTotal, 0);
    for (const app of unallocated) {
      let amount = 0;
      if (app.valueType === 'amount') amount = app.valueAmount ?? 0;
      else if (app.valueType === 'percentage') amount = percentOf(subtotal, app.valuePercentage ?? 0);
      app.amount = amount;
      if (amount === 0) continue;

      const weights = lines.map((line) => Math.max(line.netTotal, 0));
      const shares = allocateProportionally(amount, weights);
      lines.forEach((line, index) => {
        const share = shares[index] ?? 0;
        if (share === 0) return;
        line.discountTotal += share;
        line.netTotal -= share;
        line.lineTotal = line.netTotal + line.taxTotal;
        line.netPrice =
          line.quantity > 0 ? roundHalfAway(line.netTotal / line.quantity) : line.netPrice;
        line.allocations.push({
          code: app.code,
          title: app.title,
          allocationMethod: app.allocationMethod,
          amount: share,
        });
      });
    }
  }

  const discounts: CanonicalDiscount[] = discountApplications.map((app) => ({
    sourceDiscountId: app.index !== undefined ? String(app.index) : undefined,
    code: app.code,
    title: app.title,
    description: app.typeName,
    allocationMethod: app.allocationMethod,
    targetType: app.targetType,
    valueType: app.valueType,
    valueAmount: app.valueAmount,
    valuePercentage: app.valuePercentage,
    amount: app.amount,
    scope: app.targetType === 'SHIPPING_LINE' ? 'shipping' : app.allocations > 0 ? 'line' : 'order',
  }));

  // -------------------------------------------------------------- totals --
  const lineSubtotal = lines.reduce((sum, line) => sum + line.originalTotal, 0);
  const lineDiscountTotal = lines.reduce((sum, line) => sum + line.discountTotal, 0);
  const lineNetTotal = lines.reduce((sum, line) => sum + line.netTotal, 0);
  const lineTaxTotal = lines.reduce((sum, line) => sum + line.taxTotal, 0);
  const totalDiscount = discountApplications.reduce((sum, app) => sum + app.amount, 0);
  const taxTotal = lineTaxTotal + shippingTaxTotal;
  const total = lineNetTotal + taxTotal + shippingNetTotal;

  const reportedSubtotal = readMoney(dig(source, 'currentSubtotalPriceSet'), currency);
  const reportedTaxTotal = readMoney(dig(source, 'currentTotalTaxSet'), currency);
  const reportedDiscount = readMoney(dig(source, 'currentTotalDiscountsSet'), currency);
  const reportedShipping = readMoney(dig(source, 'totalShippingPriceSet'), currency);
  const reportedTotal = readMoney(dig(source, 'currentTotalPriceSet'), currency);
  const paid = readMoney(dig(source, 'totalReceivedSet'), currency);
  const refunded = readMoney(dig(source, 'totalRefundedSet'), currency);
  const outstanding = readMoney(dig(source, 'totalOutstandingSet'), currency);

  const transactions = mapTransactions(source.transactions, currency);
  const customer = asDict(source.customer);
  const customerName =
    [str(customer.firstName), str(customer.lastName)].filter(Boolean).join(' ') || undefined;

  const orderTags = Array.isArray(source.tags)
    ? (source.tags as unknown[]).map((tag) => String(tag)).filter(Boolean)
    : [];

  return {
    source: 'shopify',
    sourceOrderId,
    sourceOrderGid: gid,
    name: str(source.name),
    number: source.number !== undefined ? String(source.number) : undefined,
    channel: str(source.sourceName),
    currency,
    createdAt: str(source.createdAt),
    updatedAt: str(source.updatedAt),
    processedAt: str(source.processedAt),
    subtotal: reportedSubtotal || lineSubtotal,
    discountTotal: totalDiscount,
    reportedDiscountTotal: reportedDiscount,
    taxTotal: reportedTaxTotal || taxTotal,
    shippingTotal: reportedShipping || shippingNetTotal,
    shippingDiscountTotal,
    total: reportedTotal || total,
    paid,
    refunded,
    outstanding,
    paymentGateway: Array.isArray(source.paymentGatewayNames)
      ? (source.paymentGatewayNames as unknown[]).map(String)[0]
      : undefined,
    financialStatus: str(source.displayFinancialStatus),
    fulfillmentStatus: str(source.displayFulfillmentStatus),
    customer: {
      id: str(customer.id) ?? str(customer.legacyResourceId),
      email: str(customer.email) ?? str(source.email),
      firstName: str(customer.firstName),
      lastName: str(customer.lastName),
      phone: str(customer.phone) ?? str(source.phone),
      ordersCount: customer.numberOfOrders !== undefined ? Number(customer.numberOfOrders) : undefined,
    },
    billingAddress: mapAddress(source.billingAddress),
    shippingAddress: mapAddress(source.shippingAddress),
    taxLines: mapTaxLines(dig(source, 'currentTaxLines') ?? dig(source, 'taxLines'), currency),
    shippingLines,
    discounts,
    lines,
    transactions,
    fulfillments: mapFulfillments(source.fulfillments),
    tags: orderTags,
    note: str(source.note),
    computed: {
      lineSubtotal,
      lineDiscountTotal,
      lineNetTotal,
      lineTaxTotal,
      shippingGrossTotal,
      shippingDiscountTotal,
      shippingNetTotal,
      shippingTaxTotal,
      discountTotal: totalDiscount,
      taxTotal,
      total,
    },
    raw: node,
  };
}

function netPriceFallback(listPrice: number, discountTotal: number, quantity: number): number {
  if (quantity <= 0) return listPrice;
  return roundHalfAway(listPrice - discountTotal / quantity);
}
