/**
 * End to end command line runner.
 *
 *   npm run sync -- --query "updated_at:>=2026-10-01 status:any" --publish xmlrpc
 *
 * It downloads the orders from Shopify, validates them, applies the approval
 * threshold and (optionally) publishes the sales orders to Odoo.
 */
import { createContainer } from '../container.js';
import { loadConfig } from '../config.js';
import type { Role } from '../repositories/user-repository.js';

interface Options {
  query?: string;
  limit?: number;
  publish?: 'xmlrpc' | 'jsonrpc' | 'dmf';
  validate: boolean;
  actor: string;
  role: Role;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    validate: true,
    actor: 'cli',
    role: 'admin',
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case '--query':
        options.query = next;
        index += 1;
        break;
      case '--limit':
        options.limit = Number(next);
        index += 1;
        break;
      case '--publish':
        options.publish = next as Options['publish'];
        index += 1;
        break;
      case '--no-validate':
        options.validate = false;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--actor':
        options.actor = next ?? 'cli';
        index += 1;
        break;
      case '--role':
        options.role = (next as Role) ?? 'admin';
        index += 1;
        break;
      default:
        break;
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const container = await createContainer(loadConfig());
  await container.seed();

  try {
    if (!container.ingestion) {
      throw new Error(
        'Shopify is not configured. Set SHOPIFY_SHOP_DOMAIN and SHOPIFY_ACCESS_TOKEN (or SHOPIFY_FIXTURE).',
      );
    }

    console.log('> downloading orders from Shopify');
    const report = await container.ingestion.ingest({
      ...(options.query ? { query: options.query } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      actor: options.actor,
      role: options.role,
    });
    console.log(
      `  received=${report.received} created=${report.created} updated=${report.updated} failed=${report.failed}`,
    );

    const { items } = await container.orders.listHeads({ limit: 500 });
    let published = 0;
    let validated = 0;
    let blocked = 0;

    for (const head of items) {
      if (options.validate) {
        const validation = await container.validation.validate(head.id);
        if (validation.status === 'passed') validated += 1;
        else {
          blocked += 1;
          console.log(
            `  ! order ${head.sourceOrderId} failed validation: ${validation.blockingFailures
              .map((failure) => `${failure.ruleCode} ${failure.message}`)
              .join('; ')}`,
          );
          continue;
        }
      }

      if (!options.publish || options.dryRun) continue;

      const result = await container.publish.publish(head.id, {
        method: options.publish,
        actor: options.actor,
        role: options.role,
      });
      if (result.status === 'published' || result.status === 'artifact_ready') {
        published += 1;
        console.log(
          `  published order ${head.sourceOrderId} -> odoo sale order ${result.odooSaleOrderId ?? 'n/a'} (${result.status})`,
        );
      } else {
        console.log(`  ! order ${head.sourceOrderId} was not published: ${result.error ?? result.status}`);
      }
    }

    console.log(
      `> done: validated=${validated} blocked=${blocked} published=${published}`,
    );
    if (blocked > 0) process.exitCode = 2;
  } finally {
    await container.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
