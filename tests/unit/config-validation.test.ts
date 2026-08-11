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
    const identityContract = workflow.indexOf(
      'bun scripts/migration-login-contract.ts --preflight',
    );
    const configuredRuntimeUrl = workflow.indexOf('data_runtime_database_url=$(sed -n');
    const provisioningPreflight = workflow.indexOf(
      'bun run db:provision-runtime-logins --preflight',
    );
    const stopServices = workflow.indexOf('docker compose stop -t 45 api worker');
    const databaseQuiescence = workflow.indexOf(
      'bun scripts/assert-queue-quiescence.ts --database-only',
    );
    const redisQuiescence = workflow.indexOf('bun scripts/assert-queue-quiescence.ts --redis-only');
    const migrate = workflow.indexOf('bun run db:migrate');
    const canonicalContract = workflow.indexOf('bun run db:migration-contract', migrate);
    const provision = workflow.indexOf('bun run db:provision-runtime-logins', migrate);
    const publishCore = workflow.indexOf('bun run cache:publish-core -- --execute --allow-empty');
    const replaceServices = workflow.indexOf('docker compose up -d', publishCore);

    expect(preflight).toBeGreaterThan(0);
    expect(configuredRuntimeUrl).toBeGreaterThan(0);
    expect(configuredRuntimeUrl).toBeLessThan(preflight);
    expect(identityContract).toBeGreaterThan(preflight);
    expect(provisioningPreflight).toBeGreaterThan(identityContract);
    expect(stopServices).toBeGreaterThan(identityContract);
    expect(databaseQuiescence).toBeGreaterThan(stopServices);
    expect(redisQuiescence).toBeGreaterThan(databaseQuiescence);
    expect(migrate).toBeGreaterThan(redisQuiescence);
    expect(canonicalContract).toBeGreaterThan(migrate);
    expect(provision).toBeGreaterThan(canonicalContract);
    expect(publishCore).toBeGreaterThan(canonicalContract);
    expect(publishCore).toBeGreaterThan(provision);
    expect(replaceServices).toBeGreaterThan(publishCore);
    expect(workflow).toContain('runtime_env_file=$(mktemp)');
    expect(workflow).toContain('export ENV_FILE="$runtime_env_file"');
    expect(workflow).toContain('rotating the Data runtime credential');
    expect(workflow).toContain('openssl rand -base64 48');
    expect(workflow).toContain('bun scripts/format-runtime-database-url.ts replace-password');
    expect(workflow).toContain('DATA_RUNTIME_DB_PASSWORD=$data_runtime_database_password');
    expect(workflow).toContain('GRAPHQL_RUNTIME_DB_PASSWORD=$graphql_runtime_database_password');
    expect(workflow).toContain('RUNTIME_DATABASE');
    expect(workflow).toContain('sleep 60');
    expect(workflow).toMatch(
      /DATABASE_URL=\$data_runtime_database_url[\s\S]*?bun run cache:publish-core -- --execute --allow-empty/,
    );
    expect(workflow).toContain('> "$HOME/.letletme-data-previous-image"');
    expect(workflow).toContain('mv "$runtime_env_file" "$env_file"');
  });

  test('restores stopped services when a pre-migration deployment gate rejects', () => {
    const deployScript = readFileSync('scripts/deploy.sh', 'utf8');

    expect(deployScript).toMatch(
      /if ! compose stop -t 45 api worker; then[\s\S]*?restore_stopped_services[\s\S]*?exit 1[\s\S]*?fi/,
    );
    expect(deployScript).toMatch(
      /if ! compose run --rm -T migration bun scripts\/assert-queue-quiescence\.ts --database-only; then[\s\S]*?restore_stopped_services[\s\S]*?exit 1[\s\S]*?fi/,
    );
    const configuredRuntimeUrl = deployScript.indexOf('data_runtime_database_url=$(sed -n');
    expect(configuredRuntimeUrl).toBeGreaterThan(0);
    expect(deployScript).toContain('bun run db:provision-runtime-logins --preflight');
    expect(deployScript).toContain('bun run db:provision-runtime-logins;');
    expect(deployScript).toContain('openssl rand -base64 48');
    expect(deployScript).toContain('bun scripts/format-runtime-database-url.ts replace-password');
    expect(deployScript).toContain('sleep 60');
    expect(deployScript).toContain('runtime_env_file=$(mktemp)');
    expect(deployScript).toMatch(
      /if ! compose run --rm -T api bun scripts\/assert-queue-quiescence\.ts --redis-only; then[\s\S]*?restore_stopped_services[\s\S]*?exit 1[\s\S]*?fi/,
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
