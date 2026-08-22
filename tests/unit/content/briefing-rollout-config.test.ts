import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = 'scripts/configure-briefing-acquisition-env.sh';
const temporaryDirectories: string[] = [];

function fixture(lines: readonly string[], mode = 0o600): string {
  const directory = mkdtempSync(join(tmpdir(), 'briefing-rollout-'));
  temporaryDirectories.push(directory);
  const target = join(directory, '.env.deploy');
  writeFileSync(target, `${lines.join('\n')}\n`, { mode });
  chmodSync(target, mode);
  return target;
}

function run(mode: 'status' | 'shadow-http' | 'host-shadow' | 'disabled', target: string) {
  const result = Bun.spawnSync(['bash', script, mode, target], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function parse(result: ReturnType<typeof run>): Record<string, unknown> {
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Briefing acquisition rollout env control', () => {
  test('enables shadow adapters while deriving optional providers from existing secrets', () => {
    const target = fixture([
      'DATABASE_URL=postgresql://fixture',
      'CONTENT_PUBLICATION_ENABLED=false',
      'BRIEFING_PUBLIC_ENABLED=false',
      'HERMES_TRANSCRIPT_URL=https://hermes.invalid/transcribe',
      'HERMES_TRANSCRIPT_TOKEN=fixture-secret',
      'CONTENT_HERMES_DAILY_AUDIO_MINUTES=120',
      'YOUTUBE_DATA_API_KEY=fixture-youtube-secret',
      'SUPADATA_API_KEY=fixture-supadata-secret',
      'CONTENT_SUPADATA_DAILY_CREDIT_LIMIT=200',
      'CONTENT_PIPELINE_ENABLED=false',
    ]);

    expect(parse(run('host-shadow', target))).toMatchObject({
      mode: 'host-shadow',
      changed: true,
      pipeline: true,
      shadow: true,
      x: true,
      http: true,
      podcast: true,
      youtubeDiscovery: true,
      youtubeNative: true,
      youtubeGenerated: false,
      publication: false,
      public: false,
      hermesReady: true,
      youtubeNativeReady: true,
      secretValueExposed: false,
    });
    const content = readFileSync(target, 'utf8');
    expect(content).toContain('DATABASE_URL=postgresql://fixture');
    expect(content).toContain('HERMES_TRANSCRIPT_TOKEN=fixture-secret');
    expect(run('status', target).stdout).not.toContain('fixture-secret');
    expect(run('status', target).stdout).not.toContain('fixture-youtube-secret');
    expect(run('status', target).stdout).not.toContain('fixture-supadata-secret');
    expect(content.match(/^CONTENT_PIPELINE_ENABLED=/gm)).toHaveLength(1);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(parse(run('host-shadow', target))).toMatchObject({ changed: false });
  });

  test('keeps optional transcript adapters disabled when their prerequisites are absent', () => {
    const target = fixture([
      'DATABASE_URL=postgresql://fixture',
      'CONTENT_PUBLICATION_ENABLED=false',
      'BRIEFING_PUBLIC_ENABLED=false',
    ]);
    expect(parse(run('host-shadow', target))).toMatchObject({
      podcast: false,
      youtubeDiscovery: true,
      youtubeNative: false,
      youtubeGenerated: false,
      hermesReady: false,
      youtubeNativeReady: false,
    });
  });

  test('does not enable provider adapters from fractional budget settings', () => {
    const target = fixture([
      'CONTENT_PUBLICATION_ENABLED=false',
      'BRIEFING_PUBLIC_ENABLED=false',
      'HERMES_TRANSCRIPT_URL=https://hermes.invalid/transcribe',
      'HERMES_TRANSCRIPT_TOKEN=fixture-secret',
      'CONTENT_HERMES_DAILY_AUDIO_MINUTES=1.5',
      'YOUTUBE_DATA_API_KEY=fixture-youtube-secret',
      'SUPADATA_API_KEY=fixture-supadata-secret',
      'CONTENT_SUPADATA_DAILY_CREDIT_LIMIT=2.5',
    ]);

    expect(parse(run('host-shadow', target))).toMatchObject({
      podcast: false,
      youtubeNative: false,
      hermesReady: false,
      youtubeNativeReady: false,
    });
  });

  test('disables acquisition without exposing or removing unrelated settings', () => {
    const target = fixture([
      'DATABASE_URL=postgresql://fixture',
      'CONTENT_PUBLICATION_ENABLED=false',
      'BRIEFING_PUBLIC_ENABLED=false',
      'CONTENT_PIPELINE_ENABLED=true',
      'CONTENT_X_SCAN_ENABLED=true',
      'CONTENT_REAL_GROK_ENABLED=true',
    ]);
    expect(parse(run('disabled', target))).toMatchObject({
      mode: 'disabled',
      pipeline: false,
      x: false,
      http: false,
      publication: false,
      public: false,
    });
    expect(readFileSync(target, 'utf8')).toContain('DATABASE_URL=postgresql://fixture');
  });

  test('does not stop the shared pipeline when publication is already enabled', () => {
    const target = fixture([
      'CONTENT_PUBLICATION_ENABLED=true',
      'BRIEFING_PUBLIC_ENABLED=true',
      'CONTENT_PIPELINE_ENABLED=true',
      'CONTENT_X_SCAN_ENABLED=true',
    ]);

    expect(parse(run('disabled', target))).toMatchObject({
      pipeline: true,
      x: false,
      publication: true,
      public: true,
    });
    const shadow = run('host-shadow', target);
    expect(shadow.exitCode).not.toBe(0);
    expect(shadow.stderr).toContain('cannot alter a public publication runtime');
  });

  test('status is read-only and unsafe or duplicate files fail closed', () => {
    const target = fixture([
      'CONTENT_PUBLICATION_ENABLED=false',
      'BRIEFING_PUBLIC_ENABLED=false',
      'CONTENT_X_SCAN_ENABLED=false',
    ]);
    const before = readFileSync(target, 'utf8');
    expect(parse(run('status', target))).toMatchObject({ mode: 'status', changed: false });
    expect(readFileSync(target, 'utf8')).toBe(before);

    writeFileSync(target, `${before}CONTENT_X_SCAN_ENABLED=true\n`, { mode: 0o600 });
    const duplicate = run('status', target);
    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.stderr).toContain('duplicate assignment for CONTENT_X_SCAN_ENABLED');

    const duplicatePrerequisite = fixture([
      'CONTENT_PUBLICATION_ENABLED=false',
      'HERMES_TRANSCRIPT_TOKEN=first',
      'HERMES_TRANSCRIPT_TOKEN=second',
    ]);
    expect(run('status', duplicatePrerequisite).stderr).toContain(
      'duplicate assignment for HERMES_TRANSCRIPT_TOKEN',
    );

    const invalidBoolean = fixture(['CONTENT_PUBLICATION_ENABLED=perhaps']);
    expect(run('status', invalidBoolean).stderr).toContain(
      'invalid boolean assignment for CONTENT_PUBLICATION_ENABLED',
    );

    const publicFile = fixture(['CONTENT_PUBLICATION_ENABLED=false'], 0o644);
    expect(run('status', publicFile).exitCode).not.toBe(0);
  });
});
