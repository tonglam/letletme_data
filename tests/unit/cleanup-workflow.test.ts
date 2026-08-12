import { afterEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workflowPath = '.github/workflows/cleanup-legacy-runtime-secret.yml';
const fixturePath = 'tests/fixtures/env-migrate-legacy-secret.fixture';
const productionWorkdir = '/home/workspace/letletme_data';
const temporaryDirectories: string[] = [];
const darwinTools = ['gstat', 'grealpath', 'gsha256sum', 'gcut', 'gawk', 'gmv'];
const behaviorTest =
  process.platform === 'darwin' && darwinTools.some((tool) => !Bun.which(tool)) ? test.skip : test;

type ScriptResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function extractRemoteScript(): string {
  const lines = readFileSync(workflowPath, 'utf8').split('\n');
  const markerIndex = lines.indexOf('          script: |');
  expect(markerIndex).toBeGreaterThan(0);

  const scriptLines: string[] = [];
  for (const line of lines.slice(markerIndex + 1)) {
    if (line.length === 0) {
      scriptLines.push('');
    } else if (line.startsWith('            ')) {
      scriptLines.push(line.slice(12));
    } else {
      break;
    }
  }
  return scriptLines.join('\n');
}

function createFixtureDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'letletme-cleanup-')));
  temporaryDirectories.push(directory);
  copyFileSync(fixturePath, join(directory, '.env.migrate'));
  chmodSync(join(directory, '.env.migrate'), 0o600);
  return directory;
}

function adaptForHost(script: string, workdir: string): string {
  let adapted = script.replace(
    `expected_workdir=${productionWorkdir}`,
    `expected_workdir=${workdir}`,
  );
  if (process.platform !== 'darwin') return adapted;

  for (const [source, replacement] of [
    ['realpath --canonicalize-existing', 'grealpath --canonicalize-existing'],
    ['stat -c', 'gstat -c'],
    ['sha256sum', 'gsha256sum'],
    ['cut -d', 'gcut -d'],
    ['awk -v', 'gawk -v'],
    ['mv --no-target-directory', 'gmv --no-target-directory'],
  ]) {
    adapted = adapted.replaceAll(source, replacement);
  }
  return adapted;
}

function runCleanup(workdir: string): ScriptResult {
  const result = Bun.spawnSync(['bash', '-c', adaptForHost(extractRemoteScript(), workdir)], {
    env: { ...process.env, VPS_WORKDIR: workdir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function parseResult(result: ScriptResult): Record<string, unknown> {
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).not.toBe('');
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe('gated legacy runtime secret cleanup workflow', () => {
  behaviorTest('removes only the legacy assignment atomically and remains idempotent', () => {
    const directory = createFixtureDirectory();
    const target = join(directory, '.env.migrate');

    expect(parseResult(runCleanup(directory))).toMatchObject({
      event: 'legacy_secret_cleanup',
      name: 'GRAPHQL_RUNTIME_DB_PASSWORD',
      changed: true,
      remaining: false,
      credentialValueExposed: false,
    });

    const afterFirstRun = readFileSync(target, 'utf8');
    expect(afterFirstRun).not.toContain('GRAPHQL_RUNTIME_DB_PASSWORD');
    expect(afterFirstRun).toContain('DATABASE_URL=');
    expect(afterFirstRun).toContain('MIGRATION_STATEMENT_TIMEOUT_MS=120000');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(
      readdirSync(directory).filter((name) => name.startsWith('.env.migrate.cleanup.')),
    ).toEqual([]);

    expect(parseResult(runCleanup(directory))).toMatchObject({
      changed: false,
      remaining: false,
      credentialValueExposed: false,
    });
    expect(readFileSync(target, 'utf8')).toBe(afterFirstRun);
  });

  behaviorTest('refuses duplicate legacy assignments without changing the file', () => {
    const directory = createFixtureDirectory();
    const target = join(directory, '.env.migrate');
    appendFileSync(target, 'export GRAPHQL_RUNTIME_DB_PASSWORD=second_fixture_value\n');
    const before = readFileSync(target, 'utf8');

    const result = runCleanup(directory);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('cleanup refused: multiple legacy assignments exist');
    expect(readFileSync(target, 'utf8')).toBe(before);
    expect(
      readdirSync(directory).filter((name) => name.startsWith('.env.migrate.cleanup.')),
    ).toEqual([]);
  });
});
