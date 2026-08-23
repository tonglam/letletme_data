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
const backupScript = readFileSync('scripts/pre-migration-backup.sh', 'utf8');
const contentWorker = readFileSync('src/content-worker.ts', 'utf8');
const dockerfile = readFileSync('Dockerfile', 'utf8');
const hostRunnerDeployScript = readFileSync('scripts/deploy-host-grok-runner.sh', 'utf8');
const controlProbeScript = readFileSync('scripts/run-briefing-control-probe.sh', 'utf8');
const rearmScript = readFileSync('scripts/rearm-briefing-x-after-probe.sh', 'utf8');
const hostRunnerRollbackScript = readFileSync('scripts/rollback-host-grok-runner.sh', 'utf8');
const hostRunnerService = readFileSync('deploy/letletme-grok-runner.service', 'utf8');
const deployScript = readFileSync('scripts/deploy.sh', 'utf8');
const sourceMediaBootstrapScript = readFileSync(
  'scripts/bootstrap-briefing-source-media-env.sh',
  'utf8',
);
const deployStateMachine = readFileSync('scripts/deploy-state-machine.sh', 'utf8');
const runtimeHealthScript = readFileSync('scripts/verify-runtime-health.sh', 'utf8');
const composeFile = readFileSync('docker-compose.yml', 'utf8');
const mediaWorker = readFileSync('src/media-worker.ts', 'utf8');
const mediaConfig = readFileSync('src/content/media/source-media-config.ts', 'utf8');
const queueQuiescence = readFileSync('scripts/assert-queue-quiescence.ts', 'utf8');
const quote = String.fromCharCode(39);

describe('release workflow gates', () => {
  test('keeps the content worker alive when the pipeline is disabled', () => {
    expect(contentWorker).toContain('publicationOutboxDispatcher = setInterval');
    expect(contentWorker).not.toContain('publicationOutboxDispatcher.unref?.()');
    expect(contentWorker).not.toContain('scheduler.unref?.()');
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
    expect(sourceMediaBootstrapScript).toContain('-nT');
    expect(sourceMediaBootstrapScript).toContain('--no-target-directory');
    expect(sourceMediaBootstrapScript).toContain('! -f "$media_env_file"');
    expect(sourceMediaBootstrapScript).not.toContain('set -x');
    expect(deployScript).toContain('briefing_source_media_health');
    expect(workflow).toContain('docker compose stop -t 45 scheduler content-worker media-worker');
    expect(workflow).toContain('"$old_media_present" || true');
    expect(deployStateMachine).toContain(
      'export RUNTIME_INCLUDE_MEDIA_WORKER="$previous_media_present"',
    );
  });

  test('allows only session-mode pooler connections for the external backup', () => {
    expect(backupScript).toContain('*pgbouncer=true*|*:6543/*');
    expect(backupScript).not.toContain('*pooler.supabase.com*');
    expect(backupScript).toContain('Supabase session pooler on port 5432');
    expect(backupScript).toContain('--dbname="$DATABASE_URL"');
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
    expect(
      sourceMediaRolloutWorkflow.indexOf(
        'source-media rollout refused: Storage secret is present in .env.deploy',
      ),
    ).toBeLessThan(sourceMediaRolloutWorkflow.indexOf('if [ ! -e "$media_env_file" ]'));
    expect(sourceMediaRolloutWorkflow).toContain('acquire_deploy_lock');
    expect(sourceMediaRolloutWorkflow).toContain('release_deploy_lock');
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
    expect(rearmScript).toContain(
      `identity_status IN (${quote}PENDING${quote}, ${quote}FAILED${quote})`,
    );
    expect(rearmScript).toContain('latest_runner_failure');
    expect(rearmScript).toContain(`${quote}RUNNER_NOT_READY${quote}`);
  });

  test('does not roll back Data when the optional Briefing provider probe is degraded', () => {
    expect(workflow).toContain('runner_probe_succeeded=false');
    expect(workflow).toContain('if scripts/run-briefing-control-probe.sh');
    expect(workflow).toContain('dataDeploymentContinues');
    expect(workflow).toContain('[ "$runner_probe_succeeded" = true ]');
    expect(workflow).toContain('finish_stage degraded');

    expect(deployScript).toContain('DEPLOY_RUNNER_PROBE_SUCCEEDED=false');
    expect(deployScript).toContain('if "${PROJECT_DIR}/scripts/run-briefing-control-probe.sh"');
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

  test('restores the rollback image with its own release identity', () => {
    expect(deployStateMachine).toContain('release_sha_for_image');
    expect(deployStateMachine).toContain('restore_runtime_services');
    expect(deployStateMachine).toContain('export DEPLOY_SHA="$previous_release_sha"');
    expect(deployStateMachine).toContain(
      'export CONTENT_MANIFEST_GIT_REVISION="$previous_release_sha"',
    );
    expect(deployStateMachine).toContain(
      'export CONTENT_GROK_RUNNER_RELEASE_SHA="$previous_runner_release_sha"',
    );
    expect(deployScript).toContain('DEPLOY_OLD_RELEASE_SHA=$(release_sha_for_image');
    expect(deployScript).toContain('DEPLOY_OLD_RUNNER_RELEASE_SHA=$(cat');
    expect(workflow).toContain('old_release_sha=$(release_sha_for_image "$old_image")');
    expect(workflow).toContain('old_runner_release_sha=$(cat');
    expect(workflow).toContain('"$old_image" "$old_release_sha" "$old_runner_release_sha"');
    expect(runtimeHealthScript).toContain('--max-time "$curl_timeout_seconds"');
  });

  test('weekly security workflow scans a freshly built production image', () => {
    expect(securityWorkflow).toContain(`cron: ${quote}0 18 * * 6${quote}`);
    expect(securityWorkflow).toContain('docker build --tag letletme-data:security-scan .');
    expect(securityWorkflow).toContain('image-ref: letletme-data:security-scan');
    expect(securityWorkflow).toContain('ignore-unfixed: false');
    expect(securityWorkflow).toContain('severity: HIGH,CRITICAL');
  });
});
