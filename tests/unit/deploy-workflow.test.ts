import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const securityWorkflow = readFileSync('.github/workflows/security.yml', 'utf8');
const backupScript = readFileSync('scripts/pre-migration-backup.sh', 'utf8');
const quote = String.fromCharCode(39);

describe('release workflow gates', () => {
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
    expect(ciWorkflow).not.toContain(`bun-version: [${quote}1.3.3${quote}]`);
    expect(ciWorkflow).toContain(`bun-version: [${quote}1.3.14${quote}]`);
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
