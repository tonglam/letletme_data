import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const baseEnv = {
  ...process.env,
  DATABASE_URL: 'postgresql://localhost:5432/letletme_test',
  ENABLE_AUTH: 'true',
  NODE_ENV: 'production',
  CACHE_REDIS_HOST: '127.0.0.1',
  CACHE_REDIS_PORT: '6379',
  CACHE_REDIS_DB: '9',
  QUEUE_REDIS_HOST: '127.0.0.1',
  QUEUE_REDIS_PORT: '6379',
  QUEUE_REDIS_DB: '10',
};

async function runEnvCheck(dataApiKeyHashes: string): Promise<number> {
  const child = Bun.spawn(['bun', 'validate-env.ts'], {
    cwd: process.cwd(),
    env: { ...baseEnv, DATA_API_KEY_HASHES: dataApiKeyHashes },
    stderr: 'ignore',
    stdout: 'ignore',
  });
  return child.exited;
}

describe('production environment preflight', () => {
  test('rejects enabled API auth without a configured key digest', async () => {
    expect(await runEnvCheck('')).not.toBe(0);
  });

  test('accepts a valid SHA-256 API key digest', async () => {
    expect(await runEnvCheck('a'.repeat(64))).toBe(0);
  });

  test('validates identity and quiescence before migration, then publishes before restart', () => {
    const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
    const preflight = workflow.indexOf('bun run env:check');
    const identityContract = workflow.indexOf('bun run db:migration-contract');
    const stopServices = workflow.indexOf('docker compose stop -t 45 api worker');
    const quiescence = workflow.indexOf('bun run ops:assert-queue-quiescence');
    const migrate = workflow.indexOf('bun run db:migrate');
    const canonicalContract = workflow.indexOf('bun run db:migration-contract', migrate);
    const publishCore = workflow.indexOf('bun run cache:publish-core -- --execute');
    const replaceServices = workflow.indexOf('docker compose up -d', publishCore);

    expect(preflight).toBeGreaterThan(0);
    expect(identityContract).toBeGreaterThan(preflight);
    expect(stopServices).toBeGreaterThan(identityContract);
    expect(quiescence).toBeGreaterThan(stopServices);
    expect(migrate).toBeGreaterThan(quiescence);
    expect(canonicalContract).toBeGreaterThan(migrate);
    expect(publishCore).toBeGreaterThan(canonicalContract);
    expect(replaceServices).toBeGreaterThan(publishCore);
    expect(workflow).toContain('> "$HOME/.letletme-data-previous-image"');
  });

  test('restores stopped services when a pre-migration deployment gate rejects', () => {
    const deployScript = readFileSync('scripts/deploy.sh', 'utf8');

    expect(deployScript).toMatch(
      /if ! compose stop -t 45 api worker; then[\s\S]*?restore_stopped_services[\s\S]*?exit 1[\s\S]*?fi/,
    );
    expect(deployScript).toMatch(
      /if ! compose run --rm -T api bun run ops:assert-queue-quiescence; then[\s\S]*?restore_stopped_services[\s\S]*?exit 1[\s\S]*?fi/,
    );
    expect(deployScript).toMatch(/restore_stopped_services\(\)[\s\S]*?compose start api worker/);
  });

  test('keeps migration credentials out of API and worker services', () => {
    const compose = readFileSync('docker-compose.yml', 'utf8');
    const migrationService = compose.indexOf('  migration:');
    const apiService = compose.indexOf('  api:');
    const workerService = compose.indexOf('  worker:');
    const migrationEnv = compose.indexOf('${MIGRATION_ENV_FILE:-.env.migrate}');

    expect(migrationService).toBeGreaterThan(0);
    expect(migrationEnv).toBeGreaterThan(migrationService);
    expect(migrationEnv).toBeLessThan(apiService);
    expect(apiService).toBeLessThan(workerService);
  });
});
