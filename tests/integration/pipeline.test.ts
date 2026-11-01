import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainer } from '../../src/container.js';
import { OdooClient } from '../../src/integrations/odoo/client.js';
import { PGliteDb } from '../../src/db/pglite.js';
import { createFakeOdoo, fixtureClient, testConfig } from '../helpers.js';

describe('end to end pipeline: Shopify -> central tables -> Odoo', () => {
  let container: Awaited<ReturnType<typeof createContainer>>;
  let odoo: ReturnType<typeof createFakeOdoo>;

  beforeEach(async () => {
    odoo = createFakeOdoo();
    const db = new PGliteDb('memory://');
    await db.ready();
    container = await createContainer(testConfig(), {
      db,
      shopifyClient: fixtureClient(),
      odooClient: new OdooClient({
        url: 'http://odoo.test',
        db: 'demo',
        username: 'admin',
        password: 'admin',
        protocol: 'xmlrpc',
        timeoutMs: 5000,
        fetchImpl: odoo.fetchImpl,
      }),
    });
    await container.seed();

    await container.mappingRepo.upsertProduct({ sku: 'TSHIRT-CLASSIC', odooProductId: 101, active: true });
    await container.mappingRepo.upsertProduct({ sku: 'TOTE-CANVAS', odooProductId: 102, active: true });
    await container.mappingRepo.upsertProduct({ sku: 'MUG-ENAMEL', odooProductId: 103, active: true });
    await container.mappingRepo.upsertTax({ shopifyTaxTitle: 'GST', odooTaxId: 5 });
  });

  afterEach(async () => {
    await container.close();
  });

  it('downloads, validates, approves and publishes an order', async () => {
    // 1. Download -------------------------------------------------------
    const report = await container.ingestion!.ingest({ actor: 'tester', role: 'admin' });
    expect(report.received).toBe(2);
    expect(report.created).toBe(2);
    expect(report.failed).toBe(0);

    const { items } = await container.orders.listHeads({});
    expect(items).toHaveLength(2);

    const order = items.find((head) => head.sourceOrderId === '1001')!;
    expect(order.total).toBe(7920);
    expect(order.currency).toBe('AUD');
    expect(order.status).toBe('downloaded');

    // The head, the lines, the discounts and the transactions are stored.
    const lines = await container.orders.getLines(order.id, 'AUD');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      sku: 'TSHIRT-CLASSIC',
      quantity: 2,
      listPrice: 2500,
      discountTotal: 500,
      taxTotal: 450,
      netTotal: 4500,
      lineTotal: 4950,
    });
    expect(lines[0]!.discountCodes).toEqual(['SAVE10']);
    expect(lines[0]!.taxLines[0]).toMatchObject({ title: 'GST', percentage: 10, amount: 450 });

    const discounts = await container.orders.getDiscounts(order.id);
    expect(discounts).toHaveLength(2);
    expect(discounts.find((discount) => discount.code === 'SAVE10')).toMatchObject({
      amount: 800,
      scope: 'line',
      allocationMethod: 'ACROSS',
    });
    expect(discounts.find((discount) => discount.code === 'FREESHIP')).toMatchObject({
      amount: 700,
      scope: 'shipping',
    });

    const transactions = await container.orders.getTransactions(order.id);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({ kind: 'capture', amount: 7920, gateway: 'shopify_payments' });

    const fulfillments = await container.orders.getFulfillments(order.id);
    expect(fulfillments[0]).toMatchObject({ status: 'SUCCESS' });

    // 2. Validate -------------------------------------------------------
    const validation = await container.validation.validate(order.id);
    expect(validation.status).toBe('passed');
    expect(validation.blockingFailures).toHaveLength(0);
    expect(validation.results.map((result) => result.ruleCode)).toContain('VAL-001');

    // 3. Approve (below the threshold -> auto approved) ------------------
    const decision = await container.approval.applyThreshold(order.id);
    expect(decision.required).toBe(false);
    expect(decision.status).toBe('auto_approved');

    // 4. Publish ---------------------------------------------------------
    const publish = await container.publish.publish(order.id, {
      method: 'xmlrpc',
      actor: 'tester',
      role: 'admin',
    });

    expect(publish.status).toBe('published');
    expect(publish.odooSaleOrderId).toBeDefined();
    expect(publish.partnerId).toBe(55);
    expect(publish.warnings).toHaveLength(0);

    // The sales order that reached Odoo carries the head and the lines.
    const createCall = odoo.calls.find(
      (call) => call.model === 'sale.order' && call.method === 'create',
    );
    expect(createCall).toBeDefined();
    const payload = createCall!.args[0] as Record<string, unknown>;
    expect(payload.partner_id).toBe(55);
    expect(payload.client_order_ref).toBe('#1001');
    expect(payload.x_shopify_order_id).toBe('1001');

    const orderLines = payload.order_line as unknown[][];
    expect(orderLines).toHaveLength(2);
    const [firstLine, secondLine] = orderLines.map((line) => line[2] as Record<string, unknown>);
    expect(firstLine).toMatchObject({
      product_id: 101,
      product_uom_qty: 2,
      price_unit: 25,
      discount: 10,
    });
    expect(firstLine!.tax_id).toEqual([[6, 0, [5]]]);
    expect(secondLine).toMatchObject({
      product_id: 102,
      product_uom_qty: 1,
      price_unit: 30,
      discount: 10,
    });

    // The sales order is confirmed and the pickings are read back.
    expect(
      odoo.calls.some((call) => call.model === 'sale.order' && call.method === 'action_confirm'),
    ).toBe(true);
    const pickings = await container.orders.getPickings(order.id);
    expect(pickings).toHaveLength(1);
    expect(pickings[0]).toMatchObject({ name: 'WH/OUT/00042', state: 'confirmed' });

    // 5. The head now points at the Odoo sales order --------------------
    const published = await container.orders.getHead(order.id);
    expect(published!.status).toBe('published');
    expect(published!.odooSaleOrderId).toBe(publish.odooSaleOrderId);
    expect(published!.odooPartnerId).toBe(55);

    // 6. Publishing twice is idempotent ----------------------------------
    const again = await container.publish.publish(order.id, {
      method: 'xmlrpc',
      actor: 'tester',
      role: 'admin',
    });
    expect(again.status).toBe('skipped');
    expect(odoo.calls.filter((call) => call.method === 'create' && call.model === 'sale.order')).toHaveLength(1);

    // 7. The audit trail records what happened ----------------------------
    const audit = await container.auditRepo.list({ entityId: order.id });
    const actions = audit.items.map((entry) => entry.action);
    expect(actions).toContain('order.publish');
    expect(audit.items.every((entry) => entry.actor === 'tester')).toBe(true);

    const ingestionAudit = await container.auditRepo.list({ action: 'order.ingest' });
    expect(ingestionAudit.items.length).toBeGreaterThan(0);
    expect(ingestionAudit.items[0]!.detail).toMatchObject({ received: 2, created: 2 });
  });

  it('produces DMF artefacts for a file based import', async () => {
    await container.ingestion!.ingest({ actor: 'tester', role: 'admin' });
    const { items } = await container.orders.listHeads({});
    const order = items.find((head) => head.sourceOrderId === '1002')!;

    await container.validation.validate(order.id);
    const result = await container.publish.publish(order.id, {
      method: 'dmf',
      actor: 'tester',
      role: 'admin',
    });

    expect(result.status).toBe('artifact_ready');
    expect(result.artifacts?.map((artifact) => artifact.kind)).toEqual([
      'sale-order-head',
      'sale-order-lines',
      'sale-order-xml',
      'manifest',
    ]);

    const artifacts = await container.orders.getArtifacts(order.id);
    const xml = artifacts.find((artifact) => artifact.kind === 'sale-order-xml')!;
    expect(xml.content).toContain('model="sale.order"');
    expect(xml.content).toContain('#1002');
    expect(xml.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('blocks the publish when the validation fails', async () => {
    await container.ingestion!.ingest({ actor: 'tester', role: 'admin' });
    const { items } = await container.orders.listHeads({});
    const order = items[0]!;

    // Remove the tax mapping so that the tax rule fails.
    await container.db.query('DELETE FROM tax_mapping');

    const validation = await container.validation.validate(order.id);
    expect(validation.status).toBe('failed');
    expect(validation.blockingFailures.map((failure) => failure.ruleCode)).toContain('VAL-009');

    const publish = await container.publish.publish(order.id, {
      method: 'xmlrpc',
      actor: 'tester',
      role: 'admin',
    });
    expect(publish.status).toBe('failed');
    expect(publish.error).toContain('Validation failed');
    expect(odoo.calls.some((call) => call.model === 'sale.order' && call.method === 'create')).toBe(false);
  });

  it('requires an explicit approval above the threshold', async () => {
    const db = new PGliteDb('memory://');
    await db.ready();
    const strict = await createContainer(testConfig({ APPROVAL_THRESHOLD_AMOUNT: '50' }), {
      db,
      shopifyClient: fixtureClient(),
    });
    await strict.seed();
    await strict.mappingRepo.upsertProduct({ sku: 'TSHIRT-CLASSIC', odooProductId: 101, active: true });
    await strict.mappingRepo.upsertProduct({ sku: 'TOTE-CANVAS', odooProductId: 102, active: true });
    await strict.mappingRepo.upsertTax({ shopifyTaxTitle: 'GST', odooTaxId: 5 });

    try {
      await strict.ingestion!.ingest({ actor: 'tester', role: 'admin' });
      const { items } = await strict.orders.listHeads({});
      const order = items.find((head) => head.sourceOrderId === '1001')!;

      await strict.validation.validate(order.id);
      const decision = await strict.approval.applyThreshold(order.id);
      expect(decision.required).toBe(true);
      expect(decision.status).toBe('pending');

      const blocked = await strict.publish.publish(order.id, {
        method: 'dmf',
        actor: 'tester',
        role: 'admin',
      });
      expect(blocked.status).toBe('failed');
      expect(blocked.error).toContain('approval');

      await strict.approval.approve(order.id, { name: 'approver', role: 'approver' }, 'looks good');
      const approved = await strict.publish.publish(order.id, {
        method: 'dmf',
        actor: 'tester',
        role: 'admin',
      });
      expect(approved.status).toBe('artifact_ready');

      const head = await strict.orders.getHead(order.id);
      expect(head!.approvalStatus).toBe('approved');
      expect(head!.approvedBy).toBe('approver');
    } finally {
      await strict.close();
    }
  });
});
