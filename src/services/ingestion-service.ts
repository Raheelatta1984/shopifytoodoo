/**
 * Ingestion service: pulls orders from Shopify, maps them onto the canonical
 * model and stores them in the central order tables.
 */
import { mapShopifyOrder } from '../integrations/shopify/mapper.js';
import type { ShopifyClient } from '../integrations/shopify/client.js';
import type { OrderRepository } from '../repositories/order-repository.js';
import type { AuditRepository } from '../repositories/audit-repository.js';

export interface IngestionDeps {
  client: ShopifyClient;
  orders: OrderRepository;
  audit: AuditRepository;
}

export interface IngestionOptions {
  /** Shopify search query, e.g. "updated_at:>=2026-10-01 status:any". */
  query?: string;
  /** Maximum number of orders to pull. */
  limit?: number;
  actor: string;
  role?: string;
  ip?: string;
}

export interface IngestionReport {
  received: number;
  created: number;
  updated: number;
  failed: number;
  orderIds: string[];
  errors: { orderId?: string; message: string }[];
}

export class IngestionService {
  constructor(private readonly deps: IngestionDeps) {}

  async ingest(options: IngestionOptions): Promise<IngestionReport> {
    const report: IngestionReport = {
      received: 0,
      created: 0,
      updated: 0,
      failed: 0,
      orderIds: [],
      errors: [],
    };

    try {
      for await (const page of this.deps.client.fetchOrderPages({
        ...(options.query ? { query: options.query } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      })) {
        for (const node of page.nodes) {
          report.received += 1;
          try {
            const order = mapShopifyOrder(node);
            const result = await this.deps.orders.upsertOrder(order);
            if (result.created) report.created += 1;
            else report.updated += 1;
            report.orderIds.push(order.sourceOrderId);
          } catch (error) {
            report.failed += 1;
            report.errors.push({ message: (error as Error).message });
          }
        }
      }
    } catch (error) {
      report.failed += 1;
      report.errors.push({ message: (error as Error).message });
      await this.deps.audit.record({
        actor: options.actor,
        role: options.role,
        action: 'order.ingest',
        entity: 'shopify',
        result: 'failure',
        ip: options.ip,
        detail: { error: (error as Error).message },
      });
      throw error;
    }

    await this.deps.audit.record({
      actor: options.actor,
      role: options.role,
      action: 'order.ingest',
      entity: 'shopify',
      result: report.failed > 0 ? 'failure' : 'success',
      ip: options.ip,
      detail: {
        received: report.received,
        created: report.created,
        updated: report.updated,
        failed: report.failed,
      },
    });

    return report;
  }
}
