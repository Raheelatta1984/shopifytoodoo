/**
 * Validation service: runs the rule set against a stored order and records
 * the outcome so that the "current status and next action" is always
 * available (REQ-006 / EV-9E357474A3).
 */
import { VALIDATION_RULES, type RuleOutcome } from '../domain/validation.js';
import type { OrderRepository, ValidationResultRecord } from '../repositories/order-repository.js';
import type { MappingRepository } from '../repositories/mapping-repository.js';
import type { Settings, SettingsRepository } from '../repositories/settings-repository.js';

export interface ValidationDeps {
  orders: OrderRepository;
  mappings: MappingRepository;
  settings: SettingsRepository;
  defaultSettings: Settings;
}

export interface ValidationReport {
  headId: string;
  status: 'passed' | 'failed';
  results: ValidationResultRecord[];
  blockingFailures: ValidationResultRecord[];
  warnings: ValidationResultRecord[];
  passedRules: number;
  totalRules: number;
}

export class ValidationService {
  constructor(private readonly deps: ValidationDeps) {}

  async validate(headId: string): Promise<ValidationReport> {
    const head = await this.deps.orders.getHead(headId);
    if (!head) throw new Error(`Order ${headId} was not found`);

    const settings = await this.deps.settings.getAll(this.deps.defaultSettings);
    const lines = await this.deps.orders.getLines(headId, head.currency);
    const discounts = (await this.deps.orders.getDiscounts(headId, head.currency)) as {
      code?: string;
      title?: string;
      amount: number;
      scope?: string;
    }[];
    const lineDiscounts = (await this.deps.orders.getLineDiscounts(headId, head.currency)) as {
      lineNo: number;
      code?: string;
      amount: number;
    }[];
    const transactions = (await this.deps.orders.getTransactions(headId, head.currency)) as {
      kind: string;
      status?: string;
      amount: number;
    }[];

    const productMapped = async (line: { sku?: string; productVariantId?: string }): Promise<boolean> => {
      if (settings.fallbackOdooProductId) return true;
      const mapping = await this.deps.mappings.findProduct({
        variantId: line.productVariantId ?? null,
        sku: line.sku ?? null,
      });
      return mapping !== null;
    };

    const taxMapped = async (title: string): Promise<boolean> => {
      if (settings.fallbackOdooTaxId) return true;
      const mapping = await this.deps.mappings.findTax(title);
      return mapping !== null;
    };

    const duplicateCount = await this.deps.orders.countBySource(head.source, head.sourceOrderId);

    // The mapping lookups are resolved before the rules run so that the rule
    // functions stay synchronous and deterministic.
    const productFlags = new Map<string, boolean>();
    for (const line of lines) {
      productFlags.set(line.id, await productMapped(line));
    }
    const taxTitles = new Set<string>();
    for (const line of lines) {
      for (const tax of line.taxLines ?? []) taxTitles.add(tax.title);
    }
    const taxFlags = new Map<string, boolean>();
    for (const title of taxTitles) {
      taxFlags.set(title, await taxMapped(title));
    }

    const outcomes: RuleOutcome[] = VALIDATION_RULES.map((rule) =>
      rule.evaluate({
        head,
        lines,
        discounts,
        lineDiscounts,
        transactions,
        supportedCurrencies: settings.supportedCurrencies ?? [],
        productMapped: (line) => productFlags.get(line.id) ?? false,
        taxMapped: (title) => taxFlags.get(title) ?? false,
        duplicateCount,
        tolerance: 1,
      }),
    );

    const results: ValidationResultRecord[] = outcomes.map((outcome) => ({
      ruleCode: outcome.ruleCode,
      severity: outcome.severity,
      passed: outcome.passed,
      message: outcome.message,
      detail: outcome.detail,
    }));

    const blockingFailures = results.filter(
      (result) => result.severity === 'blocking' && !result.passed,
    );
    const status = blockingFailures.length === 0 ? 'passed' : 'failed';

    await this.deps.orders.replaceValidations(headId, results);
    const nextStatus =
      status === 'passed'
        ? ['approved', 'published'].includes(head.status)
          ? head.status
          : 'validated'
        : 'downloaded';
    await this.deps.orders.updateHead(headId, {
      validationStatus: status,
      status: nextStatus,
    });

    return {
      headId,
      status,
      results,
      blockingFailures,
      warnings: results.filter((result) => result.severity === 'warning' && !result.passed),
      passedRules: results.filter((result) => result.passed).length,
      totalRules: results.length,
    };
  }
}
