/**
 * Applies the environment variables of the service to the Vercel projects.
 *
 *   npm run vercel:env -- --plan                       # print what would be done
 *   npm run vercel:env -- --env-file .env.vercel.local --apply
 *
 * The values are read from the environment or from an env file (which must
 * stay out of git); the API keys are generated when they are missing.  The
 * secrets are piped to the Vercel CLI, so they never appear in the process
 * list nor in the shell history.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { buildEnvPlan, envAddCommand, missingVariables, parseEnvFile } from './vercel-env.js';

const DEFAULT_PROJECTS = ['shopifytoodoo', 'shopifytoodoo2'];

function parseArgs(argv: string[]): {
  projects: string[];
  envFile?: string;
  apply: boolean;
  targets: ('production' | 'preview')[];
} {
  const projects: string[] = [];
  let envFile: string | undefined;
  let apply = false;
  const targets: ('production' | 'preview')[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      const value = argv[index + 1];
      if (value) projects.push(value);
      index += 1;
    } else if (arg === '--env-file') {
      envFile = argv[index + 1];
      index += 1;
    } else if (arg === '--target') {
      const value = argv[index + 1];
      if (value === 'production' || value === 'preview') targets.push(value);
      index += 1;
    } else if (arg === '--apply') {
      apply = true;
    }
  }

  return {
    projects: projects.length ? projects : DEFAULT_PROJECTS,
    envFile,
    apply,
    targets: targets.length ? targets : ['production', 'preview'],
  };
}

function run(command: string, args: string[], stdinValue: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
    child.stdin.write(stdinValue);
    child.stdin.end();
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const fromFile = options.envFile
    ? parseEnvFile(readFileSync(options.envFile, 'utf8'))
    : {};
  const values = { ...fromFile };
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('VERCEL_ENV_') && value) {
      values[name.replace('VERCEL_ENV_', '')] = value;
    }
  }

  const missing = missingVariables(values);
  const plan = buildEnvPlan({
    values,
    projects: options.projects,
    targets: options.targets,
  });

  console.log('Projects :', options.projects.join(', '));
  console.log('Targets  :', options.targets.join(', '));
  console.log('Variables:', plan.entries.length);
  if (missing.length) {
    console.log('\nMissing (required):');
    for (const name of missing) console.log(`  - ${name}`);
    console.log(
      '\nSet them in the environment, in the env file, or add them by hand in the ' +
        'Vercel dashboard (Settings -> Environment Variables).',
    );
  }

  if (!options.apply) {
    console.log('\nDry run — nothing was changed. Add --apply to execute the plan.');
    console.log('\nThe API keys that were generated (keep them secret):');
    for (const spec of ['ADMIN_API_KEY', 'OPERATOR_API_KEY', 'APPROVER_API_KEY', 'AUDITOR_API_KEY']) {
      if (plan.values[spec]) console.log(`  ${spec}=${plan.values[spec]}`);
    }
    return;
  }

  console.log('\nApplying…');
  for (const entry of plan.entries) {
    const { command, args } = envAddCommand(entry);
    const label = `${entry.project}/${entry.target}/${entry.name}`;
    process.stdout.write(`  ${label} … `);
    const code = await run(command, args, entry.value);
    if (code !== 0) {
      console.log('FAILED');
      throw new Error(`vercel env add failed for ${label} (exit code ${code})`);
    }
    console.log('ok');
  }
  console.log('\nDone. Redeploy the projects so that the new variables are applied.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
