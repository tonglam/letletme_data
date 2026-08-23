import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporaryDirectories: string[] = [];
const sourceSecret = 'source-server-only-secret';

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'source-media-bootstrap-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeDeployEnv(directory: string, extra = ''): string {
  const file = join(directory, '.env.deploy');
  writeFileSync(
    file,
    [
      'BUG_REPORT_SCREENSHOT_SUPABASE_URL="https://project.supabase.co"',
      `BUG_REPORT_SCREENSHOT_SUPABASE_SECRET_KEY=${sourceSecret}`,
      extra,
    ].join('\n'),
  );
  chmodSync(file, 0o600);
  return file;
}

function validMediaEnv(secret: string): string {
  return [
    'CONTENT_MEDIA_WORKER_ENABLED=false',
    'CONTENT_MEDIA_SUPABASE_URL=https://project.supabase.co',
    `CONTENT_MEDIA_SUPABASE_SECRET_KEY=${secret}`,
    'CONTENT_MEDIA_BUCKET=briefing-source-media',
    'CONTENT_MEDIA_CONCURRENCY=2',
    'CONTENT_MEDIA_RETENTION_ENABLED=false',
    '',
  ].join('\n');
}

async function bootstrap(deployEnv: string, mediaEnv: string) {
  const child = Bun.spawn(
    ['bash', 'scripts/bootstrap-briefing-source-media-env.sh', deployEnv, mediaEnv],
    {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
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

describe('Briefing source-media env bootstrap', () => {
  test('atomically creates a private disabled media env without printing credentials', async () => {
    const directory = makeDirectory();
    const deployEnv = writeDeployEnv(directory);
    const mediaEnv = join(directory, '.env.media');

    const result = await bootstrap(deployEnv, mediaEnv);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"created":true');
    expect(`${result.stdout}${result.stderr}`).not.toContain(sourceSecret);
    expect(lstatSync(mediaEnv).mode & 0o777).toBe(0o600);
    expect(readFileSync(mediaEnv, 'utf8')).toBe(validMediaEnv(sourceSecret));
  });

  test('validates but never overwrites an existing dedicated media env', async () => {
    const directory = makeDirectory();
    const deployEnv = writeDeployEnv(directory);
    const mediaEnv = join(directory, '.env.media');
    const dedicatedSecret = 'already-dedicated-secret';
    const before = validMediaEnv(dedicatedSecret);
    writeFileSync(mediaEnv, before);
    chmodSync(mediaEnv, 0o600);

    const result = await bootstrap(deployEnv, mediaEnv);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"created":false');
    expect(readFileSync(mediaEnv, 'utf8')).toBe(before);
    expect(`${result.stdout}${result.stderr}`).not.toContain(sourceSecret);
    expect(`${result.stdout}${result.stderr}`).not.toContain(dedicatedSecret);
  });

  test('fails closed on duplicate source credentials and unsafe targets', async () => {
    const duplicateDirectory = makeDirectory();
    const duplicateDeployEnv = writeDeployEnv(
      duplicateDirectory,
      'BUG_REPORT_SCREENSHOT_SUPABASE_SECRET_KEY=second-secret',
    );
    const duplicateTarget = join(duplicateDirectory, '.env.media');

    const duplicateResult = await bootstrap(duplicateDeployEnv, duplicateTarget);
    expect(duplicateResult.exitCode).not.toBe(0);
    expect(duplicateResult.stderr).toContain('duplicate assignment');
    expect(`${duplicateResult.stdout}${duplicateResult.stderr}`).not.toContain(sourceSecret);
    expect(existsSync(duplicateTarget)).toBe(false);

    const symlinkDirectory = makeDirectory();
    const symlinkDeployEnv = writeDeployEnv(symlinkDirectory);
    const symlinkTarget = join(symlinkDirectory, '.env.media');
    symlinkSync(join(symlinkDirectory, 'missing-target'), symlinkTarget);

    const symlinkResult = await bootstrap(symlinkDeployEnv, symlinkTarget);
    expect(symlinkResult.exitCode).not.toBe(0);
    expect(symlinkResult.stderr).toContain('not a regular file');
    expect(lstatSync(symlinkTarget).isSymbolicLink()).toBe(true);

    const directoryTargetDirectory = makeDirectory();
    const directoryTargetDeployEnv = writeDeployEnv(directoryTargetDirectory);
    const directoryTarget = join(directoryTargetDirectory, '.env.media');
    mkdirSync(directoryTarget);

    const directoryResult = await bootstrap(directoryTargetDeployEnv, directoryTarget);
    expect(directoryResult.exitCode).not.toBe(0);
    expect(directoryResult.stderr).toContain('not a regular file');
    expect(lstatSync(directoryTarget).isDirectory()).toBe(true);
  });
});
