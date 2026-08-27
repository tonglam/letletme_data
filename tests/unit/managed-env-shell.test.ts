import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const acquisitionScript = join(repoRoot, 'scripts/configure-briefing-acquisition-env.sh');
const mediaScript = join(repoRoot, 'scripts/configure-briefing-source-media-env.sh');
const managedEnvLibrary = join(repoRoot, 'scripts/lib/managed-env.sh');
const temporaryDirectories: string[] = [];

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'managed-env-shell-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeAcquisitionEnv(directory: string): string {
  const target = join(directory, '.env.deploy');
  writeFileSync(
    target,
    [
      'CONTENT_PUBLICATION_ENABLED=false',
      'BRIEFING_PUBLIC_ENABLED=false',
      'CONTENT_PIPELINE_ENABLED=false',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  chmodSync(target, 0o600);
  return target;
}

function writeMediaEnv(directory: string, content = ''): string {
  const target = join(directory, '.env.media');
  writeFileSync(target, content, { mode: 0o600 });
  chmodSync(target, 0o600);
  return target;
}

async function run(script: string, mode: string, target: string) {
  const child = Bun.spawn(['bash', script, mode, target], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('managed environment shell safety', () => {
  test('preserves owner, group, mode and regular-file metadata on replacement', async () => {
    const directory = makeDirectory();
    const target = writeAcquisitionEnv(directory);
    const before = statSync(target);

    const result = await run(acquisitionScript, 'host-shadow', target);

    expect(result.exitCode).toBe(0);
    const after = statSync(target);
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    expect(after.uid).toBe(before.uid);
    expect(after.gid).toBe(before.gid);
    expect(after.nlink).toBe(1);
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
  });

  test('rejects symlinks, directories and empty media files without changing them', async () => {
    const symlinkDirectory = makeDirectory();
    const symlinkTarget = join(symlinkDirectory, '.env.deploy');
    symlinkSync(join(symlinkDirectory, 'missing-target'), symlinkTarget);
    const symlinkResult = await run(acquisitionScript, 'status', symlinkTarget);
    expect(symlinkResult.exitCode).not.toBe(0);
    expect(symlinkResult.stderr).toContain('not a regular file');
    expect(lstatSync(symlinkTarget).isSymbolicLink()).toBe(true);

    const directory = makeDirectory();
    const directoryTarget = join(directory, '.env.deploy');
    mkdirSync(directoryTarget);
    const directoryResult = await run(acquisitionScript, 'status', directoryTarget);
    expect(directoryResult.exitCode).not.toBe(0);
    expect(directoryResult.stderr).toContain('not a regular file');
    expect(lstatSync(directoryTarget).isDirectory()).toBe(true);

    const emptyDirectory = makeDirectory();
    const emptyTarget = writeMediaEnv(emptyDirectory);
    const emptyResult = await run(mediaScript, 'status', emptyTarget);
    expect(emptyResult.exitCode).not.toBe(0);
    expect(readFileSync(emptyTarget, 'utf8')).toBe('');
    expect(statSync(emptyTarget).mode & 0o777).toBe(0o600);
  });

  test('retains the original file when a concurrent target change makes replacement unsafe', async () => {
    const directory = makeDirectory();
    const target = writeAcquisitionEnv(directory);
    const original = readFileSync(target, 'utf8');
    const child = Bun.spawn(
      [
        'bash',
        '-c',
        [
          'set -u',
          'source "$1"',
          'managed_env_capture_target "$2" test-target',
          'tmp=$(mktemp "$2.rollback.XXXXXX")',
          'printf replacement >"$tmp"',
          'chmod "$MANAGED_ENV_TARGET_MODE" "$tmp"',
          'managed_env_assert_temp_metadata "$tmp" test-replacement',
          'chmod 644 "$2"',
          'if managed_env_atomic_replace "$tmp" "$2" test-target; then exit 9; fi',
          'cat "$2"',
        ].join('; '),
        '--',
        managedEnvLibrary,
        target,
      ],
      { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe(original);
    expect(readFileSync(target, 'utf8')).toBe(original);
  });

  test('uses independent temporary files and leaves a valid result under concurrent updates', async () => {
    const directory = makeDirectory();
    const target = writeAcquisitionEnv(directory);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => run(acquisitionScript, 'host-shadow', target)),
    );

    expect(results.every((result) => result.exitCode === 0)).toBe(true);
    const content = readFileSync(target, 'utf8');
    expect(content.match(/^CONTENT_PIPELINE_ENABLED=/gm)).toHaveLength(1);
    expect(content.match(/^CONTENT_X_SCAN_ENABLED=/gm)).toHaveLength(1);
    expect(
      readdirSync(directory).filter((name) => /\.(briefing|source-media)\./.test(name)),
    ).toEqual([]);
  });
});
