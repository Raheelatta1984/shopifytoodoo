import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../container.js';
import { fromMinor } from '../domain/money.js';
import { requirePermission } from '../security/auth.js';

const listQuery = z.object({
  status: z.string().optional(),
  validationStatus: z.enum(['pending', 'passed', 'failed']).optional(),
  approvalStatus: z
    .enum(['not_required', 'pending', 'approved', 'rejected', 'auto_approved'])
    .optional(),
  sourceOrderId: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const publishBody = z.object({
  method: z.enum(['xmlrpc', 'jsonrpc', 'dmf']).default('xmlrpc'),
  force: z.boolean().optional(),
  comment: z.string().optional(),
});

const approveBody = z.object({
  decision: z.enum(['approve', 'reject']).default('approve'),
  comment: z.string().optional(),
  reason: z.string().optional(),
});

const ingestBody = z.object({
  query: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});

export async function orderRoutes(app: FastifyInstance, options: { container: Container }): Promise<void> {
  const { container } = options;
  // ------------------------------------------------------------- listing --
  app.get(
    '/api/v1/orders',
    { preHandler: [requirePermission('order:read')] },
    async (request) => {
      const query = listQuery.parse(request.query ?? {});
      const result = await container.orders.listHeads(query);
      return {
        total: result.total,
        limit: query.limit ?? 50,
        offset: query.offset ?? 0,
        orders: result.items.map((head) => ({
          id: head.id,
          source: head.source,
          sourceOrderId: head.sourceOrderId,
          sourceOrderName: head.sourceOrderName,
          status: head.status,
          validationStatus: head.validationStatus,
          approvalStatus: head.approvalStatus,
          currency: head.currency,
          total: fromMinor(head.total, head.currency),
          customerEmail: head.customerEmail,
          financialStatus: head.financialStatus,
          fulfillmentStatus: head.fulfillmentStatus,
          odooSaleOrderId: head.odooSaleOrderId,
          downloadedAt: head.downloadedAt,
          createdAt: head.sourceCreatedAt,
        })),
      };
    },
  );

  // -------------------------------------------------------------- detail --
  app.get(
    '/api/v1/orders/:id',
    { preHandler: [requirePermission('order:read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const head = await container.orders.getHead(id);
      if (!head) return reply.code(404).send({ error: 'not_found', message: 'Order not found' });

      const lines = await container.orders.getLines(id, head.currency);
      const [discounts, lineDiscounts, transactions, fulfillments, validations, pickings, attempts, artifacts] =
        await Promise.all([
          container.orders.getDiscounts(id, head.currency),
          container.orders.getLineDiscounts(id, head.currency),
          container.orders.getTransactions(id, head.currency),
          container.orders.getFulfillments(id),
          container.orders.getValidations(id),
          container.orders.getPickings(id),
          container.orders.getPublishAttempts(id),
          container.orders.getArtifacts(id),
        ]);

      return {
        head: {
          ...head,
          subtotal: fromMinor(head.subtotal, head.currency),
          discountTotal: fromMinor(head.discountTotal, head.currency),
          taxTotal: fromMinor(head.taxTotal, head.currency),
          shippingTotal: fromMinor(head.shippingTotal, head.currency),
          shippingDiscountTotal: fromMinor(head.shippingDiscountTotal, head.currency),
          total: fromMinor(head.total, head.currency),
          paid: fromMinor(head.paid, head.currency),
          refunded: fromMinor(head.refunded, head.currency),
          outstanding: fromMinor(head.outstanding, head.currency),
        },
        lines: lines.map((line) => ({
          ...line,
          listPrice: fromMinor(line.listPrice, head.currency),
          discountTotal: fromMinor(line.discountTotal, head.currency),
          taxTotal: fromMinor(line.taxTotal, head.currency),
          netPrice: fromMinor(line.netPrice, head.currency),
          lineSubtotal: fromMinor(line.lineSubtotal, head.currency),
          netTotal: fromMinor(line.netTotal, head.currency),
          lineTotal: fromMinor(line.lineTotal, head.currency),
        })),
        discounts,
        lineDiscounts,
        transactions,
        fulfillments,
        validations,
        pickings,
        publishAttempts: attempts,
        artifacts: artifacts.map((artifact) => ({
          id: artifact.id,
          kind: artifact.kind,
          filename: artifact.filename,
          mimeType: artifact.mimeType,
          checksum: artifact.checksum,
          createdAt: artifact.createdAt,
        })),
      };
    },
  );

  // ------------------------------------------------------------ ingestion --
  app.post(
    '/api/v1/orders/ingest',
    { preHandler: [requirePermission('order:ingest')] },
    async (request, reply) => {
      if (!container.ingestion) {
        return reply
          .code(409)
          .send({ error: 'not_configured', message: 'Shopify is not configured' });
      }
      const body = ingestBody.parse(request.body ?? {});
      const report = await container.ingestion.ingest({
        ...(body.query ? { query: body.query } : {}),
        ...(body.limit !== undefined ? { limit: body.limit } : {}),
        actor: request.user!.name,
        role: request.user!.role,
        ip: request.ip,
      });
      return reply.code(report.failed > 0 ? 207 : 200).send(report);
    },
  );

  // ----------------------------------------------------------- validation --
  app.post(
    '/api/v1/orders/:id/validate',
    { preHandler: [requirePermission('order:validate')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const report = await container.validation.validate(id);
      await container.auditRepo.record({
        actor: request.user!.name,
        role: request.user!.role,
        action: 'order.validate',
        entity: 'sales_order_head',
        entityId: id,
        result: report.status === 'passed' ? 'success' : 'failure',
        ip: request.ip,
        detail: { status: report.status, failed: report.blockingFailures.length },
      });
      return reply.code(report.status === 'passed' ? 200 : 422).send(report);
    },
  );

  // ------------------------------------------------------------- approval --
  app.post(
    '/api/v1/orders/:id/approve',
    { preHandler: [requirePermission('order:approve')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = approveBody.parse(request.body ?? {});
      const actor = { name: request.user!.name, role: request.user!.role, ip: request.ip };

      const decision =
        body.decision === 'reject'
          ? await container.approval.reject(id, actor, body.reason ?? 'rejected by approver')
          : await container.approval.approve(id, actor, body.comment);

      await container.auditRepo.record({
        actor: actor.name,
        role: actor.role,
        action: body.decision === 'reject' ? 'order.reject' : 'order.approve',
        entity: 'sales_order_head',
        entityId: id,
        result: 'success',
        ip: request.ip,
        detail: decision,
      });

      const head = await container.orders.getHead(id);
      return { ...decision, approvalStatus: head?.approvalStatus };
    },
  );

  // -------------------------------------------------------------- publish --
  app.post(
    '/api/v1/orders/:id/publish',
    { preHandler: [requirePermission('order:publish')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = publishBody.parse(request.body ?? {});
      const result = await container.publish.publish(id, {
        method: body.method,
        actor: request.user!.name,
        role: request.user!.role,
        ip: request.ip,
        ...(body.force !== undefined ? { force: body.force } : {}),
        ...(body.comment ? { comment: body.comment } : {}),
      });
      return reply.code(result.status === 'failed' ? 422 : 200).send(result);
    },
  );

  // ----------------------------------------------------------------- dmf --
  app.get(
    '/api/v1/orders/:id/dmf',
    { preHandler: [requirePermission('order:dmf')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const head = await container.orders.getHead(id);
      if (!head) return reply.code(404).send({ error: 'not_found', message: 'Order not found' });
      const artifacts = await container.orders.getArtifacts(id);
      return {
        orderId: id,
        artifacts: artifacts.map((artifact) => ({
          id: artifact.id,
          kind: artifact.kind,
          filename: artifact.filename,
          mimeType: artifact.mimeType,
          checksum: artifact.checksum,
          createdAt: artifact.createdAt,
        })),
      };
    },
  );

  app.get(
    '/api/v1/orders/:id/dmf/:artifactId',
    { preHandler: [requirePermission('order:dmf')] },
    async (request, reply) => {
      const { id, artifactId } = request.params as { id: string; artifactId: string };
      const artifacts = await container.orders.getArtifacts(id);
      const artifact = artifacts.find((entry) => entry.id === artifactId);
      if (!artifact) {
        return reply.code(404).send({ error: 'not_found', message: 'Artefact not found' });
      }
      return reply
        .header('content-type', artifact.mimeType)
        .header('content-disposition', `attachment; filename="${artifact.filename}"`)
        .send(artifact.content);
    },
  );

  // ---------------------------------------------------------------- audit --
  app.get(
    '/api/v1/orders/:id/audit',
    { preHandler: [requirePermission('order:read')] },
    async (request) => {
      const { id } = request.params as { id: string };
      const result = await container.auditRepo.list({ entityId: id, limit: 200 });
      return { orderId: id, entries: result.items, total: result.total };
    },
  );
}
