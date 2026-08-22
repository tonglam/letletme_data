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
const backupScript = readFileSync('scripts/pre-migration-backup.sh', 'utf8');
const contentWorker = readFileSync('src/content-worker.ts', 'utf8');
const dockerfile = readFileSync('Dockerfile', 'utf8');
const hostRunnerDeployScript = readFileSync('scripts/deploy-host-grok-runner.sh', 'utf8');
const controlProbeScript = readFileSync('scripts/run-briefing-control-probe.sh', 'utf8');
const hostRunnerRollbackScript = readFileSync('scripts/rollback-host-grok-runner.sh', 'utf8');
const quote = String.fromCharCode(39);

describe('release workflow gates', () => {
  test('keeps the content worker alive when the pipeline is disabled', () => {
    expect(contentWorker).toContain('publicationOutboxDispatcher = setInterval');
    expect(contentWorker).not.toContain('publicationOutboxDispatcher.unref?.()');
    expect(contentWorker).not.toContain('scheduler.unref?.()');
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
    expect(ciWorkflow).not.toContain(`bun-version: [${quote}1.3.3${quote}]`);
    expect(ciWorkflow).toContain(`bun-version: [${quote}1.3.14${quote}]`);
    expect(ciWorkflow).toContain('test -x /app/letletme-grok-runner');
    expect(ciWorkflow).toContain('getent group letletme-grok-bridge');
    expect(ciWorkflow).not.toContain('grok-home');
    expect(ciWorkflow).not.toContain('auth.json');
    expect(dockerfile).toContain('COPY --from=build /app/config/briefing ./config/briefing');
    expect(ciWorkflow).toContain('test -r /app/config/briefing/sources.yaml');
    expect(ciWorkflow).toContain('test -r /app/config/briefing/acquisition-plan.yaml');
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
    expect(briefingRolloutWorkflow).not.toContain('briefing_acquisition_fact_health');
    expect(briefingRolloutWorkflow).not.toContain('error_summary,');
    expect(briefingRolloutWorkflow).not.toContain('tar -C "$HOME/.grok"');
    expect(briefingRolloutWorkflow).not.toContain('script_stop:');
    expect(hostRunnerDeployScript).toContain('--self-test');
    expect(hostRunnerDeployScript).not.toContain('/v1/probes/x');
    expect(controlProbeScript).toContain('GLOBAL:GROK_BUILD_X');
    expect(controlProbeScript).toContain('content.acquisition_budget_reservations');
    expect(controlProbeScript).toContain('CONTROL_PLANE_PROBE');
    expect(controlProbeScript).toContain('lease_expires_at < now()');
    expect(controlProbeScript).toContain('CONTROL_PROBE_INTERRUPTED');
    expect(controlProbeScript).toContain('controlProbeRecovery');
    expect(hostRunnerDeployScript).toContain('rollback_on_failure');
    expect(hostRunnerRollbackScript).toContain('/home/workspace/letletme-grok-runner');
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

  test('weekly security workflow scans a freshly built production image', () => {
    expect(securityWorkflow).toContain(`cron: ${quote}0 18 * * 6${quote}`);
    expect(securityWorkflow).toContain('docker build --tag letletme-data:security-scan .');
    expect(securityWorkflow).toContain('image-ref: letletme-data:security-scan');
    expect(securityWorkflow).toContain('ignore-unfixed: false');
    expect(securityWorkflow).toContain('severity: HIGH,CRITICAL');
  });
});
