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
    expect(ciWorkflow).toContain('docker volume create "$briefing_grok_volume"');
    expect(ciWorkflow).toContain(
      'type=volume,source=$briefing_grok_volume,target=/home/appuser/.grok',
    );
    expect(ciWorkflow).toContain('test -x "$GROK_HOME/bin/grok-1.0.5"');
    expect(ciWorkflow).not.toContain('--tmpfs /home/appuser/.grok:');
  });

  test('keeps Briefing acquisition rollout on protected main with rollback and fixed modes', () => {
    expect(briefingRolloutWorkflow).toContain(`if: github.ref == ${quote}refs/heads/main${quote}`);
    expect(briefingRolloutWorkflow).toContain('test "$main_sha" = "$GITHUB_SHA"');
    expect(briefingRolloutWorkflow).toContain('test "$(git rev-parse HEAD)" = "$ROLLOUT_SHA"');
    expect(briefingRolloutWorkflow).toContain(
      'options:\n          - status\n          - shadow\n          - disabled',
    );
    expect(briefingRolloutWorkflow).toContain('mv "$backup_file" "$env_file"');
    expect(briefingRolloutWorkflow).toContain('--force-recreate \\\n');
    expect(briefingRolloutWorkflow).toContain('content-worker || rollback_status=1');
    expect(briefingRolloutWorkflow).toContain('/app/node_modules/.bin/grok models');
    expect(briefingRolloutWorkflow).toContain('auth_file="$HOME/.grok/auth.json"');
    expect(briefingRolloutWorkflow).toContain('seed_existing_grok_auth');
    expect(briefingRolloutWorkflow).toContain('secretValueExposed":false');
    expect(briefingRolloutWorkflow).toContain('briefing rollout rollback failed');
    expect(briefingRolloutWorkflow).toContain(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    expect(briefingRolloutWorkflow).toContain(`SET LOCAL statement_timeout = ${quote}15s${quote}`);
    expect(briefingRolloutWorkflow).toContain('briefing_acquisition_control_health');
    expect(briefingRolloutWorkflow).toContain('briefing_acquisition_run_health');
    expect(briefingRolloutWorkflow).toContain('briefing_acquisition_fact_health');
    expect(briefingRolloutWorkflow).not.toContain('error_summary,');
    expect(briefingRolloutWorkflow).not.toContain('tar -C "$HOME/.grok"');
    expect(briefingRolloutWorkflow).not.toContain('script_stop:');
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
