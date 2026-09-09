import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const stateMachine = readFileSync('scripts/deploy-state-machine.sh', 'utf8').replaceAll(
  '/usr/local/libexec/vps-maintenance',
  'mock_maintenance',
);
const deploy = readFileSync('scripts/deploy.sh', 'utf8');

function runCleanup(failedMode = '') {
  return spawnSync(
    'bash',
    [
      '-c',
      `${stateMachine}
    mock_maintenance() {
      echo "fd=$VPS_PLATFORM_DEPLOY_LOCK_FD $*"
      if [[ "$*" == *"${failedMode || 'never-fail'}"* ]]; then return 1; fi
    }
    deploy_lock_fd=17
    cleanup_committed_deploy_images
  `,
    ],
    { encoding: 'utf8' },
  );
}

describe('post-deploy image cleanup', () => {
  test('passes the held lock and limits both passes to Data', () => {
    const result = runCleanup();
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'fd=17 cleanup --dry-run --mode=deploy --service=data',
      'fd=17 cleanup --mode=deploy --service=data',
    ]);
  });

  test('a failed dry-run prevents deletion without failing the release', () => {
    const result = runCleanup('--dry-run');
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('dry-run failed');
  });

  test('an apply failure is visible but does not fail the release', () => {
    const result = runCleanup('cleanup --mode=deploy');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('image cleanup failed');
  });

  test('only committed successful exits clean images before releasing the lock', () => {
    expect(deploy).toContain(
      'if [[ "$status" -eq 0 && "$DEPLOY_COMMITTED" = true ]]; then\n      cleanup_committed_deploy_images\n    fi\n    release_deploy_lock',
    );
    expect(
      deploy.indexOf('if ! release_source_media_deploy_fence; then status=1; fi'),
    ).toBeLessThan(deploy.indexOf('      cleanup_committed_deploy_images'));
  });
});
