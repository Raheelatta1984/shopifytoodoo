import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../container.js';
import { SETTING_KEYS } from '../repositories/settings-repository.js';
import { requirePermission } from '../security/auth.js';

const settingsBody = z.object({
  approvalThresholdAmount: z.number().min(0).optional(),
  approvalThresholdCurrency: z.string().optional(),
  supportedCurrencies: z.array(z.string()).optional(),
  fallbackOdooProductId: z.number().int().positive().nullable().optional(),
  fallbackOdooTaxId: z.number().int().positive().nullable().optional(),
  defaultUomId: z.number().int().positive().nullable().optional(),
  companyId: z.number().int().positive().nullable().optional(),
  warehouseId: z.number().int().positive().nullable().optional(),
  pricelistId: z.number().int().positive().nullable().optional(),
  paymentTermId: z.number().int().positive().nullable().optional(),
  currencyId: z.number().int().positive().nullable().optional(),
  confirmSaleOrder: z.boolean().optional(),
  createMissingPartner: z.boolean().optional(),
  writeCustomFields: z.boolean().optional(),
  dmfUploadEnabled: z.boolean().optional(),
});

const productMappingBody = z.object({
  shopifyProductId: z.string().optional(),
  shopifyVariantId: z.string().optional(),
  sku: z.string().optional(),
  odooProductId: z.number().int().positive(),
  odooUomId: z.number().int().positive().optional(),
  description: z.string().optional(),
});

const taxMappingBody = z.object({
  shopifyTaxTitle: z.string().min(1),
  shopifyPercentage: z.number().optional(),
  odooTaxId: z.number().int().positive(),
});

export async function adminRoutes(app: FastifyInstance, options: { container: Container }): Promise<void> {
  const { container } = options;
  // ------------------------------------------------------------ settings --
  app.get(
    '/api/v1/settings',
    { preHandler: [requirePermission('settings:read')] },
    async () => {
      const settings = await container.settingsRepo.getAll(container.defaultSettings);
      return { settings, stored: await container.settingsRepo.list() };
    },
  );

  app.put(
    '/api/v1/settings',
    { preHandler: [requirePermission('settings:write')] },
    async (request, reply) => {
      const body = settingsBody.parse(request.body ?? {});
      const values: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined) continue;
        values[SETTING_KEYS[key as keyof typeof SETTING_KEYS] ?? key] = value;
      }
      await container.settingsRepo.setMany(values);
      await container.auditRepo.record({
        actor: request.user!.name,
        role: request.user!.role,
        action: 'settings.update',
        entity: 'app_setting',
        result: 'success',
        ip: request.ip,
        detail: values,
      });
      const settings = await container.settingsRepo.getAll(container.defaultSettings);
      return reply.send({ settings, updated: Object.keys(values) });
    },
  );

  // ------------------------------------------------------------ mappings --
  app.get(
    '/api/v1/mappings/products',
    { preHandler: [requirePermission('mapping:read')] },
    async () => ({ products: await container.mappingRepo.listProducts() }),
  );

  app.post(
    '/api/v1/mappings/products',
    { preHandler: [requirePermission('mapping:write')] },
    async (request, reply) => {
      const body = productMappingBody.parse(request.body ?? {});
      const mapping = await container.mappingRepo.upsertProduct({ ...body, active: true });
      await container.auditRepo.record({
        actor: request.user!.name,
        role: request.user!.role,
        action: 'mapping.product.upsert',
        entity: 'product_mapping',
        entityId: mapping.id,
        result: 'success',
        ip: request.ip,
        detail: mapping,
      });
      return reply.code(201).send({ mapping });
    },
  );

  app.delete(
    '/api/v1/mappings/products/:id',
    { preHandler: [requirePermission('mapping:write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await container.mappingRepo.deleteProduct(id);
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/mappings/taxes',
    { preHandler: [requirePermission('mapping:read')] },
    async () => ({ taxes: await container.mappingRepo.listTaxes() }),
  );

  app.post(
    '/api/v1/mappings/taxes',
    { preHandler: [requirePermission('mapping:write')] },
    async (request, reply) => {
      const body = taxMappingBody.parse(request.body ?? {});
      const mapping = await container.mappingRepo.upsertTax(body);
      await container.auditRepo.record({
        actor: request.user!.name,
        role: request.user!.role,
        action: 'mapping.tax.upsert',
        entity: 'tax_mapping',
        entityId: mapping.id,
        result: 'success',
        ip: request.ip,
        detail: mapping,
      });
      return reply.code(201).send({ mapping });
    },
  );

  app.delete(
    '/api/v1/mappings/taxes/:id',
    { preHandler: [requirePermission('mapping:write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await container.mappingRepo.deleteTax(id);
      return reply.code(204).send();
    },
  );

  // --------------------------------------------------------------- audit --
  app.get(
    '/api/v1/audit',
    { preHandler: [requirePermission('audit:read')] },
    async (request) => {
      const query = z
        .object({
          action: z.string().optional(),
          entityId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(1000).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        })
        .parse(request.query ?? {});
      const result = await container.auditRepo.list(query);
      return { total: result.total, entries: result.items };
    },
  );

  // --------------------------------------------------------------- users --
  app.get(
    '/api/v1/users',
    { preHandler: [requirePermission('user:manage')] },
    async () => ({ users: await container.userRepo.list() }),
  );

  app.post(
    '/api/v1/users',
    { preHandler: [requirePermission('user:manage')] },
    async (request, reply) => {
      const body = z
        .object({
          name: z.string().min(1),
          role: z.enum(['viewer', 'operator', 'approver', 'integrator', 'auditor', 'admin']),
          apiKey: z.string().min(8),
        })
        .parse(request.body ?? {});
      const user = await container.userRepo.upsert(body.name, body.role, body.apiKey);
      await container.auditRepo.record({
        actor: request.user!.name,
        role: request.user!.role,
        action: 'user.upsert',
        entity: 'app_user',
        entityId: user.id,
        result: 'success',
        ip: request.ip,
        detail: { name: user.name, role: user.role },
      });
      return reply.code(201).send({ user });
    },
  );
}
