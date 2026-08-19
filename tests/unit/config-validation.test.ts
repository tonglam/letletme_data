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

async function runEnvCheck(
  dataApiKeyHashes: string,
  overrides: Record<string, string> = {},
): Promise<number> {
  const child = Bun.spawn(['bun', 'validate-env.ts'], {
    cwd: process.cwd(),
    env: { ...baseEnv, DATA_API_KEY_HASHES: dataApiKeyHashes, ...overrides },
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

  test('treats blank WeChat token as unset and still fail-closes production URL without token', async () => {
    const digest = 'a'.repeat(64);
    const wechatUrl = 'https://bot.example.test/notification';

    expect(
      await runEnvCheck('', {
        NODE_ENV: 'test',
        ENABLE_AUTH: 'false',
        WECHAT_NOTIFICATION_URL: wechatUrl,
        WECHAT_NOTIFICATION_API_TOKEN: '',
      }),
    ).toBe(0);

    expect(
      await runEnvCheck(digest, {
        WECHAT_NOTIFICATION_URL: wechatUrl,
        WECHAT_NOTIFICATION_API_TOKEN: '',
      }),
    ).not.toBe(0);
  });

  test('keeps each process pool within the shared Supavisor session budget', async () => {
    const digest = 'a'.repeat(64);

    expect(await runEnvCheck(digest, { DATABASE_POOL_MAX: '5' })).toBe(0);
    expect(await runEnvCheck(digest, { DATABASE_POOL_MAX: '0' })).not.toBe(0);
    expect(await runEnvCheck(digest, { DATABASE_POOL_MAX: '6' })).not.toBe(0);
  });

  test('uses bounded preflight, verifies roles read-only, and publishes before restart', () => {
    const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
    const preflight = workflow.indexOf('bun run env:check');
    const identityContract = workflow.indexOf('bun scripts/wait-for-migration-login.ts');
    const configuredRuntimeUrl = workflow.indexOf('data_runtime_database_url=$(sed -n');
    const stopServices = workflow.indexOf(
      'APP_IMAGE="$IMAGE_REF" docker compose stop -t 45 api worker',
      identityContract,
    );
    const databaseQuiescence = workflow.indexOf(
      'bun scripts/assert-queue-quiescence.ts --database-only',
    );
    const redisQuiescence = workflow.indexOf('bun scripts/assert-queue-quiescence.ts --redis-only');
    const migrate = workflow.indexOf('bun run db:migrate');
    const canonicalContract = workflow.indexOf('bun run db:migration-contract', migrate);
    const roleVerify = workflow.indexOf('bun run db:verify-runtime-logins', migrate);
    const publishCore = workflow.indexOf('bun run cache:publish-core -- --execute --allow-empty');
    const replaceServices = workflow.indexOf('docker compose up -d', publishCore);

    expect(preflight).toBeGreaterThan(0);
    expect(configuredRuntimeUrl).toBeGreaterThan(0);
    expect(configuredRuntimeUrl).toBeLessThan(preflight);
    expect(identityContract).toBeGreaterThan(preflight);
    expect(stopServices).toBeGreaterThan(identityContract);
    expect(databaseQuiescence).toBeGreaterThan(stopServices);
    expect(redisQuiescence).toBeGreaterThan(databaseQuiescence);
    expect(migrate).toBeGreaterThan(redisQuiescence);
    expect(canonicalContract).toBeGreaterThan(migrate);
    expect(roleVerify).toBeGreaterThan(canonicalContract);
    expect(publishCore).toBeGreaterThan(canonicalContract);
    expect(publishCore).toBeGreaterThan(roleVerify);
    expect(replaceServices).toBeGreaterThan(publishCore);
    expect(workflow).toContain('using the configured Data runtime URL without rewriting it');
    expect(workflow).not.toContain('letletme-vps-ops');
    expect(workflow).not.toContain('flock -w 300 9');
    expect(workflow).toContain('deployment_started=true');
    expect(workflow).not.toContain('/usr/local/libexec/vps-maintenance');
    expect(workflow).not.toContain('GRAPHQL_RUNTIME_DB_PASSWORD');
    expect(workflow).not.toContain('GRAPHQL_RUNTIME_DATABASE_URL');
    expect(workflow).not.toContain('db:provision-runtime-logins');
    expect(workflow).not.toContain('sleep 60');
    for (const stage of [
      'pull',
      'preflight',
      'quiescence',
      'migration',
      'roleVerify',
      'cachePublish',
      'serviceReady',
    ]) {
      expect(workflow).toContain(`start_stage ${stage}`);
    }
    expect(workflow).toMatch(
      /DATABASE_URL=\$data_runtime_database_url[\s\S]*?bun run cache:publish-core -- --execute --allow-empty/,
    );
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
    const configuredRuntimeUrl = deployScript.indexOf('data_runtime_database_url=$(sed -n');
    expect(configuredRuntimeUrl).toBeGreaterThan(0);
    expect(deployScript).toContain('bun scripts/wait-for-migration-login.ts');
    expect(deployScript).toContain('bun run db:verify-runtime-logins');
    expect(deployScript).not.toContain('GRAPHQL_RUNTIME_DB_PASSWORD');
    expect(deployScript).not.toContain('db:provision-runtime-logins');
    expect(deployScript).not.toContain('sleep 60');
    expect(deployScript).toMatch(
      /if ! compose run --rm -T api bun scripts\/assert-queue-quiescence\.ts --redis-only; then[\s\S]*?restore_stopped_services[\s\S]*?exit 1[\s\S]*?fi/,
    );
    expect(deployScript).toMatch(/restore_stopped_services\(\)[\s\S]*?compose start api worker/);
  });

  test('keeps ordinary workflows passwordless and proves verifier immutability in CI', () => {
    const deployWorkflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
    const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    const runtimeScripts = [
      readFileSync('scripts/runtime-login-contract.ts', 'utf8'),
      readFileSync('scripts/verify-runtime-logins.ts', 'utf8'),
      readFileSync('scripts/bootstrap-runtime-login.ts', 'utf8'),
    ].join('\n');

    expect(deployWorkflow).not.toContain('RUNTIME_DB_PASSWORD');
    expect(runtimeScripts).not.toMatch(/ALTER\s+ROLE[\s\S]*PASSWORD/i);
    expect(runtimeScripts).not.toContain('--rotate-existing-passwords');
    expect(runtimeScripts).not.toContain('RUNTIME_LOGIN_ROTATION_ACK');
    expect(ciWorkflow).toContain('password_hashes_before=');
    expect(ciWorkflow).toContain('password_hashes_after=');
    expect(ciWorkflow).toContain('test "$password_hashes_before" = "$password_hashes_after"');
    expect(ciWorkflow).toContain('SHARED_GRAPHQL_RUNTIME_DATABASE_URL');
    expect(ciWorkflow).toContain('bootstrap accepted a password already used');
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

  test('reuses the immutable active core cache before reading mutable database tables', () => {
    const publishScript = readFileSync('scripts/publish-core-cache.ts', 'utf8');
    const canonicalManifest = publishScript.indexOf('parseDataPublicationManifest');
    const readActiveCache = publishScript.indexOf('readCoreSnapshotCache', canonicalManifest);
    const decideDeployment = publishScript.indexOf('decideCoreCacheDeployment', readActiveCache);
    const readMutableEvents = publishScript.indexOf('eventRepository.findAll', decideDeployment);
    const validateRebuild = publishScript.indexOf(
      'assertCoreCacheRebuildCandidate',
      readMutableEvents,
    );

    expect(canonicalManifest).toBeGreaterThan(0);
    expect(readActiveCache).toBeGreaterThan(canonicalManifest);
    expect(decideDeployment).toBeGreaterThan(readActiveCache);
    expect(readMutableEvents).toBeGreaterThan(decideDeployment);
    expect(validateRebuild).toBeGreaterThan(readMutableEvents);
    expect(publishScript).not.toContain('sourceCheckedAt: publication.activatedAt');
  });

  test('keeps the gated VPS cleanup exact, atomic, and value-blind', () => {
    const workflow = readFileSync('.github/workflows/cleanup-legacy-runtime-secret.yml', 'utf8');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toMatch(/if: github\.ref == 'refs\/heads\/main'/);
    expect(workflow).toContain('group: deploy-main');
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain('appleboy/ssh-action@0ff4204d59e8e51228ff73bce53f80d53301dee2');
    expect(workflow).toContain('expected_workdir=/home/workspace/letletme_data');
    expect(workflow).toContain('target_file="$expected_workdir/.env.migrate"');
    expect(workflow).toContain('test ! -L "$target_file"');
    expect(workflow).toMatch(/stat -c '%h'/);
    expect(workflow).toContain('case "$legacy_count" in');
    expect(workflow).toContain('cleanup refused: multiple legacy assignments exist');
    expect(workflow).toContain('mktemp "$expected_workdir/.env.migrate.cleanup.XXXXXX"');
    expect(workflow).toContain('rm -f -- "$temporary_file"');
    expect(workflow).toContain('mv --no-target-directory -- "$temporary_file" "$target_file"');
    expect(workflow).toContain('test "$database_url_count" -eq 1');
    expect(workflow).toContain('"credentialValueExposed":false');
    expect(workflow).not.toContain('cat "$target_file"');
    expect(workflow).not.toMatch(/cp\s+[^\n]*\$target_file/);
    expect(workflow).not.toContain('ALTER ROLE');
  });
});
