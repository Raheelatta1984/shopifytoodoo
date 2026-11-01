import { describe, expect, it } from 'vitest';
import { mapShopifyOrder } from '../../src/integrations/shopify/mapper.js';
import { fixtureOrders } from '../helpers.js';

const [first, second] = fixtureOrders();

describe('Shopify -> canonical order mapping', () => {
  const order = mapShopifyOrder(first!);

  it('captures the order identity', () => {
    expect(order.source).toBe('shopify');
    expect(order.sourceOrderId).toBe('1001');
    expect(order.name).toBe('#1001');
    expect(order.currency).toBe('AUD');
    expect(order.customer?.email).toBe('jane.doe@example.com');
    expect(order.customer?.firstName).toBe('Jane');
  });

  it('keeps the totals reported by Shopify', () => {
    expect(order.subtotal).toBe(8000);
    expect(order.total).toBe(7920);
    expect(order.taxTotal).toBe(720);
    expect(order.shippingTotal).toBe(0);
    expect(order.paid).toBe(7920);
    expect(order.refunded).toBe(0);
    expect(order.outstanding).toBe(0);
    expect(order.reportedDiscountTotal).toBe(800);
  });

  it('rebuilds the order from its components', () => {
    expect(order.computed.lineSubtotal).toBe(8000);
    expect(order.computed.lineDiscountTotal).toBe(800);
    expect(order.computed.lineNetTotal).toBe(7200);
    expect(order.computed.lineTaxTotal).toBe(720);
    expect(order.computed.shippingGrossTotal).toBe(700);
    expect(order.computed.shippingDiscountTotal).toBe(700);
    expect(order.computed.shippingNetTotal).toBe(0);
    expect(order.computed.discountTotal).toBe(1500);
    expect(order.computed.total).toBe(7920);
  });

  it('maps the lines with their discounts and tax', () => {
    expect(order.lines).toHaveLength(2);

    const [line1, line2] = order.lines;

    expect(line1!.sku).toBe('TSHIRT-CLASSIC');
    expect(line1!.quantity).toBe(2);
    expect(line1!.listPrice).toBe(2500);
    expect(line1!.originalTotal).toBe(5000);
    expect(line1!.discountTotal).toBe(500);
    expect(line1!.netTotal).toBe(4500);
    expect(line1!.taxTotal).toBe(450);
    expect(line1!.lineTotal).toBe(4950);
    expect(line1!.netPrice).toBe(2250);
    expect(line1!.allocations[0]?.code).toBe('SAVE10');
    expect(line1!.taxLines[0]).toMatchObject({ title: 'GST', percentage: 10, amount: 450 });

    expect(line2!.sku).toBe('TOTE-CANVAS');
    expect(line2!.netTotal).toBe(2700);
    expect(line2!.taxTotal).toBe(270);
  });

  it('maps the shipping line and its discount', () => {
    expect(order.shippingLines).toHaveLength(1);
    expect(order.shippingLines[0]).toMatchObject({
      title: 'Standard Shipping',
      price: 700,
      discount: 700,
    });
  });

  it('maps the discounts with their allocation method and value', () => {
    expect(order.discounts).toHaveLength(2);

    const code = order.discounts.find((discount) => discount.code === 'SAVE10');
    expect(code).toMatchObject({
      title: 'SAVE10',
      allocationMethod: 'ACROSS',
      targetType: 'LINE_ITEM',
      valueType: 'percentage',
      valuePercentage: 10,
      amount: 800,
      scope: 'line',
    });

    const shipping = order.discounts.find((discount) => discount.code === 'FREESHIP');
    expect(shipping).toMatchObject({
      allocationMethod: 'ENTIRE_ORDER',
      targetType: 'SHIPPING_LINE',
      valueType: 'amount',
      valueAmount: 700,
      amount: 700,
      scope: 'shipping',
    });
  });

  it('maps the financial transactions', () => {
    expect(order.transactions).toHaveLength(1);
    expect(order.transactions[0]).toMatchObject({
      kind: 'capture',
      status: 'success',
      gateway: 'shopify_payments',
      amount: 7920,
      currency: 'AUD',
    });
  });

  it('maps the fulfilments and their tracking information', () => {
    expect(order.fulfillments).toHaveLength(1);
    expect(order.fulfillments[0]).toMatchObject({
      status: 'SUCCESS',
      trackingNumbers: ['TRACK-123'],
    });
  });

  it('maps a refunded order without a discount', () => {
    const refunded = mapShopifyOrder(second!);
    expect(refunded.sourceOrderId).toBe('1002');
    expect(refunded.discounts).toHaveLength(0);
    expect(refunded.computed.discountTotal).toBe(0);
    expect(refunded.transactions).toHaveLength(2);
    expect(refunded.transactions[1]).toMatchObject({
      kind: 'refund',
      amount: -1375,
      parentTransactionId: 'gid://shopify/OrderTransaction/9101',
    });
    expect(refunded.refunded).toBe(1375);
  });
});
