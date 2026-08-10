import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
const quote = String.fromCharCode(39);

function job(name: string, nextName?: string): string {
  const start = workflow.indexOf(`\n  ${name}:`);
  if (start < 0) throw new Error(`Missing workflow job ${name}`);
  const end = nextName ? workflow.indexOf(`\n  ${nextName}:`, start + 1) : workflow.length;
  if (end < 0) throw new Error(`Missing workflow job ${nextName}`);
  return workflow.slice(start, end);
}

function runtimeEnvPython(): string {
  const quote = String.fromCharCode(39);
  const marker = '            python3 - .env.deploy "$env_tmp" <<' + quote + 'PY' + quote + '\n';
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error('Missing runtime env Python start marker');
  const bodyStart = start + marker.length;
  const end = workflow.indexOf('\n            PY', bodyStart);
  if (end < 0) throw new Error('Missing runtime env Python end marker');
  return workflow
    .slice(bodyStart, end)
    .split('\n')
    .map((line) => (line.startsWith('            ') ? line.slice(12) : line))
    .join('\n');
}

describe('v3 production hard-cut workflow', () => {
  test('resolves manual production operations only from protected main', () => {
    expect(workflow).toContain('repository_dispatch:');
    expect(workflow).toContain('- v3-data-production-operation');
    expect(workflow).not.toContain('workflow_dispatch:');
    expect(workflow).not.toContain('inputs.');
  });

  test('lets strict shell mode evaluate compound conditions as one script', () => {
    const jobNames = [
      ['v3_preflight', 'v3_activate_database'],
      ['v3_activate_database', 'v3_redis_queues'],
      ['v3_redis_queues', 'v3_core_cache'],
      ['v3_core_cache', 'v3_start_api'],
      ['v3_start_api', 'v3_start_worker'],
      ['v3_start_worker', 'v3_redeploy'],
      ['v3_redeploy', 'v3_status'],
      ['v3_status', 'v3_terminal_acceptance'],
      ['v3_terminal_acceptance', 'v3_stop'],
    ] as const;

    for (const [name, nextName] of jobNames) {
      const contents = job(name, nextName);
      expect(contents).not.toContain('script_stop:');
      expect(contents).toContain('set -euo pipefail');
    }
    expect(job('v3_stop')).not.toContain('script_stop:');
  });

  test('keeps the VPS preflight read-only', () => {
    const preflight = job('v3_preflight', 'v3_activate_database');

    for (const mutation of [
      'git fetch',
      'git reset',
      'docker compose pull',
      'docker compose run',
      'docker compose up',
      'docker compose stop',
    ]) {
      expect(preflight).not.toContain(mutation);
    }
    expect(preflight).toContain('docker compose ps --all');
  });

  test('publishes only protected main before registry login or candidate execution', () => {
    const deploy = job('deploy', 'v3_publish_image');
    const publish = job('v3_publish_image', 'v3_preflight');

    for (const contents of [deploy, publish]) {
      const checkout = contents.indexOf('actions/checkout@');
      const trustedMain = contents.indexOf('gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main"');
      const registryLogin = contents.indexOf('docker/login-action@');
      const candidateBuild = contents.indexOf('docker buildx build');

      expect(checkout).toBeGreaterThan(0);
      expect(trustedMain).toBeGreaterThan(checkout);
      expect(registryLogin).toBeGreaterThan(trustedMain);
      expect(candidateBuild).toBeGreaterThan(registryLogin);
      expect(contents).toContain('test "$TARGET_SHA" = "$main_sha"');
      expect(contents).toContain('test "$(git rev-parse HEAD)" = "$main_sha"');
    }

    expect(publish).toContain('persist-credentials: false');
  });

  test('stops Data API and worker behind the exact activation gate', () => {
    const stop = job('v3_stop');

    expect(stop).toContain('github.event.client_payload.operation');
    expect(stop).toContain('v3-stop');
    expect(stop).toContain('APPROVE_V3_ACTIVATION $V3_CUTOVER_RUN_ID');
    expect(stop).toContain('docker compose stop -t 30 worker');
    expect(stop).toContain('docker compose stop -t 30 api');
    expect(stop).toContain('test "$data_http" = "000"');
    expect(stop).not.toContain('git fetch');
    expect(stop).not.toContain('git reset');
    expect(stop).not.toContain('docker compose up');
  });

  test('requires GraphQL down and gates the exact release before stopping Data', () => {
    const activation = job('v3_activate_database', 'v3_redis_queues');
    const graphqlStopped = activation.indexOf('GraphQL is still running on port 4000');
    const releaseGate = activation.indexOf('bun scripts/v3-release-gate.ts');
    const migrationHistoryGate = activation.indexOf('V3_PREACTIVATION_MIGRATION_HISTORY');
    const configBackup = activation.indexOf('env.deploy.before-v3');
    const runtimeEnvCheck = activation.indexOf('bun run env:check');
    const migrationContract = activation.indexOf('bun run db:migration-contract');
    const stopWorker = activation.indexOf('docker compose stop -t 30 worker');
    const stopApi = activation.indexOf('docker compose stop -t 30 api');
    const migrate = activation.indexOf('bun run db:migrate', stopApi);
    const provisionLogins = activation.indexOf('bun run db:provision-runtime-logins');

    expect(graphqlStopped).toBeGreaterThan(0);
    expect(releaseGate).toBeGreaterThan(graphqlStopped);
    expect(migrationHistoryGate).toBeGreaterThan(releaseGate);
    expect(configBackup).toBeGreaterThan(migrationHistoryGate);
    expect(runtimeEnvCheck).toBeGreaterThan(configBackup);
    expect(migrationContract).toBeGreaterThan(runtimeEnvCheck);
    expect(stopWorker).toBeGreaterThan(migrationContract);
    expect(stopApi).toBeGreaterThan(stopWorker);
    expect(migrate).toBeGreaterThan(stopApi);
    expect(provisionLogins).toBeGreaterThan(migrate);
    expect(activation).not.toContain('docker compose up');
  });

  test('rejects unsafe production migration history before writing VPS configuration', () => {
    const activation = job('v3_activate_database', 'v3_redis_queues');
    const status = activation.indexOf('bun run db:migrate:status');
    const composeEnvFile = activation.indexOf('MIGRATION_ENV_FILE="$migration_status_env"');
    const unsafeHistory = activation.indexOf('missing|backdated|mismatch|legacy');
    const requiredHistoryTail = activation.indexOf('0079_align_fpl_event_history.sql');
    const firstActivation = activation.indexOf('0079_create_v3_ops_and_roles.sql');
    const finalActivation = activation.indexOf('0090_zzzz_integrate_understat_runtime.sql');
    const gatedCleanup = activation.indexOf('0091_drop_v2_reporting_and_rpcs.sql');
    const migrationEnvWrite = activation.indexOf('mv "$migration_tmp" .env.migrate');

    expect(status).toBeGreaterThan(0);
    expect(composeEnvFile).toBeGreaterThan(0);
    expect(composeEnvFile).toBeLessThan(status);
    expect(activation).not.toContain('--env-file "$migration_status_env"');
    expect(unsafeHistory).toBeGreaterThan(status);
    expect(requiredHistoryTail).toBeGreaterThan(unsafeHistory);
    expect(firstActivation).toBeGreaterThan(requiredHistoryTail);
    expect(finalActivation).toBeGreaterThan(firstActivation);
    expect(gatedCleanup).toBeGreaterThan(finalActivation);
    expect(migrationEnvWrite).toBeGreaterThan(gatedCleanup);
  });

  test('preserves production-local files and backs up runtime configuration', () => {
    const activation = job('v3_activate_database', 'v3_redis_queues');
    const trackedGuard = activation.indexOf('git diff --quiet');
    const untrackedInventory = activation.indexOf('git ls-files --others --exclude-standard');
    const conflictGuard = activation.indexOf('comm -12');
    const reset = activation.indexOf('git reset --hard');
    const releaseGate = activation.indexOf('bun scripts/v3-release-gate.ts');
    const migrationEnvWrite = activation.indexOf('mv "$migration_tmp" .env.migrate');

    expect(trackedGuard).toBeGreaterThan(0);
    expect(activation).toContain('V3_MIGRATION_ENV: ${{ secrets.V3_MIGRATION_ENV }}');
    expect(activation).toContain('V3_DATA_DB_PASSWORD: ${{ secrets.V3_DATA_DB_PASSWORD }}');
    expect(activation).toContain('V3_GRAPHQL_DB_PASSWORD: ${{ secrets.V3_GRAPHQL_DB_PASSWORD }}');
    expect(releaseGate).toBeGreaterThan(trackedGuard);
    expect(migrationEnvWrite).toBeGreaterThan(releaseGate);
    expect(untrackedInventory).toBeGreaterThan(trackedGuard);
    expect(conflictGuard).toBeGreaterThan(untrackedInventory);
    expect(reset).toBeGreaterThan(conflictGuard);
    expect(activation).toContain('env.deploy.before-v3.sha256');
    expect(activation).toContain('runtime_user = f');
    expect(activation).toContain('letletme_data_runtime.{project_ref}');
    expect(activation).toContain('DATABASE_URL');
    expect(activation).not.toContain('git clean');
  });

  test.each(['postgres', 'letletme_data_runtime'])(
    'rewrites a quoted %s Supabase pooler URL idempotently',
    (sourceRole) => {
      const directory = mkdtempSync(join(tmpdir(), 'letletme-v3-runtime-env-'));
      try {
        const source = join(directory, '.env.deploy');
        const target = join(directory, '.env.deploy.next');
        const projectRef = 'abcdefghijklmnopqrst';
        const password = 'd'.repeat(64);
        writeFileSync(
          source,
          [
            `DATABASE_URL="postgresql://${sourceRole}.${projectRef}:old@pooler.example.com:6543/postgres?pgbouncer=true"`,
            'REDIS_HOST=cache.example.com',
            'REDIS_PORT=6379',
            'REDIS_PASSWORD=cache-password',
            'QUEUE_REDIS_HOST=queue.example.com',
            'QUEUE_REDIS_PORT=6380',
            'UNRELATED_SETTING=preserved',
          ].join('\n'),
        );
        writeFileSync(target, '');

        execFileSync('python3', ['-', source, target], {
          input: runtimeEnvPython(),
          env: { ...process.env, V3_DATA_DB_PASSWORD: password },
          encoding: 'utf8',
        });

        const output = readFileSync(target, 'utf8');
        expect(output).toContain(
          `DATABASE_URL=postgresql://letletme_data_runtime.${projectRef}:${password}@pooler.example.com:6543/postgres?pgbouncer=true`,
        );
        expect(output).toContain('CACHE_REDIS_HOST=cache.example.com');
        expect(output).toContain('CACHE_REDIS_DB=0');
        expect(output).toContain('QUEUE_REDIS_DB=1');
        expect(output).toContain('UNRELATED_SETTING=preserved');
        expect(output.match(/^DATABASE_URL=/gm)).toHaveLength(1);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  test('keeps queue copy and cache publication separately manifest-gated', () => {
    const queues = job('v3_redis_queues', 'v3_core_cache');
    const cache = job('v3_core_cache', 'v3_start_api');

    expect(queues).toContain('V3_REDIS_QUEUE_MANIFEST_SHA256');
    expect(queues).toContain('run_redis_cutover copy-queues --execute');
    expect(queues).toContain('run_redis_cutover verify-queues');
    expect(queues).toContain('CACHE_REDIS_HOST="${CACHE_REDIS_HOST:-${REDIS_HOST:-}}"');
    expect(queues).toContain('CACHE_REDIS_DB="${CACHE_REDIS_DB:-${REDIS_DB:-0}}"');
    expect(queues).toContain('QUEUE_REDIS_DB="${QUEUE_REDIS_DB:-1}"');
    expect(queues).not.toContain('mv "$env_tmp" .env.deploy');
    expect(cache).toContain('V3_CORE_CACHE_APPROVAL');
    expect(cache).toContain('cache:publish-core --execute');
    expect(cache).toContain('v3_core_cache_contract_passed');
    expect(cache).toContain('manifest.items.length !== 6');
    expect(cache).toContain('pttl !== -1');
    expect(cache).toContain('keyCount: rows.length');
  });

  test('starts the worker only after Data API, GraphQL, and queue verification pass', () => {
    const worker = job('v3_start_worker', 'v3_redeploy');
    const dataHealth = worker.indexOf('http://127.0.0.1:3000/health');
    const graphqlHealth = worker.indexOf('http://127.0.0.1:4000/health');
    const queueVerification = worker.indexOf('redis:cutover verify-queues');
    const startWorker = worker.indexOf('docker compose up -d --no-deps --no-build worker');

    expect(dataHealth).toBeGreaterThan(0);
    expect(graphqlHealth).toBeGreaterThan(dataHealth);
    expect(queueVerification).toBeGreaterThan(graphqlHealth);
    expect(startWorker).toBeGreaterThan(queueVerification);
  });

  test('redeploys merged main without database or activation mutations', () => {
    const redeploy = job('v3_redeploy', 'v3_status');
    const exactMain = redeploy.indexOf('test "$(git rev-parse origin/main)" = "$EXPECTED_SHA"');
    const exactRepository = redeploy.indexOf('test "${IMAGE_REF%@*}" = "$EXPECTED_IMAGE_NAME"');
    const expectedTag = redeploy.indexOf(
      'EXPECTED_TAG="${EXPECTED_IMAGE_NAME}:v3-${EXPECTED_SHA}"',
    );
    const digestBinding = redeploy.indexOf('grep -Fx "$IMAGE_REF"');
    const pullImage = redeploy.indexOf('docker pull "$IMAGE_REF"');
    const stopWorker = redeploy.indexOf('docker compose stop -t 30 worker');
    const stopApi = redeploy.indexOf('docker compose stop -t 30 api');
    const reset = redeploy.indexOf('git reset --hard "$EXPECTED_SHA"');
    const captureQueueManifest = redeploy.indexOf('inspect-queues --runtime-stable --digest-only');
    const queueVerification = redeploy.indexOf('verify-queues --runtime-stable');
    const startApi = redeploy.indexOf('docker compose up -d --no-deps --no-build api');
    const graphqlHealth = redeploy.indexOf('http://127.0.0.1:4000/health');
    const startWorker = redeploy.indexOf('docker compose up -d --no-deps --no-build worker');
    const queueVerificationCount = redeploy.match(/redis:cutover verify-queues/g)?.length ?? 0;

    expect(redeploy).toMatch(/client_payload\.operation == 'v3-redeploy'/);
    expect(redeploy).toContain('EXPECTED_IMAGE_NAME: ghcr.io/tonglam/letletme_data');
    expect(exactRepository).toBeGreaterThan(0);
    expect(exactMain).toBeGreaterThan(exactRepository);
    expect(expectedTag).toBeGreaterThan(exactMain);
    expect(digestBinding).toBeGreaterThan(expectedTag);
    expect(pullImage).toBeGreaterThan(digestBinding);
    expect(stopWorker).toBeGreaterThan(pullImage);
    expect(stopApi).toBeGreaterThan(stopWorker);
    expect(reset).toBeGreaterThan(stopApi);
    expect(captureQueueManifest).toBeGreaterThan(reset);
    expect(queueVerification).toBeGreaterThan(captureQueueManifest);
    expect(startApi).toBeGreaterThan(queueVerification);
    expect(graphqlHealth).toBeGreaterThan(startApi);
    expect(startWorker).toBeGreaterThan(graphqlHealth);
    expect(queueVerificationCount).toBe(1);
    expect(redeploy).toContain('V3_REDIS_QUEUE_MANIFEST_SHA256="$LIVE_QUEUE_MANIFEST_SHA256"');
    expect(redeploy).not.toContain('client_payload.v3_queue_manifest_sha256');
    expect(redeploy).toContain('V3_DATA_REDEPLOY=passed');
    expect(redeploy).not.toContain('git clean');

    for (const forbiddenMutation of [
      'bun run db:migrate',
      'bun run db:apply-sql',
      'v3-release-gate',
      'APPROVE_V3_ACTIVATION',
      'redis:cutover cleanup',
      '0091_drop_v2',
    ]) {
      expect(redeploy).not.toContain(forbiddenMutation);
    }
  });

  test('starts the API with HTTP contracts and an unchanged queue manifest', () => {
    const api = job('v3_start_api', 'v3_start_worker');
    const firstQueueVerification = api.indexOf('redis:cutover verify-queues');
    const startApi = api.indexOf('docker compose up -d --no-deps --no-build api');
    const health = api.indexOf('assert_status 200 GET http://127.0.0.1:3000/health');
    const ready = api.indexOf('assert_status 200 GET http://127.0.0.1:3000/ready');
    const current = api.indexOf('http://127.0.0.1:3000/events/current');
    const next = api.indexOf('http://127.0.0.1:3000/events/next');
    const unauthorized = api.indexOf(
      'assert_status 401 POST http://127.0.0.1:3000/jobs/events-sync/trigger',
    );
    const malformed = api.indexOf(
      'assert_status 400 GET http://127.0.0.1:3000/tournaments/check-name',
    );
    const lastQueueVerification = api.lastIndexOf('redis:cutover verify-queues');

    expect(api).toContain('QUEUE_MANIFEST_SHA256');
    expect(firstQueueVerification).toBeGreaterThan(0);
    expect(startApi).toBeGreaterThan(firstQueueVerification);
    expect(health).toBeGreaterThan(startApi);
    expect(ready).toBeGreaterThan(health);
    expect(current).toBeGreaterThan(ready);
    expect(next).toBeGreaterThan(current);
    expect(unauthorized).toBeGreaterThan(next);
    expect(malformed).toBeGreaterThan(unauthorized);
    expect(lastQueueVerification).toBeGreaterThan(malformed);
    expect(api).toContain('V3_DATA_HTTP_CONTRACT=');
  });

  test('does not expose legacy cleanup as a production operation', () => {
    const operations = Array.from(
      workflow.matchAll(/client_payload\.operation == '([^']+)'/g),
      (match) => match[1],
    );

    expect(operations.some((operation) => operation.includes('cleanup'))).toBe(false);
    expect(operations.some((operation) => operation.includes('legacy-drop'))).toBe(false);
    expect(workflow).not.toContain('APPROVE_V3_LEGACY_DROP');
  });

  test('runs terminal acceptance as read-only evidence collection', () => {
    const terminal = job('v3_terminal_acceptance', 'v3_stop');

    expect(terminal).toMatch(/client_payload\.operation == 'v3-terminal-acceptance'/);
    expect(terminal).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(terminal).toContain('inspectLegacyRedisQueues(cacheRedis');
    expect(terminal).toContain('inspectLegacyRedisQueues(queueRedis');
    expect(terminal).toContain('Legacy DB0 queue source was not fully cleaned');
    expect(terminal).toContain('Active DB1 queues no longer match');
    expect(terminal).toContain('GraphQL query-cache type/TTL contract failed');
    expect(terminal).toContain('validate-postcleanup.sql');
    expect(terminal).toContain('v3_postcleanup_validation_passed');
    expect(terminal).toContain('v3_terminal_database_acceptance_passed');
    expect(terminal).toContain('v3_terminal_redis_acceptance_passed');
    expect(terminal).toContain('V3_TERMINAL_ACCEPTANCE=passed');
    expect(terminal).toContain('00209e2cc1c6d9a60b580c3b1e4ca4cd9e30696a4fba6c5fb75548481d02d349');
    expect(terminal).toContain('4d10062af6a9d187078d31bb1c0d885f9e7ffca9fc63957c24eb3073a5300bd5');
    expect(terminal).not.toContain('docker compose up');
    expect(terminal).not.toContain('bun run db:migrate');
    expect(terminal).not.toContain('redis:cutover cleanup');
  });

  test('validates the activated database with a zero-change repeat and frozen services', () => {
    const validation = job('v3_validate_database');

    expect(validation).toMatch(/client_payload\.operation == 'v3-validate-database'/);
    expect(validation).toContain('V3_REPEAT_MIGRATIONS_APPLIED=0');
    expect(validation).toContain('validate-0090-activation.sql');
    expect(validation).toContain('validate-postcleanup.sql');
    expect(validation).toContain('validate-p5-quality.sql');
    expect(validation).toContain('capture-public-relation-hashes.sql');
    expect(validation).toContain('capture-v3-business-relation-hashes.sql');
    expect(validation).toContain('capture-public-sequence-state.sql');
    expect(validation).toContain('capture-public-security-contract.sql');
    expect(validation).toContain('database_url="${database_url#\\"}"');
    expect(validation).toContain('database_url="${database_url%\\"}"');
    expect(validation).toContain(
      `coalesce(metadata ->> ${quote}legacyDropPhase${quote}, ${quote}${quote})`,
    );
    expect(validation).toContain('complete) run_psql_file validate-postcleanup.sql');
    expect(validation).toContain('Unsupported partial legacy-drop phase');
    expect(validation).not.toContain('V3_R3_VALIDATOR_PATCH');
    expect(validation).toContain('--volume "$VALIDATION_DIR:/validation:ro"');
    expect(validation).toContain('docker compose ps -q api');
    expect(validation).toContain('docker compose ps -q worker');
    expect(validation).not.toContain('docker compose up');
    expect(validation).not.toContain('V3_LEGACY_DROP_APPROVAL');
  });
});
