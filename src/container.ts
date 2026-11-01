/**
 * Application container: wires the configuration, the database and every
 * service together.  Keeping this in one place makes the whole solution
 * usable from the HTTP API, the CLI and the test suite.
 */
import {
  loadConfig,
  odooSettings,
  shopifySettings,
  type AppConfig,
  type OdooSettings,
  type ShopifySettings,
} from './config.js';
import { createDb } from './db/factory.js';
import { runMigrations } from './db/migrate.js';
import type { Db } from './db/types.js';
import { ShopifyClient } from './integrations/shopify/client.js';
import { OdooClient } from './integrations/odoo/client.js';
import { AuditRepository } from './repositories/audit-repository.js';
import { MappingRepository } from './repositories/mapping-repository.js';
import { OrderRepository } from './repositories/order-repository.js';
import { SettingsRepository, type Settings } from './repositories/settings-repository.js';
import { UserRepository, type Role } from './repositories/user-repository.js';
import { ApprovalService } from './services/approval-service.js';
import { IngestionService } from './services/ingestion-service.js';
import { OdooGateway } from './services/odoo-gateway.js';
import { PublishService } from './services/publish-service.js';
import { ValidationService } from './services/validation-service.js';

export interface Container {
  config: AppConfig;
  db: Db;
  orders: OrderRepository;
  settingsRepo: SettingsRepository;
  auditRepo: AuditRepository;
  mappingRepo: MappingRepository;
  userRepo: UserRepository;
  validation: ValidationService;
  approval: ApprovalService;
  ingestion: IngestionService | null;
  publish: PublishService;
  shopify: { settings: ShopifySettings | null; client: ShopifyClient | null };
  odoo: { settings: OdooSettings | null; createClient: (protocol: 'xmlrpc' | 'jsonrpc') => OdooClient | null };
  defaultSettings: Settings;
  seed: () => Promise<void>;
  close: () => Promise<void>;
}

export function defaultSettingsFrom(config: AppConfig): Settings {
  return {
    approvalThresholdAmount: config.APPROVAL_THRESHOLD_AMOUNT,
    approvalThresholdCurrency: config.APPROVAL_THRESHOLD_CURRENCY,
    supportedCurrencies: config.SUPPORTED_CURRENCIES.split(',')
      .map((code) => code.trim().toUpperCase())
      .filter(Boolean),
    fallbackOdooProductId: config.FALLBACK_ODOO_PRODUCT_ID,
    fallbackOdooTaxId: config.FALLBACK_ODOO_TAX_ID,
    defaultUomId: config.DEFAULT_UOM_ID,
    companyId: undefined,
    warehouseId: undefined,
    pricelistId: undefined,
    paymentTermId: undefined,
    currencyId: undefined,
    confirmSaleOrder: config.CONFIRM_SALE_ORDER === 'true',
    createMissingPartner: config.ODOO_CREATE_MISSING_PARTNER === 'true',
    writeCustomFields: true,
    dmfUploadEnabled: false,
  };
}

export async function createContainer(
  config: AppConfig = loadConfig(),
  overrides: { db?: Db; shopifyClient?: ShopifyClient; odooClient?: OdooClient } = {},
): Promise<Container> {
  const db = overrides.db ?? (await createDb(config));
  await runMigrations(db);

  const orders = new OrderRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const auditRepo = new AuditRepository(db);
  const mappingRepo = new MappingRepository(db);
  const userRepo = new UserRepository(db);

  const defaultSettings = defaultSettingsFrom(config);

  const validation = new ValidationService({ orders, mappings: mappingRepo, settings: settingsRepo, defaultSettings });
  const approval = new ApprovalService({ orders, settings: settingsRepo, defaultSettings });

  const shopifyConfig = shopifySettings(config);
  const shopifyClient =
    overrides.shopifyClient ??
    (shopifyConfig
      ? new ShopifyClient({
          shopDomain: shopifyConfig.shopDomain,
          accessToken: shopifyConfig.accessToken,
          apiVersion: shopifyConfig.apiVersion,
          timeoutMs: shopifyConfig.timeoutMs,
          pageSize: shopifyConfig.pageSize,
          ...(shopifyConfig.fixturePath ? { fixturePath: shopifyConfig.fixturePath } : {}),
        })
      : null);

  const ingestion = shopifyClient
    ? new IngestionService({ client: shopifyClient, orders, audit: auditRepo })
    : null;

  const odooConfig = odooSettings(config);
  const createOdooClient = (protocol: 'xmlrpc' | 'jsonrpc'): OdooClient | null => {
    if (overrides.odooClient) return overrides.odooClient;
    if (!odooConfig) return null;
    return new OdooClient({
      url: odooConfig.url,
      db: odooConfig.db,
      username: odooConfig.username,
      password: odooConfig.password,
      protocol,
      timeoutMs: odooConfig.timeoutMs,
    });
  };

  const publish = new PublishService({
    orders,
    mappings: mappingRepo,
    settings: settingsRepo,
    audit: auditRepo,
    validation,
    approval,
    defaultSettings,
    createGateway: (method) => {
      const client = createOdooClient(method);
      if (!client) return null;
      return new OdooGateway(client, {
        createMissingPartner: odooConfig?.createMissingPartner ?? true,
        ...(defaultSettings.companyId ? { companyId: defaultSettings.companyId } : {}),
      });
    },
  });

  const seed = async (): Promise<void> => {
    const seeds: { key: string; role: Role; name: string; apiKey?: string }[] = [
      { key: 'ADMIN_API_KEY', role: 'admin', name: 'Solution administrator' },
      { key: 'OPERATOR_API_KEY', role: 'operator', name: 'Order operator' },
      { key: 'APPROVER_API_KEY', role: 'approver', name: 'Order approver' },
      { key: 'AUDITOR_API_KEY', role: 'auditor', name: 'Auditor' },
    ];
    for (const seed of seeds) {
      const apiKey = config[seed.key as 'ADMIN_API_KEY'];
      if (!apiKey) continue;
      await userRepo.upsert(seed.name, seed.role, apiKey);
    }
  };

  return {
    config,
    db,
    orders,
    settingsRepo,
    auditRepo,
    mappingRepo,
    userRepo,
    validation,
    approval,
    ingestion,
    publish,
    shopify: { settings: shopifyConfig, client: shopifyClient },
    odoo: { settings: odooConfig, createClient: createOdooClient },
    defaultSettings,
    seed,
    close: async () => {
      await db.close();
    },
  };
}
