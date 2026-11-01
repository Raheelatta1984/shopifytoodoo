/**
 * Seeds the application users and the Shopify -> Odoo mappings.
 *
 *   npm run seed -- --admin-key xxx --operator-key yyy --product 42=SKU-1 --tax 3="GST 10%"
 */
import { createContainer } from '../container.js';
import { loadConfig } from '../config.js';
import { generateApiKey } from '../repositories/user-repository.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const container = await createContainer(loadConfig());

  const users: { name: string; role: 'admin' | 'operator' | 'approver' | 'auditor'; key?: string }[] = [
    { name: 'Solution administrator', role: 'admin' },
    { name: 'Order operator', role: 'operator' },
    { name: 'Order approver', role: 'approver' },
    { name: 'Auditor', role: 'auditor' },
  ];

  const keys: string[] = [];
  for (const user of users) {
    const flag = `--${user.role}-key`;
    const index = argv.indexOf(flag);
    const key = index >= 0 ? argv[index + 1] : undefined;
    keys.push(key ?? generateApiKey());
    await container.userRepo.upsert(user.name, user.role, key ?? keys[keys.length - 1]!);
  }

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--product') {
      const value = argv[index + 1] ?? '';
      const [odooProductId, sku] = value.split('=');
      if (odooProductId && sku) {
        await container.mappingRepo.upsertProduct({
          sku,
          odooProductId: Number(odooProductId),
          active: true,
        });
      }
      index += 1;
    }
    if (argv[index] === '--tax') {
      const value = argv[index + 1] ?? '';
      const separator = value.indexOf('=');
      const title = value.slice(0, separator);
      const odooTaxId = Number(value.slice(separator + 1));
      if (title && Number.isFinite(odooTaxId)) {
        await container.mappingRepo.upsertTax({ shopifyTaxTitle: title, odooTaxId });
      }
      index += 1;
    }
  }

  console.log('Seeded users:');
  for (const [position, user] of users.entries()) {
    console.log(`  ${user.role.padEnd(9)} ${keys[position]}`);
  }
  console.log('Products:', (await container.mappingRepo.listProducts()).length);
  console.log('Taxes:', (await container.mappingRepo.listTaxes()).length);

  await container.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
