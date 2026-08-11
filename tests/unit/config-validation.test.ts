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
    const provisioningPreflight = workflow.indexOf(
      'bun run db:provision-runtime-logins --preflight',
    );
    const runtimeUrl = workflow.indexOf(
      'data_runtime_database_url=$(env_file_value DATABASE_URL "$env_file")',
    );
    const graphqlRuntimeUrl = workflow.search(
      /graphql_runtime_database_url=\$\(env_file_value GRAPHQL_RUNTIME_DATABASE_URL "\$migration_env_file"\)/,
    );
    const stopServices = workflow.indexOf('docker compose stop -t 45 api worker');
    const databaseQuiescence = workflow.indexOf(
      'bun scripts/assert-queue-quiescence.ts --database-only',
    );
    const redisQuiescence = workflow.indexOf('bun scripts/assert-queue-quiescence.ts --redis-only');
    const migrate = workflow.indexOf('bun run db:migrate');
    const provision = workflow.indexOf('bun run db:provision-runtime-logins', migrate);
    const canonicalContract = workflow.indexOf('bun run db:migration-contract', migrate);
    const publishCore = workflow.indexOf('bun run cache:publish-core -- --execute --allow-empty');
    const replaceServices = workflow.indexOf('docker compose up -d', publishCore);

    expect(preflight).toBeGreaterThan(0);
    expect(identityContract).toBeGreaterThan(preflight);
    expect(runtimeUrl).toBeGreaterThan(identityContract);
    expect(graphqlRuntimeUrl).toBeGreaterThan(runtimeUrl);
    expect(provisioningPreflight).toBeGreaterThan(identityContract);
    expect(provisioningPreflight).toBeGreaterThan(graphqlRuntimeUrl);
    expect(stopServices).toBeGreaterThan(provisioningPreflight);
    expect(databaseQuiescence).toBeGreaterThan(stopServices);
    expect(redisQuiescence).toBeGreaterThan(databaseQuiescence);
    expect(migrate).toBeGreaterThan(redisQuiescence);
    expect(provision).toBeGreaterThan(migrate);
    expect(canonicalContract).toBeGreaterThan(provision);
    expect(publishCore).toBeGreaterThan(canonicalContract);
    expect(replaceServices).toBeGreaterThan(publishCore);
    expect(workflow).toContain('docker ps --filter label=com.docker.compose.service=graphql');
    expect(workflow).toContain('> "$HOME/.letletme-data-previous-image"');
  });

  test('restores stopped services when a pre-migration deployment gate rejects', () => {
    const deployScript = readFileSync('scripts/deploy.sh', 'utf8');

    expect(deployScript).toMatch(
      /if ! compose stop -t 45 api worker; then[\s\S]*?restore_stopped_services[\s\S]*?exit 1[\s\S]*?fi/,
    );
    expect(deployScript).toMatch(
      /if ! compose run --rm -T migration bun scripts\/assert-queue-quiescence\.ts --database-only; then[\s\S]*?restore_stopped_services[\s\S]*?exit 1[\s\S]*?fi/,
    );
    expect(deployScript).toMatch(
      /bun scripts\/migration-login-contract\.ts --preflight[\s\S]*?bun run db:provision-runtime-logins --preflight[\s\S]*?compose stop -t 45 api worker/,
    );
    expect(deployScript).toMatch(
      /data_runtime_database_url=\$\(compose run --rm -T api bun -e[\s\S]*?DATA_RUNTIME_DATABASE_URL=\$\{data_runtime_database_url\}/,
    );
    expect(deployScript).toMatch(
      /(docker compose ps -q graphql|docker ps --filter label=com\.docker\.compose\.service=graphql)[\s\S]*?GRAPHQL_RUNTIME_DATABASE_URL=\$\{graphql_runtime_database_url\}/,
    );
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
