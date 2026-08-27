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
  BUG_REPORT_SCREENSHOT_STORAGE_ENABLED: 'true',
  BUG_REPORT_SCREENSHOT_SUPABASE_URL: 'https://example.supabase.co',
  BUG_REPORT_SCREENSHOT_SUPABASE_SECRET_KEY: 'test-secret',
  BUG_REPORT_SCREENSHOT_BUCKET: 'bug-report-screenshots',
  BUG_REPORT_SCREENSHOT_RETENTION_DAYS: '90',
  FPL_RAW_SNAPSHOT_STORAGE_ENABLED: 'true',
  FPL_RAW_SNAPSHOT_SUPABASE_URL: 'https://example.supabase.co',
  FPL_RAW_SNAPSHOT_SUPABASE_SECRET_KEY: 'test-secret',
  FPL_RAW_SNAPSHOT_BUCKET: 'fpl-raw-snapshots',
  BUG_REPORT_STORAGE_INTERNAL_URL: 'https://web.example.test/api/internal/bug-report-storage',
  BUG_REPORT_CLEANUP_SECRET: 'c'.repeat(64),
  CONTENT_PIPELINE_ENABLED: 'false',
  CONTENT_PUBLICATION_ENABLED: 'false',
  BRIEFING_PUBLIC_ENABLED: 'false',
  CONTENT_EDITOR_API_KEY_HASHES: '',
  CONTENT_PUBLISHER_API_KEY_HASHES: '',
  BRIEFING_REVALIDATE_URL: '',
  BRIEFING_REVALIDATE_SECRET: '',
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

  test('rejects production when private screenshot retention is not configured', async () => {
    expect(
      await runEnvCheck('a'.repeat(64), {
        BUG_REPORT_SCREENSHOT_STORAGE_ENABLED: 'false',
      }),
    ).not.toBe(0);
    expect(
      await runEnvCheck('a'.repeat(64), {
        BUG_REPORT_SCREENSHOT_BUCKET: 'public-bucket',
      }),
    ).not.toBe(0);
  });

  test('accepts a valid SHA-256 API key digest', async () => {
    expect(await runEnvCheck('a'.repeat(64))).toBe(0);
  });

  test('rejects production when immutable FPL raw snapshot storage is not configured', async () => {
    expect(
      await runEnvCheck('a'.repeat(64), {
        FPL_RAW_SNAPSHOT_STORAGE_ENABLED: 'false',
      }),
    ).not.toBe(0);
    expect(
      await runEnvCheck('a'.repeat(64), {
        FPL_RAW_SNAPSHOT_BUCKET: 'mutable-market-cache',
      }),
    ).not.toBe(0);
  });

  test('rejects malformed content role hashes and incomplete publication settings', async () => {
    const digest = 'a'.repeat(64);
    expect(await runEnvCheck(digest, { CONTENT_EDITOR_API_KEY_HASHES: 'not-a-digest' })).not.toBe(
      0,
    );
    expect(
      await runEnvCheck(digest, {
        CONTENT_PIPELINE_ENABLED: 'true',
        CONTENT_PUBLICATION_ENABLED: 'true',
      }),
    ).not.toBe(0);
    expect(
      await runEnvCheck(digest, {
        CONTENT_PIPELINE_ENABLED: 'true',
        CONTENT_PUBLICATION_ENABLED: 'true',
        CONTENT_PUBLISHER_API_KEY_HASHES: 'b'.repeat(64),
        BRIEFING_REVALIDATE_URL: 'https://web.example.test/api/briefing/revalidate',
        BRIEFING_REVALIDATE_SECRET: 's'.repeat(32),
      }),
    ).toBe(0);
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

    expect(await runEnvCheck(digest, { DATABASE_POOL_MAX: '3' })).toBe(0);
    expect(await runEnvCheck(digest, { DATABASE_POOL_MAX: '0' })).not.toBe(0);
    expect(await runEnvCheck(digest, { DATABASE_POOL_MAX: '6' })).not.toBe(0);
  });

  test('rejects non-positive and unbounded queue governance intervals', async () => {
    const digest = 'a'.repeat(64);
    expect(await runEnvCheck(digest, { QUEUE_HEALTH_SNAPSHOT_INTERVAL_MS: '0' })).not.toBe(0);
    expect(await runEnvCheck(digest, { QUEUE_HEALTH_WINDOW_INTERVAL_MS: '-1' })).not.toBe(0);
    expect(await runEnvCheck(digest, { QUEUE_ADMISSION_GREEN_CLEAR_MS: '999999999999' })).not.toBe(
      0,
    );
    expect(
      await runEnvCheck(digest, {
        QUEUE_HEALTH_SNAPSHOT_INTERVAL_MS: '15000',
        QUEUE_HEALTH_WINDOW_INTERVAL_MS: '60000',
        QUEUE_ADMISSION_GREEN_CLEAR_MS: '300000',
      }),
    ).toBe(0);
  });

  test('requires the server-side consumer evidence writer before enabling probes', async () => {
    const digest = 'a'.repeat(64);
    expect(
      await runEnvCheck(digest, {
        FRESHNESS_CONSUMER_PROBES_ENABLED: 'true',
      }),
    ).not.toBe(0);
    expect(
      await runEnvCheck(digest, {
        FRESHNESS_CONSUMER_PROBES_ENABLED: 'true',
        DATA_GOVERNANCE_WEB_URL: 'https://web.example.test',
        DATA_GOVERNANCE_PROBE_TOKEN: 'p'.repeat(32),
      }),
    ).toBe(0);
  });

  test('uses bounded preflight, verifies roles read-only, and publishes before restart', () => {
    const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
    const preflight = workflow.indexOf('bun run env:check');
    const screenshotProbe = workflow.indexOf('--probe-bug-report-storage');
    const fplSourceProbe = workflow.indexOf('--probe-fpl-raw-snapshot-storage');
    const identityContract = workflow.indexOf('bun scripts/wait-for-migration-login.ts');
    const configuredRuntimeUrl = workflow.indexOf('data_runtime_database_url=$(sed -n');
    const stopServices = workflow.indexOf(
      'APP_IMAGE="$IMAGE_REF" docker compose stop -t 45 api worker',
      identityContract,
    );
    const databaseQuiescence = workflow.indexOf(
      'bun scripts/assert-queue-quiescence.ts --database-only --scoped',
    );
    const redisQuiescence = workflow.indexOf(
      'bun scripts/assert-queue-quiescence.ts --redis-only --scoped',
    );
    const migrate = workflow.indexOf('bun run db:migrate');
    const canonicalContract = workflow.indexOf('bun run db:migration-contract', migrate);
    const roleVerify = workflow.indexOf('bun run db:verify-runtime-logins', migrate);
    const publishCore = workflow.indexOf('bun run cache:publish-core -- --execute --allow-empty');
    const replaceServices = workflow.indexOf('docker compose up -d', publishCore);

    expect(preflight).toBeGreaterThan(0);
    expect(screenshotProbe).toBeGreaterThan(preflight);
    expect(fplSourceProbe).toBeGreaterThan(screenshotProbe);
    expect(fplSourceProbe).toBeLessThan(identityContract);
    expect(configuredRuntimeUrl).toBeGreaterThan(0);
    expect(configuredRuntimeUrl).toBeLessThan(preflight);
    expect(identityContract).toBeGreaterThan(preflight);
    expect(stopServices).toBeGreaterThan(identityContract);
    expect(databaseQuiescence).toBeLessThan(stopServices);
    expect(redisQuiescence).toBeLessThan(stopServices);
    const postStopDatabaseQuiescence = workflow.indexOf(
      'bun scripts/assert-queue-quiescence.ts --database-only --scoped',
      stopServices,
    );
    const postStopRedisQuiescence = workflow.indexOf(
      'bun scripts/assert-queue-quiescence.ts --redis-only --scoped',
      stopServices,
    );
    expect(postStopDatabaseQuiescence).toBeGreaterThan(stopServices);
    expect(postStopRedisQuiescence).toBeGreaterThan(postStopDatabaseQuiescence);
    expect(migrate).toBeGreaterThan(postStopRedisQuiescence);
    expect(canonicalContract).toBeGreaterThan(migrate);
    expect(roleVerify).toBeGreaterThan(canonicalContract);
    expect(publishCore).toBeGreaterThan(canonicalContract);
    expect(publishCore).toBeGreaterThan(roleVerify);
    expect(replaceServices).toBeGreaterThan(publishCore);
    expect(workflow).toContain('using the configured Data runtime URL without rewriting it');
    expect(workflow).not.toContain('letletme-vps-ops');
    expect(workflow).not.toContain('flock -w 300 9');
    expect(workflow).toContain('deployment_started=true');
    expect(workflow).toContain('services_stopped=false');
    expect(workflow).toContain('services_stopped=true');
    expect(workflow).not.toContain('restore_before_migration');
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
    expect(workflow).toContain('read_env_setting DATABASE_BACKUP_DIR "$env_file"');
    expect(workflow).toContain('export DATABASE_BACKUP_KEEP=${DATABASE_BACKUP_KEEP:-7}');
  });

  test('restores stopped services when a pre-migration deployment gate rejects', () => {
    const deployScript = readFileSync('scripts/deploy.sh', 'utf8');
    const stopServices = deployScript.indexOf('if ! compose stop -t 45 api worker; then');
    const databaseQuiescenceCommand =
      'compose run --rm -T migration bun scripts/assert-queue-quiescence.ts --database-only --scoped';
    const redisQuiescenceCommand =
      'compose run --rm -T api bun scripts/assert-queue-quiescence.ts --redis-only --scoped';
    const databaseQuiescenceBeforeStop = deployScript.lastIndexOf(
      databaseQuiescenceCommand,
      stopServices,
    );
    const redisQuiescenceBeforeStop = deployScript.lastIndexOf(
      redisQuiescenceCommand,
      stopServices,
    );
    const databaseQuiescenceAfterStop = deployScript.indexOf(
      databaseQuiescenceCommand,
      stopServices,
    );
    const redisQuiescenceAfterStop = deployScript.indexOf(redisQuiescenceCommand, stopServices);

    expect(databaseQuiescenceBeforeStop).toBeGreaterThan(0);
    expect(redisQuiescenceBeforeStop).toBeGreaterThan(databaseQuiescenceBeforeStop);
    expect(databaseQuiescenceBeforeStop).toBeLessThan(stopServices);
    expect(redisQuiescenceBeforeStop).toBeLessThan(stopServices);
    expect(databaseQuiescenceAfterStop).toBeGreaterThan(stopServices);
    expect(redisQuiescenceAfterStop).toBeGreaterThan(databaseQuiescenceAfterStop);

    expect(deployScript).toMatch(
      /if ! compose stop -t 45 api worker; then[\s\S]*?restore_stopped_services[\s\S]*?exit 1[\s\S]*?fi/,
    );
    expect(deployScript).toMatch(
      /if ! compose stop -t 45 content-worker; then[\s\S]*?restore_stopped_services[\s\S]*?exit 1[\s\S]*?fi/,
    );
    expect(deployScript).toMatch(
      /if ! compose stop -t 45 media-worker; then[\s\S]*?restore_stopped_services[\s\S]*?exit 1[\s\S]*?fi/,
    );
    expect(deployScript).toMatch(
      /if ! compose run --rm -T migration bun scripts\/assert-queue-quiescence\.ts --database-only --scoped; then[\s\S]*?restore_stopped_services[\s\S]*?exit 1[\s\S]*?fi/,
    );
    const configuredRuntimeUrl = deployScript.indexOf('data_runtime_database_url=$(sed -n');
    expect(configuredRuntimeUrl).toBeGreaterThan(0);
    expect(deployScript).toContain('bun scripts/wait-for-migration-login.ts');
    expect(deployScript).toContain('bun validate-env.ts --probe-bug-report-storage');
    expect(deployScript).toContain('bun validate-env.ts --probe-fpl-raw-snapshot-storage');
    expect(deployScript).toContain('bun run db:verify-runtime-logins');
    expect(deployScript).not.toContain('GRAPHQL_RUNTIME_DB_PASSWORD');
    expect(deployScript).not.toContain('db:provision-runtime-logins');
    expect(deployScript).not.toContain('sleep 60');
    expect(deployScript).toMatch(
      /if ! compose run --rm -T api bun scripts\/assert-queue-quiescence\.ts --redis-only --scoped; then[\s\S]*?restore_stopped_services[\s\S]*?exit 1[\s\S]*?fi/,
    );
    expect(deployScript).toContain(
      '"$DEPLOY_OLD_IMAGE" "$DEPLOY_OLD_RELEASE_SHA" "$DEPLOY_OLD_RUNNER_RELEASE_SHA"',
    );
    expect(deployScript).toMatch(/restore_stopped_services\(\)[\s\S]*?start_all_runtime_services/);
    const stateMachine = readFileSync('scripts/deploy-state-machine.sh', 'utf8');
    expect(stateMachine).toContain('runtime_worker_services');
    expect(stateMachine).toContain(String.raw`grep -x 'media-worker' >/dev/null`);
    expect(stateMachine).not.toContain(String.raw`grep -qx 'media-worker'`);
    expect(stateMachine).toContain('RUNTIME_INCLUDE_MEDIA_WORKER');
    expect(stateMachine).toContain('start_all_runtime_services');
    expect(stateMachine).toContain('export APP_IMAGE="$previous_image"');
    expect(deployScript).toContain('DEPLOY_OLD_MEDIA_PRESENT');
    expect(deployScript).toContain('load_backup_settings');
    expect(deployScript).toContain('read_env_setting DATABASE_BACKUP_DIR "$ENV_FILE"');
    expect(deployScript).toContain('DEPLOY_COMMITTED=false');
    expect(deployScript).toContain('DEPLOY_SERVICES_STOPPED=false');
    expect(deployScript).toContain('DEPLOY_SERVICES_STOPPED=true');
    expect(deployScript).toContain(
      '"$DEPLOY_COMMITTED" = false && "$DEPLOY_SERVICES_STOPPED" = true',
    );
    expect(deployScript).not.toContain('git -C "$PROJECT_DIR" reset --hard');
    expect(deployScript).toContain('deploy-host-grok-runner.sh');
    expect(deployScript).toContain('run-briefing-control-probe.sh');
    expect(deployScript).toContain('rearm-briefing-x-after-probe.sh');
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
    const migrationEnv = compose.indexOf('${MIGRATION_ENV_FILE:-.env.migrate}', migrationService);

    expect(migrationService).toBeGreaterThan(0);
    expect(migrationEnv).toBeGreaterThan(migrationService);
    expect(migrationEnv).toBeLessThan(apiService);
    expect(apiService).toBeLessThan(workerService);
    expect(compose).toContain(
      'postgres:15@sha256:6eb0add3b77c081df18aa518ce43df58fdcc40f2e6d868a6fd08038dc7acd425',
    );
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
