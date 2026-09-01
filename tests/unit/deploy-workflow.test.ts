import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const securityWorkflow = readFileSync('.github/workflows/security.yml', 'utf8');
const cleanupWorkflow = readFileSync('.github/workflows/cleanup-legacy-runtime-secret.yml', 'utf8');
const briefingRolloutWorkflow = readFileSync(
  '.github/workflows/briefing-acquisition-rollout.yml',
  'utf8',
);
const sourceMediaRolloutWorkflow = readFileSync(
  '.github/workflows/briefing-source-media-rollout.yml',
  'utf8',
);
const pinnedOpenSshAction = readFileSync('.github/actions/pinned-openssh/action.yml', 'utf8');
const backupScript = readFileSync('scripts/pre-migration-backup.sh', 'utf8');
const contentWorker = readFileSync('src/content-worker.ts', 'utf8');
const formalScheduler = readFileSync('src/content/acquisition/formal-scheduler.ts', 'utf8');
const dockerfile = readFileSync('Dockerfile', 'utf8');
const hostRunnerDeployScript = readFileSync('scripts/deploy-host-grok-runner.sh', 'utf8');
const controlProbeScript = readFileSync('scripts/run-briefing-control-probe.sh', 'utf8');
const rearmScript = readFileSync('scripts/rearm-briefing-x-after-probe.sh', 'utf8');
const hostRunnerRollbackScript = readFileSync('scripts/rollback-host-grok-runner.sh', 'utf8');
const hostGrokRunner = readFileSync('src/content/host-grok-runner.ts', 'utf8');
const hostRunnerService = readFileSync('deploy/letletme-grok-runner.service', 'utf8');
const deployScript = readFileSync('scripts/deploy.sh', 'utf8');
const sourceMediaBootstrapScript = readFileSync(
  'scripts/bootstrap-briefing-source-media-env.sh',
  'utf8',
);
const managedEnvLibrary = readFileSync('scripts/lib/managed-env.sh', 'utf8');
const deployStateMachine = readFileSync('scripts/deploy-state-machine.sh', 'utf8');
const runtimeHealthScript = readFileSync('scripts/verify-runtime-health.sh', 'utf8');
const composeFile = readFileSync('docker-compose.yml', 'utf8');
const mediaWorker = readFileSync('src/media-worker.ts', 'utf8');
const mediaConfig = readFileSync('src/content/media/source-media-config.ts', 'utf8');
const queueQuiescence = readFileSync('scripts/assert-queue-quiescence.ts', 'utf8');
const quote = String.fromCharCode(39);

function expectNonInteractiveComposeRuns(source: string, label: string) {
  const logicalLines: string[] = [];
  let logicalLine = '';
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (!logicalLine && trimmed.startsWith('#')) continue;
    logicalLine += `${logicalLine ? ' ' : ''}${trimmed.replace(/\\$/, '').trim()}`;
    if (!trimmed.endsWith('\\')) {
      logicalLines.push(logicalLine);
      logicalLine = '';
    }
  }
  const runLines = logicalLines.filter(
    (line) =>
      /\brun\s+--rm -T\b/.test(line) &&
      // A SQL heredoc is intentionally attached to psql so status/health
      // queries can receive their query body; only detached runs belong here.
      !line.includes('<<'),
  );
  expect(runLines.length, `${label} should contain Compose run commands`).toBeGreaterThan(0);
  for (const line of runLines) {
    expect(line, `${label} has an interactive Compose run: ${line}`).toContain(
      '--interactive=false',
    );
  }
}

function runRollbackEligibility(overrides: Record<string, string> = {}) {
  const script = String.raw`
    set -euo pipefail
    source scripts/deploy-state-machine.sh
    docker() {
      if [[ "$1" = image && "$2" = inspect && "$3" = --format ]]; then
        printf '%s\n' "$MOCK_PREVIOUS_IMAGE_ID"
        return 0
      fi
      if [[ "$1" = inspect && "$2" = --format ]]; then
        case "$3" in
          '{{.Image}}') printf '%s\n' "$MOCK_CONTAINER_IMAGE_ID" ;;
          *org.opencontainers.image.revision*) printf '%s\n' "$MOCK_CONTAINER_RELEASE" ;;
          *Config.Env*) printf 'DEPLOY_SHA=%s\n' "$MOCK_CONTAINER_ENV_RELEASE" ;;
          '{{.State.Status}}') printf '%s\n' "$MOCK_CONTAINER_STATE" ;;
          *State.Health.Status*) printf '%s\n' "$MOCK_CONTAINER_HEALTH" ;;
          *) return 1 ;;
        esac
        return 0
      fi
      if [[ "$1" = exec ]]; then
        return "$MOCK_STRICT_HEALTH_STATUS"
      fi
      return 1
    }
    rollback_runtime_is_eligible \
      old-api "$MOCK_PREVIOUS_IMAGE" "$MOCK_PREVIOUS_REVISION" \
      "$MOCK_PREVIOUS_RELEASE"
  `;
  const exactRelease = '0123456789abcdef0123456789abcdef01234567';
  return Bun.spawnSync(['bash', '-c', script], {
    env: {
      ...process.env,
      MOCK_CONTAINER_HEALTH: 'healthy',
      MOCK_CONTAINER_IMAGE_ID: 'sha256:old',
      MOCK_CONTAINER_RELEASE: exactRelease,
      MOCK_CONTAINER_ENV_RELEASE: exactRelease,
      MOCK_CONTAINER_STATE: 'running',
      MOCK_PREVIOUS_IMAGE: 'ghcr.io/example/data@sha256:abc',
      MOCK_PREVIOUS_IMAGE_ID: 'sha256:old',
      MOCK_PREVIOUS_RELEASE: exactRelease,
      MOCK_PREVIOUS_REVISION: exactRelease,
      MOCK_STRICT_HEALTH_STATUS: '0',
      ...overrides,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('release workflow gates', () => {
  test('keeps the content worker alive when the pipeline is disabled', () => {
    expect(contentWorker).toContain('publicationOutboxDispatcher = setInterval');
    expect(contentWorker).not.toContain('publicationOutboxDispatcher.unref?.()');
    expect(contentWorker).not.toContain('scheduler.unref?.()');
  });

  test('cleans only exact stopped API one-off containers before the port gate', () => {
    expect(deployStateMachine).toContain('remove_stale_api_run_containers()');
    expect(deployStateMachine).toContain('compose config --format json');
    expect(deployStateMachine).toContain('label=com.docker.compose.service=api');
    expect(deployStateMachine).toContain('com.docker.compose.oneoff');
    expect(deployStateMachine).toContain('host_port=3000');
    expect(deployStateMachine).toContain('running|restarting|paused');
    expect(deployStateMachine).not.toContain('health\" != unhealthy');
    expect(deployStateMachine).toContain('refusing to remove API one-off');
    expect(deployScript).toContain(
      'remove_exact_stopped_container api\n  remove_stale_api_run_containers\n  wait_for_port_3000_free',
    );
    expect(workflow).toContain(
      'remove_exact_stopped_container api\n            remove_stale_api_run_containers\n            wait_for_port_3000_free',
    );
  });

  test('defers formal acquisition while deployment admission is closed', () => {
    expect(contentWorker).toContain('isQueueDrainOnly(contentXScanQueueName)');
    expect(formalScheduler).toContain('xSchedulingPaused');
    expect(formalScheduler).toContain('if (error instanceof QueueDrainOnlyError)');
    expect(formalScheduler).toContain('deferFormalRunForAdmission');
    expect(deployStateMachine).toContain('--admission-mode');
    expect(deployStateMachine).toContain('--admission-queue');
    expect(deployStateMachine).toContain('deadline_seconds=${3:-300}');
    expect(deployStateMachine).toContain('probe_timeout_seconds=${4:-10}');
  });

  test('pauses every content-worker consumer and drains active work before stopping the producer', () => {
    expect(queueQuiescence).toContain('export const CONTENT_X_SCAN_QUEUE = contentXScanQueueName');
    expect(queueQuiescence).toContain(
      ['CONTENT_CONSUMER_CONTRACT_VERSION = ', quote, 'content-worker-consumer-v1', quote].join(''),
    );
    expect(queueQuiescence).toContain('queue.isPaused()');
    expect(queueQuiescence).toContain('queue.pause()');
    expect(queueQuiescence).toContain('queue.resume()');
    expect(queueQuiescence).toContain('parseContentConsumerModeArguments');
    expect(queueQuiescence).toContain('parseAllowedPausedQueueNames');
    expect(queueQuiescence).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/);
    expect(deployStateMachine).toContain('content-x-scan');
    expect(deployStateMachine).toContain('content-http-acquisition');
    expect(deployStateMachine).toContain('content-media-transcript');
    expect(deployStateMachine).toContain('DEPLOY_QUIESCENCE_ALLOW_PAUSED_QUEUES');
    expect(deployStateMachine).toContain('run_bounded_deploy_probe');

    for (const source of [deployStateMachine, deployScript, workflow]) {
      expect(source).not.toContain('start_content_x_scan_advisory_fence');
      expect(source).not.toContain('stop_content_x_scan_advisory_fence');
      expect(source).not.toContain('hold-briefing-x-capacity-lock');
    }
    expect(deployStateMachine).toContain('assert_content_worker_consumers_paused');
    expect(deployStateMachine).toContain('pause_content_worker_consumers_for_deploy');
    expect(deployStateMachine).toContain('restore_content_deploy_controls');
    expect(deployStateMachine).toContain('DEPLOY_CONTENT_WORKER_CONTROL_IMAGE');
    expect(deployStateMachine).toContain('cleanup_content_worker_control_image');
    expect(deployStateMachine).toContain(
      'DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_INTERVAL_SECONDS > 300',
    );
    expect(deployScript).toContain('restore_content_deploy_controls');
    expect(deployScript).toContain('stop_content_worker_for_forward_recovery');
    expect(workflow).toContain('restore_content_deploy_controls');
    expect(workflow).toContain('stop_content_worker_for_forward_recovery');

    const localPause = deployScript.indexOf('if ! pause_content_worker_consumers_for_deploy; then');
    const localAdmission = deployScript.indexOf(
      'if ! drain_content_worker_queues_for_deploy; then',
    );
    const localSchedulerStop = deployScript.indexOf('if ! compose stop -t 45 scheduler; then');
    const localProbe = deployScript.indexOf('if ! wait_for_scoped_queue_quiescence 150 2; then');
    const localStop = deployScript.indexOf('if ! compose stop -t 45 content-worker; then');
    const localPrepare = deployScript.indexOf(
      'if ! prepare_content_worker_paused_runs_for_deploy; then',
    );
    const localRenew = deployScript.indexOf('if ! renew_content_worker_admission; then');
    expect(localPause).toBeGreaterThan(-1);
    expect(localPause).toBeLessThan(localAdmission);
    expect(localAdmission).toBeLessThan(localProbe);
    expect(localAdmission).toBeLessThan(localSchedulerStop);
    expect(localSchedulerStop).toBeLessThan(localProbe);
    expect(localProbe).toBeLessThan(localStop);
    expect(localStop).toBeLessThan(localPrepare);
    expect(localPrepare).toBeLessThan(localRenew);
    expect(deployScript).toContain('DEPLOY_CONTENT_WORKER_ADMISSION_ATTEMPTED_QUEUES');

    const workflowPause = workflow.indexOf('if ! pause_content_worker_consumers_for_deploy; then');
    const workflowSchedulerStop = workflow.indexOf('if ! compose stop -t 45 scheduler; then');
    const workflowProbe = workflow.indexOf('if ! wait_for_scoped_queue_quiescence 150 2; then');
    const workflowStop = workflow.indexOf('if ! compose stop -t 45 content-worker; then');
    const workflowAdmission = workflow.indexOf('if ! drain_content_worker_queues_for_deploy; then');
    const workflowPrepare = workflow.indexOf(
      'if ! prepare_content_worker_paused_runs_for_deploy; then',
    );
    const workflowRenew = workflow.indexOf('if ! renew_content_worker_admission; then');
    expect(workflowPause).toBeGreaterThan(-1);
    expect(workflowPause).toBeLessThan(workflowAdmission);
    expect(workflowAdmission).toBeLessThan(workflowProbe);
    expect(workflowAdmission).toBeLessThan(workflowSchedulerStop);
    expect(workflowSchedulerStop).toBeLessThan(workflowProbe);
    expect(workflowProbe).toBeLessThan(workflowStop);
    expect(workflowStop).toBeLessThan(workflowPrepare);
    expect(workflowPrepare).toBeLessThan(workflowRenew);
    expect(workflow).toContain('content_worker_fenced=true');
    expect(workflow).toContain('scheduler_stop_attempted=true');
    expect(workflow).toContain(
      '[ "$services_stopped" = true ] || [ "$content_worker_fenced" = true ]',
    );
  });

  test('keeps the compiled host runner free of runtime logger transports', () => {
    expect(hostGrokRunner).toContain(String.raw`from '../utils/strict-env'`);
    expect(hostGrokRunner).not.toContain(String.raw`from './config'`);
    expect(hostGrokRunner).not.toContain(String.raw`from '../utils/logger'`);
  });

  test('isolates the durable media worker and includes it in deployment gates', () => {
    const mediaServiceStart = composeFile.indexOf('  media-worker:');
    const mediaService = composeFile.slice(mediaServiceStart);
    expect(mediaServiceStart).toBeGreaterThan(0);
    expect(mediaService).toContain('command: bun dist/media-worker.js');
    expect(mediaService).toContain('${CONTENT_MEDIA_ENV_FILE:-.env.media}');
    expect(mediaService).toContain('DATABASE_POOL_MAX=1');
    expect(mediaService).toContain('read_only: true');
    expect(mediaService).toContain('cap_drop:\n      - ALL');
    expect(mediaService).toContain('no-new-privileges:true');
    expect(mediaService).not.toContain('/run/letletme-grok-runner');
    expect(mediaService).not.toContain('group_add:');
    expect(mediaConfig).toContain('CONTENT_MEDIA_WORKER_ENABLED');
    expect(mediaWorker).toContain('releaseSourceMediaGateLeases');
    expect(mediaWorker).toContain('controller.abort');
    expect(mediaWorker).toContain('retentionController?.abort');
    expect(mediaWorker).toContain('if (polling || shuttingDown || !flags.enabled) return;');
    expect(mediaWorker).not.toContain('!flags.enabled || retentionInFlight');
    expect(queueQuiescence).toContain('allQueueNames.map');
    expect(queueQuiescence).toContain(String.raw`status = 'RUNNING'`);
    expect(deployScript).toContain('--provision-and-probe');
    expect(deployScript).toContain('--probe-fpl-raw-snapshot-storage');
    expect(workflow).toContain('--probe-fpl-raw-snapshot-storage');
    expect(deployScript).toContain('bootstrap-briefing-source-media-env.sh');
    expect(workflow).toContain('bootstrap-briefing-source-media-env.sh');
    expect(workflow.indexOf('scripts/bootstrap-briefing-source-media-env.sh')).toBeGreaterThan(
      workflow.indexOf('acquire_deploy_lock'),
    );
    expect(workflow.indexOf('scripts/bootstrap-briefing-source-media-env.sh')).toBeGreaterThan(
      workflow.indexOf('bun validate-env.ts --probe-bug-report-storage'),
    );
    expect(deployScript.indexOf('bootstrap-briefing-source-media-env.sh')).toBeGreaterThan(
      deployScript.indexOf('bun validate-env.ts --probe-bug-report-storage'),
    );
    expect(deployScript.indexOf('bootstrap-briefing-source-media-env.sh')).toBeLessThan(
      deployScript.indexOf('status()'),
    );
    expect(sourceMediaBootstrapScript).toContain('BUG_REPORT_SCREENSHOT_SUPABASE_SECRET_KEY');
    expect(sourceMediaBootstrapScript).toContain('CONTENT_MEDIA_WORKER_ENABLED=false');
    expect(sourceMediaBootstrapScript).toContain('CONTENT_MEDIA_RETENTION_ENABLED=false');
    expect(sourceMediaBootstrapScript).toContain('chmod 600');
    expect(sourceMediaBootstrapScript).toContain('managed_env_atomic_create');
    expect(managedEnvLibrary).toContain('-nT');
    expect(managedEnvLibrary).toContain('--no-target-directory');
    expect(managedEnvLibrary).toContain('managed_env_atomic_replace');
    expect(managedEnvLibrary).toContain('managed_env_require_regular_file');
    expect(sourceMediaBootstrapScript).not.toContain('set -x');
    expect(deployScript).toContain('briefing_source_media_health');
    expect(runtimeHealthScript).toContain('attempts=${HEALTH_ATTEMPTS:-90}');
    expect(runtimeHealthScript).toContain('deadline_seconds=${HEALTH_DEADLINE_SECONDS:-300}');
    expect(runtimeHealthScript).toContain('deadline_reached()');
    expect(workflow).toContain(
      'HEALTH_ATTEMPTS=90 HEALTH_DELAY_SECONDS=2 HEALTH_DEADLINE_SECONDS=300',
    );
    expect(workflow).toContain('timeout: 30m');
    expect(workflow).toContain('compose stop -t 45 content-worker');
    expect(workflow).toContain('compose stop -t 45 scheduler;');
    expect(workflow).toContain('compose stop -t 45 media-worker');
    expect(workflow).toContain('"$old_media_present" "$old_image_id" && \\');
    expect(workflow).toContain('export RUNTIME_INCLUDE_MEDIA_WORKER=true');
    expect(deployScript).toContain('export RUNTIME_INCLUDE_MEDIA_WORKER=true');
    expect(deployStateMachine).toContain(
      'export RUNTIME_INCLUDE_MEDIA_WORKER="$previous_media_present"',
    );
    expect(queueQuiescence).toContain('connect_timeout: 5');
    expect(queueQuiescence).toContain('statement_timeout: 5_000');
  });

  test('allows only session-mode pooler connections for the external backup', () => {
    expect(backupScript).toContain('*pgbouncer=true*|*:6543/*');
    expect(backupScript).not.toContain('*pooler.supabase.com*');
    expect(backupScript).toContain('Supabase session pooler on port 5432');
    expect(backupScript).toContain('--dbname="$DATABASE_URL"');
    expect(backupScript).toContain('DATABASE_BACKUP_PG_MAJOR must be 15');
  });

  test('keeps the V2 seed connection separate from the runtime connection', () => {
    const v2Seed = deployScript.slice(deployScript.indexOf('start_stage v2Seed'));
    expect(v2Seed).toContain('LIVE_POINTS_V2_SEED_DATABASE_URL="$migration_database_url"');
    expect(v2Seed).toContain('-e LIVE_POINTS_V2_SEED_DATABASE_URL');
    expect(v2Seed).not.toContain('-e "LIVE_POINTS_V2_SEED_DATABASE_URL=${migration_database_url}"');
    expect(v2Seed).not.toContain('-e "DATABASE_URL=${migration_database_url}"');
    expect(v2Seed).toMatch(
      /if ! compose run --rm -T --interactive=false \\\n\s+api \\\n\s+bun run verify:live-points-v2/,
    );

    const workflowV2Seed = workflow.slice(workflow.indexOf('start_stage v2Seed'));
    expect(workflowV2Seed).toContain('LIVE_POINTS_V2_SEED_DATABASE_URL="$migration_database_url"');
    expect(workflowV2Seed).toContain('-e LIVE_POINTS_V2_SEED_DATABASE_URL');
    expect(workflowV2Seed).not.toContain('-e "LIVE_POINTS_V2_SEED_DATABASE_URL=$');
    expect(workflowV2Seed).toContain('DATABASE_URL="$data_runtime_database_url"');
    expect(workflowV2Seed).toContain('-e DATABASE_URL api');
    expect(workflowV2Seed).not.toContain('-e "DATABASE_URL=$');
    expect(workflowV2Seed).toContain(
      'bun run db:cutover-seed-live-match-v3 -- --execute --all-finalized',
    );
    expect(workflowV2Seed).not.toContain('bun run db:cutover-seed-live-match-v2');
  });

  test('drains the destructive review reset before runtime startup', () => {
    expect(deployStateMachine).toContain('run_tournament_review_hard_cut_backfill');
    expect(deployStateMachine).toContain('Data runtime DATABASE_URL is required');
    expect(deployStateMachine).toContain(
      '-e DATABASE_URL -e MY_TOURNAMENT_REVIEW_BACKFILL_CONFIRM',
    );
    expect(deployScript).toContain('DEPLOY_REVIEW_HARD_CUT_PENDING=true');
    expect(deployScript).toContain('migration-scoped gate skipped');
    expect(deployStateMachine).toContain('MY_TOURNAMENT_REVIEW_BACKFILL_CONFIRM=YES');
    expect(deployStateMachine).toContain('--batch-size 100 --max-batches 10000');
    const localBackfill = deployScript.indexOf('run_tournament_review_hard_cut_backfill');
    const localRoleVerify = deployScript.indexOf('start_stage roleVerify');
    const workflowBackfill = workflow.indexOf('run_tournament_review_hard_cut_backfill');
    const workflowRoleVerify = workflow.indexOf('start_stage roleVerify');
    expect(localBackfill).toBeGreaterThan(-1);
    expect(localBackfill).toBeLessThan(localRoleVerify);
    expect(workflowBackfill).toBeGreaterThan(-1);
    expect(workflowBackfill).toBeLessThan(workflowRoleVerify);
  });

  test('keeps the read-only backup container able to normalize its writable mount', () => {
    const backupServiceStart = composeFile.indexOf('  backup:');
    const apiServiceStart = composeFile.indexOf('  api:', backupServiceStart);
    const backupService = composeFile.slice(backupServiceStart, apiServiceStart);
    expect(backupService).toContain('read_only: true');
    expect(backupService).toContain('cap_drop:\n      - ALL');
    expect(backupService).toContain('cap_add:\n      - FOWNER\n      - DAC_OVERRIDE');
    expect(backupService).toContain('/var/backups/letletme-data');
    expect(backupService).toContain('no-new-privileges:true');
  });

  test('pins all actions and aligns CI with the production Bun version', () => {
    const mutableAction = /uses:\s+[^@\n]+@(v\d|main|master|latest)(?:\s|$)/;
    expect(workflow).not.toMatch(mutableAction);
    expect(ciWorkflow).not.toMatch(mutableAction);
    expect(securityWorkflow).not.toMatch(mutableAction);
    expect(briefingRolloutWorkflow).not.toMatch(mutableAction);
    expect(sourceMediaRolloutWorkflow).not.toMatch(mutableAction);
    expect(ciWorkflow).not.toContain(`bun-version: [${quote}1.3.3${quote}]`);
    expect(ciWorkflow).toContain(`bun-version: [${quote}1.3.14${quote}]`);
    expect(dockerfile).not.toContain('apk upgrade');
    expect(
      dockerfile.match(/apk add --no-cache libcrypto3=3\.5\.8-r0 libssl3=3\.5\.8-r0/g),
    ).toHaveLength(2);
    expect(ciWorkflow).toContain('test -x /app/letletme-grok-runner');
    expect(ciWorkflow).toContain('getent group letletme-grok-bridge');
    expect(ciWorkflow).not.toContain('grok-home');
    expect(ciWorkflow).not.toContain('auth.json');
    expect(dockerfile).toContain('COPY --from=build /app/config/briefing ./config/briefing');
    expect(ciWorkflow).toContain('test -r /app/config/briefing/sources.yaml');
    expect(ciWorkflow).toContain('test -r /app/config/briefing/acquisition-plan.yaml');
    expect(ciWorkflow).toContain('test -f /app/dist/media-worker.js');
    expect(ciWorkflow).toContain('! id -Gn');
    expect(dockerfile).not.toContain('addgroup appuser letletme-grok-bridge');
  });

  test('uses system OpenSSH with an out-of-band pinned host identity', () => {
    for (const remoteWorkflow of [
      workflow,
      cleanupWorkflow,
      briefingRolloutWorkflow,
      sourceMediaRolloutWorkflow,
    ]) {
      expect(remoteWorkflow).toContain('uses: ./.github/actions/pinned-openssh');
      expect(remoteWorkflow).toContain('known-hosts: ${{ secrets.VPS_SSH_KNOWN_HOSTS }}');
      expect(remoteWorkflow).toContain('fingerprint: ${{ secrets.VPS_SSH_FINGERPRINT }}');
      expect(remoteWorkflow).not.toContain('appleboy/ssh-action');
      expect(remoteWorkflow).not.toContain('ssh-keyscan');
    }

    for (const localActionWorkflow of [
      cleanupWorkflow,
      briefingRolloutWorkflow,
      sourceMediaRolloutWorkflow,
    ]) {
      const checkoutIndex = localActionWorkflow.indexOf(
        'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      );
      const localActionIndex = localActionWorkflow.indexOf(
        'uses: ./.github/actions/pinned-openssh',
      );
      expect(checkoutIndex).toBeGreaterThan(-1);
      expect(localActionIndex).toBeGreaterThan(checkoutIndex);
    }

    expect(pinnedOpenSshAction).toContain('StrictHostKeyChecking=yes');
    expect(pinnedOpenSshAction).toContain('IdentitiesOnly=yes');
    expect(pinnedOpenSshAction).toContain('ssh-keygen -lf');
    expect(pinnedOpenSshAction).toContain('chmod 0600');
    expect(pinnedOpenSshAction).toContain('trap cleanup EXIT');
    expect(pinnedOpenSshAction).toContain(`printf ${quote}export %s=${quote}`);
    expect(pinnedOpenSshAction).toContain('"$INPUT_USERNAME@$INPUT_HOST" \'bash -s\'');
    expect(pinnedOpenSshAction).not.toContain('remote_command=');
    expect(pinnedOpenSshAction).not.toContain('ssh-keyscan');
  });

  test('prevents streamed deployment scripts from consuming bash stdin', () => {
    expectNonInteractiveComposeRuns(workflow, 'main deploy workflow');
    expectNonInteractiveComposeRuns(deployScript, 'local deploy script');
    expectNonInteractiveComposeRuns(deployStateMachine, 'shared deploy state machine');
    expectNonInteractiveComposeRuns(
      briefingRolloutWorkflow,
      'briefing acquisition rollout workflow',
    );
    expectNonInteractiveComposeRuns(sourceMediaRolloutWorkflow, 'source-media rollout workflow');
    const statusStart = deployScript.indexOf('status()');
    const statusEnd = deployScript.indexOf('\nstream_logs()', statusStart);
    expect(statusStart).toBeGreaterThan(-1);
    expect(statusEnd).toBeGreaterThan(statusStart);
    expect(deployScript.slice(statusStart, statusEnd)).toContain(
      'compose --profile migration run --rm -T --no-deps --entrypoint sh backup -euc',
    );
    expect(deployScript.slice(statusStart, statusEnd)).not.toContain('--interactive=false');
    expect(briefingRolloutWorkflow).toContain(
      '--profile migration run --rm -T --no-deps --entrypoint sh backup -euc',
    );
    expect(briefingRolloutWorkflow).toContain(
      '--profile migration run --rm -T --interactive=false --no-deps --entrypoint sh backup -euc',
    );
    expect(workflow).toContain('streams this script through `bash -s`');
    expect(workflow).toContain('Never let Compose attach to that stdin');
    expect(deployStateMachine).toContain('Callers may execute this state machine from an SSH');
  });

  test('keeps source-media rollout protected, reversible, and Storage-gated', () => {
    expect(sourceMediaRolloutWorkflow).toContain(
      `if: github.ref == ${quote}refs/heads/main${quote}`,
    );
    expect(sourceMediaRolloutWorkflow).toContain('test "$main_sha" = "$GITHUB_SHA"');
    expect(sourceMediaRolloutWorkflow).toContain('test "$(git rev-parse HEAD)" = "$ROLLOUT_SHA"');
    expect(sourceMediaRolloutWorkflow).toContain(
      'options:\n          - status\n          - provision\n          - enable\n          - enable-retention\n          - disable',
    );
    expect(sourceMediaRolloutWorkflow).toContain('configure-briefing-source-media-env.sh');
    expect(sourceMediaRolloutWorkflow).toContain('"mediaEnvPresent":false');
    expect(sourceMediaRolloutWorkflow).toContain('bootstrap-briefing-source-media-env.sh');
    expect(sourceMediaRolloutWorkflow).toContain('bun validate-env.ts --probe-bug-report-storage');
    expect(
      sourceMediaRolloutWorkflow.indexOf('bootstrap-briefing-source-media-env.sh'),
    ).toBeGreaterThan(
      sourceMediaRolloutWorkflow.indexOf('bun validate-env.ts --probe-bug-report-storage'),
    );
    expect(sourceMediaRolloutWorkflow).toContain('read_container_boolean');
    expect(sourceMediaRolloutWorkflow).toContain('"containerHealth":"%s"');
    expect(
      sourceMediaRolloutWorkflow.indexOf(
        'source-media rollout refused: Storage secret is present in .env.deploy',
      ),
    ).toBeLessThan(sourceMediaRolloutWorkflow.indexOf('if [ ! -e "$media_env_file" ]'));
    expect(sourceMediaRolloutWorkflow).toContain('acquire_deploy_lock');
    expect(sourceMediaRolloutWorkflow).toContain('release_deploy_lock');
    expect(sourceMediaRolloutWorkflow).toContain('export DEPLOY_SHA="$ROLLOUT_SHA"');
    expect(sourceMediaRolloutWorkflow).toContain('--provision-and-probe');
    expect(sourceMediaRolloutWorkflow).toContain('briefing_source_media_health');
    expect(sourceMediaRolloutWorkflow).toContain('retention_preflight');
    expect(sourceMediaRolloutWorkflow).toContain(String.raw`storage_state = 'RESERVED'`);
    expect(sourceMediaRolloutWorkflow).toContain('mv "$backup_file" "$media_env_file"');
    expect(sourceMediaRolloutWorkflow).toContain('--force-recreate media-worker');
    expect(sourceMediaRolloutWorkflow).toContain('CONTENT_PUBLICATION_ENABLED');
    expect(sourceMediaRolloutWorkflow).toContain('BRIEFING_PUBLIC_ENABLED');
    expect(sourceMediaRolloutWorkflow).not.toContain('CONTENT_MEDIA_SUPABASE_SECRET_KEY:');
    expect(sourceMediaRolloutWorkflow).not.toContain('script_stop:');
  });

  test('keeps Briefing acquisition rollout on protected main with rollback and fixed modes', () => {
    expect(briefingRolloutWorkflow).toContain(`if: github.ref == ${quote}refs/heads/main${quote}`);
    expect(briefingRolloutWorkflow).toContain('test "$main_sha" = "$GITHUB_SHA"');
    expect(briefingRolloutWorkflow).toContain('test "$(git rev-parse HEAD)" = "$ROLLOUT_SHA"');
    expect(briefingRolloutWorkflow).toContain('export DEPLOY_SHA="$ROLLOUT_SHA"');
    expect(briefingRolloutWorkflow).toContain(
      'options:\n          - status\n          - shadow-http\n          - host-shadow\n          - disabled',
    );
    expect(briefingRolloutWorkflow).toContain('mv "$backup_file" "$env_file"');
    expect(briefingRolloutWorkflow).toContain('--force-recreate content-worker');
    expect(briefingRolloutWorkflow).toContain('content-worker || true');
    expect(briefingRolloutWorkflow).toContain(
      'runner_socket=/run/letletme-grok-runner/runner.sock',
    );
    expect(briefingRolloutWorkflow).toContain('runner_probe');
    expect(briefingRolloutWorkflow).toContain('run-briefing-control-probe.sh');
    expect(briefingRolloutWorkflow).not.toContain('auth.json');
    expect(briefingRolloutWorkflow).toContain(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    expect(briefingRolloutWorkflow).toContain(`SET LOCAL statement_timeout = ${quote}15s${quote}`);
    expect(briefingRolloutWorkflow).toContain('briefing_acquisition_control_health');
    expect(briefingRolloutWorkflow).toContain('briefing_acquisition_run_health');
    expect(briefingRolloutWorkflow).toContain('verify_manifest_reconciliation');
    expect(briefingRolloutWorkflow).toContain('source_registry_reconciliations');
    expect(briefingRolloutWorkflow).toContain('worker_restart_started_at');
    expect(briefingRolloutWorkflow).toContain(
      ['created_at >= ', quote, '${worker_restart_started_at}', quote, '::timestamptz'].join(''),
    );
    expect(briefingRolloutWorkflow).toContain('[ "$rollout_committed" = false ]');
    expect(
      briefingRolloutWorkflow.lastIndexOf('scripts/rearm-briefing-x-after-probe.sh'),
    ).toBeGreaterThan(briefingRolloutWorkflow.lastIndexOf('verify_manifest_reconciliation'));
    expect(briefingRolloutWorkflow).toContain('--connect-timeout 5 --max-time 15');
    expect(briefingRolloutWorkflow).toContain(
      '[ "$services_quiesced" = true ] || [ "$mutation_started" = true ]',
    );
    expect(briefingRolloutWorkflow).not.toContain('briefing_acquisition_fact_health');
    expect(briefingRolloutWorkflow).not.toContain('error_summary,');
    expect(briefingRolloutWorkflow).not.toContain('tar -C "$HOME/.grok"');
    expect(briefingRolloutWorkflow).not.toContain('script_stop:');
    expect(hostRunnerDeployScript).toContain('--self-test');
    expect(hostRunnerDeployScript).toContain('runner_health_deadline=$((SECONDS + 60))');
    expect(hostRunnerDeployScript).toContain(
      'runner socket did not become ready within 60 seconds',
    );
    expect(hostRunnerDeployScript).not.toContain('/v1/probes/x');
    expect(controlProbeScript).toContain('GLOBAL:GROK_BUILD_X');
    expect(controlProbeScript).toContain('content.acquisition_budget_reservations');
    expect(controlProbeScript).toContain('CONTROL_PLANE_PROBE');
    expect(controlProbeScript).toContain('lease_expires_at < now()');
    expect(controlProbeScript).toContain('CONTROL_PROBE_INTERRUPTED');
    expect(controlProbeScript).toContain('controlProbeRecovery');
    expect(controlProbeScript).toContain('\\o /dev/null');
    expect(controlProbeScript).toContain('psql "$DATABASE_URL"');
    expect(hostRunnerDeployScript).toContain('rollback_on_failure');
    expect(hostRunnerDeployScript).toContain('prune_old_releases');
    expect(hostRunnerDeployScript).toContain('keep_recent=3');
    expect(hostRunnerRollbackScript).toContain('/home/workspace/letletme-grok-runner');
    expect(hostRunnerService).toContain('RuntimeDirectoryMode=0770');
    expect(hostRunnerService).toContain('RuntimeDirectoryPreserve=yes');
    expect(deployScript).toContain('deploy-host-grok-runner.sh');
    expect(deployScript).toContain('run-briefing-control-probe.sh');
    expect(deployScript).toContain('DEPLOY_RUNNER_UPDATED');
    expect(deployScript).toContain('CONTENT_REAL_GROK_ENABLED');
    expect(workflow).toContain('CONTENT_REAL_GROK_ENABLED');
    expect(composeFile).toContain('/run/letletme-grok-runner:/run/letletme-grok-runner:ro');
    expect(composeFile).toContain(['group_add:', `      - ${quote}1555${quote}`].join('\n'));
    expect(rearmScript).toContain(`identity_requirement = ${quote}REQUIRED${quote}`);
    expect(rearmScript).toContain(
      `identity_status IN (${quote}PENDING${quote}, ${quote}FAILED${quote})`,
    );
    expect(rearmScript).toContain('latest_runner_failure');
    expect(rearmScript).toContain(`${quote}RUNNER_NOT_READY${quote}`);
  });

  test('does not roll back Data when the optional Briefing provider probe is degraded', () => {
    expect(workflow).toContain('runner_probe_succeeded=false');
    expect(workflow).toContain(
      'if run_deploy_command_with_pause_renewal scripts/run-briefing-control-probe.sh',
    );
    expect(workflow).toContain('dataDeploymentContinues');
    expect(workflow).toContain('[ "$runner_probe_succeeded" = true ]');
    expect(workflow).toContain('finish_stage degraded');

    expect(deployScript).toContain('DEPLOY_RUNNER_PROBE_SUCCEEDED=false');
    expect(deployScript).toContain(
      'if run_deploy_command_with_pause_renewal "${PROJECT_DIR}/scripts/run-briefing-control-probe.sh"',
    );
    expect(deployScript).toContain('dataDeploymentContinues');
    expect(deployScript).toContain('[[ "$DEPLOY_RUNNER_PROBE_SUCCEEDED" = true ]]');
    expect(deployScript).toContain('finish_stage degraded');

    expect(briefingRolloutWorkflow).toContain(
      'scripts/run-briefing-control-probe.sh "$env_file" "$migration_env_file" "$ROLLOUT_SHA" "$runner_socket"',
    );
    expect(briefingRolloutWorkflow).not.toContain('dataDeploymentContinues');
  });

  test('requires exact successful CI for both automatic and manual deployment', () => {
    expect(workflow).toContain(`github.event.workflow_run.event == ${quote}push${quote}`);
    expect(workflow).toContain('test "$WORKFLOW_EVENT" = "push"');
    expect(workflow).toContain('test "$main_sha" = "$WORKFLOW_SHA"');
    expect(workflow).toContain(
      'actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=$main_sha&per_page=20',
    );
    expect(workflow).toContain('.status == "completed" and .conclusion == "success"');
    expect(workflow).toContain('test "$ci_success_count" -gt 0');
    expect(workflow).not.toContain('script_stop:');
  });

  test('repairs malformed migration env line endings without exposing values', () => {
    expect(cleanupWorkflow).toContain(['grep -Fq ', quote, '\\n', quote].join(''));
    expect(cleanupWorkflow).toContain('lineEndingsNormalized');
    expect(cleanupWorkflow).toContain('credentialValueExposed":false');
    expect(cleanupWorkflow).not.toContain('script_stop:');
  });

  test('scans the immutable digest before promotion and SSH deployment', () => {
    const push = workflow.indexOf('Build and push immutable SHA image');
    const scan = workflow.indexOf('Scan immutable image digest');
    const promote = workflow.indexOf('Promote scanned digest to latest');
    const deploy = workflow.indexOf('Deploy exact image digest');

    expect(push).toBeGreaterThan(-1);
    expect(scan).toBeGreaterThan(push);
    expect(promote).toBeGreaterThan(scan);
    expect(deploy).toBeGreaterThan(promote);
    expect(workflow).toContain(`ignore-unfixed: ${quote}false${quote}`);
    expect(workflow).toContain('severity: HIGH,CRITICAL');
    expect(workflow).not.toContain('--tag "${IMAGE_NAME}:latest" \\\n');
    expect(workflow).toContain(
      'docker buildx imagetools create --tag "${IMAGE_NAME}:latest" "${IMAGE_REF}"',
    );
    expect(workflow).toContain('test "$latest_digest" = "$expected_digest"');
  });

  test('retains current and rollback Data digests and removes only unused failed digests', () => {
    const commit = workflow.indexOf('deployment_committed=true');
    const successCleanup = workflow.lastIndexOf('cleanup_obsolete_data_digests');
    const failedCleanupCall = workflow.indexOf('cleanup_failed_image "${IMAGE_REF:-}"');

    expect(failedCleanupCall).toBeGreaterThan(-1);
    expect(successCleanup).toBeGreaterThan(commit);
    expect(workflow).toContain('image_pull_attempted=true');
    expect(workflow).toContain(
      'if [ "$original_status" -ne 0 ] && [ "$image_pull_attempted" = true ]; then',
    );
    expect(workflow).toContain('docker image ls --no-trunc --digests');
    expect(workflow).toContain('[ "$digest_ref" = "$IMAGE_REF" ]');
    expect(workflow).toContain('[ "$digest_ref" = "$old_image" ]');
    expect(workflow).toContain('done < <(docker ps -aq');
    expect(workflow).toContain('image_id_is_referenced "$digest_id"');
    expect(workflow).toContain('docker image rm "$image_ref"');
  });

  test('restores only a recently proven coherent rollback runtime', () => {
    expect(deployStateMachine).toContain('release_sha_for_image');
    expect(deployStateMachine).toContain('release_sha_for_container');
    expect(deployStateMachine).toContain('rollback_runtime_is_eligible');
    expect(deployStateMachine).toContain('"$previous_revision" = "$previous_release_sha"');
    expect(deployStateMachine).toContain('"$container_state" = running');
    expect(deployStateMachine).toContain('"$container_health" = healthy');
    expect(deployStateMachine).toContain('http://127.0.0.1:3000/health/deploy');
    expect(deployStateMachine).toContain('payload?.deploySha !== expected');
    expect(deployStateMachine).toContain('rollback_eligible=${7:-false}');
    expect(deployStateMachine).toContain('"$rollback_eligible" != true');
    expect(deployStateMachine).toContain('restore_runtime_services');
    expect(deployStateMachine).toContain('export DEPLOY_SHA="$previous_release_sha"');
    expect(deployStateMachine).toContain(
      'export CONTENT_MANIFEST_GIT_REVISION="$previous_release_sha"',
    );
    expect(deployStateMachine).toContain(
      'export CONTENT_GROK_RUNNER_RELEASE_SHA="$previous_runner_release_sha"',
    );
    expect(deployScript).toContain(
      String.raw`DEPLOY_OLD_IMAGE=$(docker inspect --format '{{.Config.Image}}'`,
    );
    expect(deployScript).toContain(
      String.raw`DEPLOY_OLD_IMAGE_ID=$(docker inspect --format '{{.Image}}'`,
    );
    expect(deployScript).toContain('DEPLOY_OLD_RELEASE_SHA=$(release_sha_for_container');
    expect(deployScript).toContain('resolved_old_revision=$(git -C');
    expect(deployScript).toContain('DEPLOY_ROLLBACK_ELIGIBLE=false');
    expect(deployScript).toContain('DEPLOY_ROLLBACK_ELIGIBLE=true');
    expect(deployScript).toContain('"$DEPLOY_ROLLBACK_ELIGIBLE" != true');
    expect(deployScript).toContain('DEPLOY_OLD_RUNNER_RELEASE_SHA=$(cat');
    expect(workflow).toContain('old_release_sha=$(release_sha_for_container "$old_container")');
    expect(workflow).toContain('old_release_sha=$(release_sha_for_image "$old_image")');
    expect(workflow).toContain(String.raw`old_image_id=$(docker inspect --format '{{.Image}}'`);
    expect(workflow).toContain('old_runtime_rollback_eligible=false');
    expect(workflow).toContain('old_runtime_rollback_eligible=true');
    expect(workflow).toContain('[ "$old_runtime_rollback_eligible" = true ]');
    expect(workflow.lastIndexOf('rollback_runtime_is_eligible')).toBeGreaterThan(
      workflow.indexOf('migration plan and queue quiescence passed before stopping services'),
    );
    expect(workflow.lastIndexOf('rollback_runtime_is_eligible')).toBeLessThan(
      workflow.indexOf('services_stopped=true'),
    );
    expect(deployScript.lastIndexOf('rollback_runtime_is_eligible')).toBeGreaterThan(
      deployScript.indexOf('Migration plan and queue quiescence passed before stopping services'),
    );
    expect(deployScript.lastIndexOf('rollback_runtime_is_eligible')).toBeLessThan(
      deployScript.indexOf('DEPLOY_SERVICES_STOPPED=true'),
    );
    expect(workflow).toContain('old_runner_release_sha=$(cat');
    expect(workflow).toContain('"$old_image" "$old_release_sha" "$old_runner_release_sha"');
    expect(runtimeHealthScript).toContain('curl_timeout_with_deadline()');
    expect(runtimeHealthScript).toContain('--max-time "$timeout"');
  });

  test('rejects a rollback runtime unless identity, health, and strict readiness agree', () => {
    expect(runRollbackEligibility().exitCode).toBe(0);
    expect(runRollbackEligibility({ MOCK_CONTAINER_RELEASE: '' }).exitCode).toBe(0);
    expect(
      runRollbackEligibility({
        MOCK_PREVIOUS_REVISION: '89abcdef0123456789abcdef0123456789abcdef',
      }).exitCode,
    ).not.toBe(0);
    expect(runRollbackEligibility({ MOCK_CONTAINER_HEALTH: 'unhealthy' }).exitCode).not.toBe(0);
    expect(runRollbackEligibility({ MOCK_STRICT_HEALTH_STATUS: '1' }).exitCode).not.toBe(0);
  });

  test('weekly security workflow scans a freshly built production image', () => {
    expect(securityWorkflow).toContain(`cron: ${quote}0 18 * * 6${quote}`);
    expect(securityWorkflow).toContain('docker build --tag letletme-data:security-scan .');
    expect(securityWorkflow).toContain('image-ref: letletme-data:security-scan');
    expect(securityWorkflow).toContain('ignore-unfixed: false');
    expect(securityWorkflow).toContain('severity: HIGH,CRITICAL');
  });
});
