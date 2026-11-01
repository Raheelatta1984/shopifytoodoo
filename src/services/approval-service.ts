/**
 * Approval workflow.
 *
 * "Approvals depend on a threshold" (EV-EA0FC6E04E).  Orders whose total is
 * below the configured threshold are auto approved once they validate; orders
 * at or above the threshold need an explicit approval from a user with the
 * `approver` (or `admin`) role before they can be published.
 */
import { toMinor } from '../domain/money.js';
import type { StoredHead } from '../domain/types.js';
import type { OrderRepository } from '../repositories/order-repository.js';
import type { Settings, SettingsRepository } from '../repositories/settings-repository.js';
import type { Role } from '../repositories/user-repository.js';

export interface ApprovalDeps {
  orders: OrderRepository;
  settings: SettingsRepository;
  defaultSettings: Settings;
}

export interface ApprovalDecision {
  required: boolean;
  status: string;
  reason: string;
  threshold?: number;
  thresholdCurrency?: string;
}

export interface Actor {
  name: string;
  role: Role;
  ip?: string;
}

export class ApprovalService {
  constructor(private readonly deps: ApprovalDeps) {}

  async evaluate(head: StoredHead): Promise<ApprovalDecision> {
    const settings = await this.deps.settings.getAll(this.deps.defaultSettings);
    const threshold = Number(settings.approvalThresholdAmount ?? 0);
    const thresholdCurrency = String(settings.approvalThresholdCurrency ?? '').toUpperCase();
    const orderCurrency = head.currency.toUpperCase();
    // The threshold is stored in major units, the order total in minor units.
    const thresholdMinor = toMinor(threshold, orderCurrency);

    if (threshold <= 0) {
      return {
        required: false,
        status: 'not_required',
        reason: 'No approval threshold is configured.',
      };
    }

    const currencyMatches = thresholdCurrency === '' || thresholdCurrency === orderCurrency;
    const aboveThreshold = currencyMatches && head.total >= thresholdMinor;

    if (!currencyMatches) {
      return {
        required: true,
        status: 'pending',
        reason: `The approval threshold is expressed in ${thresholdCurrency} while the order is in ${orderCurrency}; an explicit approval is required.`,
        threshold,
        thresholdCurrency,
      };
    }

    if (!aboveThreshold) {
      return {
        required: false,
        status: 'auto_approved',
        reason: `The order total is below the approval threshold of ${threshold} ${orderCurrency}.`,
        threshold,
        thresholdCurrency: orderCurrency,
      };
    }

    return {
      required: true,
      status: 'pending',
      reason: `The order total ${head.total} minor units is at or above the approval threshold of ${threshold} ${orderCurrency}.`,
      threshold,
      thresholdCurrency: orderCurrency,
    };
  }

  /** Apply the threshold decision to the order (auto approve when not required). */
  async applyThreshold(headId: string): Promise<ApprovalDecision> {
    const head = await this.deps.orders.getHead(headId);
    if (!head) throw new Error(`Order ${headId} was not found`);
    const decision = await this.evaluate(head);
    if (!decision.required && head.approvalStatus !== 'approved') {
      await this.deps.orders.updateHead(headId, { approvalStatus: decision.status });
    } else if (decision.required && head.approvalStatus === 'not_required') {
      await this.deps.orders.updateHead(headId, { approvalStatus: 'pending' });
    }
    return decision;
  }

  async approve(headId: string, actor: Actor, comment?: string): Promise<ApprovalDecision> {
    if (actor.role !== 'approver' && actor.role !== 'admin') {
      throw new Error('Only an approver or an administrator can approve an order');
    }
    const head = await this.deps.orders.getHead(headId);
    if (!head) throw new Error(`Order ${headId} was not found`);
    if (head.validationStatus !== 'passed') {
      throw new Error('The order must pass validation before it can be approved');
    }
    await this.deps.orders.updateHead(headId, {
      approvalStatus: 'approved',
      approvedBy: actor.name,
      approvedAt: new Date().toISOString(),
      approvalComment: comment ?? null,
      status: 'approved',
    });
    return { required: true, status: 'approved', reason: 'Approved by ' + actor.name };
  }

  async reject(headId: string, actor: Actor, reason: string): Promise<ApprovalDecision> {
    if (actor.role !== 'approver' && actor.role !== 'admin' && actor.role !== 'operator') {
      throw new Error('Only an operator, approver or an administrator can reject an order');
    }
    await this.deps.orders.updateHead(headId, {
      approvalStatus: 'rejected',
      rejectedReason: reason,
      status: 'rejected',
    });
    return { required: true, status: 'rejected', reason };
  }

  /** True when the order is allowed to be published. */
  async canPublish(head: StoredHead): Promise<{ allowed: boolean; reason: string }> {
    if (head.validationStatus !== 'passed') {
      return { allowed: false, reason: 'The order has not passed validation' };
    }
    const allowed = ['approved', 'auto_approved', 'not_required'].includes(head.approvalStatus);
    return {
      allowed,
      reason: allowed
        ? 'The order is validated and approved'
        : `The order is waiting for approval (${head.approvalStatus})`,
    };
  }
}
