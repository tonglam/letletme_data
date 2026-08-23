import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporaryDirectories: string[] = [];

function makeEnv(extra = ''): string {
  const directory = mkdtempSync(join(tmpdir(), 'source-media-env-'));
  temporaryDirectories.push(directory);
  const file = join(directory, '.env.media');
  writeFileSync(
    file,
    [
      'CONTENT_MEDIA_WORKER_ENABLED=false',
      'CONTENT_MEDIA_SUPABASE_URL=https://project.supabase.co',
      'CONTENT_MEDIA_SUPABASE_SECRET_KEY=server-only-secret',
      'CONTENT_MEDIA_BUCKET=briefing-source-media',
      'CONTENT_MEDIA_CONCURRENCY=2',
      'CONTENT_MEDIA_RETENTION_ENABLED=false',
      extra,
    ].join('\n'),
  );
  chmodSync(file, 0o600);
  return file;
}

async function configure(mode: string, file: string) {
  const child = Bun.spawn(['bash', 'scripts/configure-briefing-source-media-env.sh', mode, file], {
    cwd: process.cwd(),
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

describe('Briefing source-media env configurator', () => {
  test('enables the worker without enabling retention and never prints the secret', async () => {
    const file = makeEnv();
    const result = await configure('enable', file);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"workerEnabled":true');
    expect(result.stdout).toContain('"retentionEnabled":false');
    expect(result.stdout).not.toContain('server-only-secret');
    const updated = readFileSync(file, 'utf8');
    expect(updated.match(/^CONTENT_MEDIA_WORKER_ENABLED=/gm)).toHaveLength(1);
    expect(updated).toContain('CONTENT_MEDIA_WORKER_ENABLED=true');
    expect(updated).toContain('CONTENT_MEDIA_RETENTION_ENABLED=false');
    expect(updated).toContain('CONTENT_MEDIA_SUPABASE_SECRET_KEY=server-only-secret');
  });

  test('allows retention only as an explicit separate mode', async () => {
    const file = makeEnv();
    expect((await configure('enable-retention', file)).exitCode).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain('CONTENT_MEDIA_RETENTION_ENABLED=true');

    expect((await configure('disable', file)).exitCode).toBe(0);
    const disabled = readFileSync(file, 'utf8');
    expect(disabled).toContain('CONTENT_MEDIA_WORKER_ENABLED=false');
    expect(disabled).toContain('CONTENT_MEDIA_RETENTION_ENABLED=false');
  });

  test('rejects an existing configuration with retention enabled but worker disabled', async () => {
    const file = makeEnv();
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        'CONTENT_MEDIA_RETENTION_ENABLED=false',
        'CONTENT_MEDIA_RETENTION_ENABLED=true',
      ),
    );
    chmodSync(file, 0o600);

    const result = await configure('status', file);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('retention requires the media worker to be enabled');
    expect(result.stderr).not.toContain('server-only-secret');
  });

  test('rejects duplicate keys, non-private files, and contract drift', async () => {
    const duplicate = makeEnv('CONTENT_MEDIA_WORKER_ENABLED=true');
    expect((await configure('status', duplicate)).exitCode).not.toBe(0);

    const publicFile = makeEnv();
    chmodSync(publicFile, 0o644);
    expect((await configure('status', publicFile)).exitCode).not.toBe(0);

    const wrongConcurrency = makeEnv().replace(/\.env\.media$/, '.env.media');
    writeFileSync(
      wrongConcurrency,
      readFileSync(wrongConcurrency, 'utf8').replace(
        'CONTENT_MEDIA_CONCURRENCY=2',
        'CONTENT_MEDIA_CONCURRENCY=3',
      ),
    );
    chmodSync(wrongConcurrency, 0o600);
    expect((await configure('status', wrongConcurrency)).exitCode).not.toBe(0);
  });
});
