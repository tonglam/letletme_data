import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (relativePath: string): string => readFileSync(join(root, relativePath), 'utf8');

const documentation = [
  'README.md',
  'CLAUDE.md',
  'DEPLOYMENT.md',
  'docs/SYSTEM_CONTRACTS.md',
  'docs/cache-ttl-summary.md',
  'docs/redis-contract.md',
  'docs/job-schedule.md',
  'tests/README.md',
  'migrations/README.md',
]
  .map(read)
  .join('\n');

function maintenanceJobNames(): Record<string, string> {
  const source = read('src/queues/maintenance.queue.ts');
  return Object.fromEntries(
    [...source.matchAll(/^\s*([A-Z_]+): '([^']+)'/gm)].map((match) => [match[1], match[2]]),
  );
}

function schedulerRegistryNames(): readonly string[] {
  const source = read('src/scheduler/job-registry.ts');
  const maintenance = maintenanceJobNames();
  return [
    ...new Set(
      [...source.matchAll(/name:\s*(?:'([^']+)'|MAINTENANCE_JOBS\.([A-Z_]+))/g)].map(
        (match) => match[1] ?? maintenance[match[2]] ?? `MISSING:${match[2]}`,
      ),
    ),
  ];
}

describe('runtime inventory documentation contract', () => {
  test('does not advertise the retired live league finalization marker', () => {
    const redisContract = read('docs/redis-contract.md');
    expect(redisContract).not.toContain('league-live:<season>:<event>:finalization-desired');
    expect(redisContract).toContain('ops.scheduler_obligations');
    expect(redisContract).toContain('checkpoint-desired');
  });

  test('documents every executable queue name', () => {
    const source = read('src/queues/names.ts');
    const queueNames = [
      ...new Set(
        [...source.matchAll(/^export const \w+QueueName = '([^']+)'/gm)].map((match) => match[1]),
      ),
    ];

    expect(queueNames).toHaveLength(23);
    for (const queueName of queueNames) {
      expect(documentation).toContain(`\`${queueName}\``);
    }
  });

  test('documents all seven build entrypoints and long-lived compose services', () => {
    const packageJson = JSON.parse(read('package.json')) as { scripts?: { build?: string } };
    const build = packageJson.scripts?.build ?? '';
    const entrypoints = [
      ...new Set([...build.matchAll(/src\/([a-z0-9-]+\.ts)/g)].map((match) => `src/${match[1]}`)),
    ];
    expect(entrypoints).toHaveLength(7);
    for (const entrypoint of entrypoints) expect(documentation).toContain(entrypoint);

    const compose = read('docker-compose.yml');
    const services = [
      ...new Set([...compose.matchAll(/^  ([a-z][a-z0-9-]+):$/gm)].map((match) => match[1])),
    ];
    const longLived = [
      'api',
      'worker',
      'scheduler',
      'live-picks-worker',
      'official-h2h-worker',
      'content-worker',
      'media-worker',
    ];
    expect(services).toEqual(expect.arrayContaining(['migration', 'backup', ...longLived]));
    for (const service of longLived) expect(documentation).toContain(`\`${service}\``);
  });

  test('documents every scheduler registry definition and compatibility alias', () => {
    const names = schedulerRegistryNames();
    expect(names).toHaveLength(39);
    for (const name of names) expect(read('docs/job-schedule.md')).toContain(name);

    const aliases = [
      'core-snapshot-sync',
      'event-current-refresh',
      'player-prices',
      'player-stats-sync',
      'player-values-sync',
      'entry-info-daily',
      'entry-event-results-daily',
      'league-event-results-sync',
      'tournament-event-results-sync',
      'tournament-selection-stats-sync',
      'tournament-info-sync',
      'tournament-materialized-views-refresh',
    ];
    for (const alias of aliases) expect(read('docs/job-schedule.md')).toContain(alias);
  });

  test('documents the key families emitted by Redis builders', () => {
    const publicationSource = read('src/cache/data-publication.ts');
    const hotSource = read('src/services/price-change-hot.service.ts');
    const previewSource = read('src/services/tournament-preview.service.ts');
    const admissionSource = read('src/utils/fpl-admission.ts');
    const heartbeatSource = read('src/utils/runtime-heartbeat.ts');
    const schedulerProgressSource = read('src/scheduler/scheduler-progress.ts');
    const governanceSource = read('src/services/queue-governance.service.ts');

    const constant = (source: string, name: string): string => {
      const value = new RegExp(`(?:export )?const ${name} = '([^']+)'`).exec(source)?.[1];
      if (!value) throw new Error(`Redis key constant ${name} is missing`);
      return value;
    };
    const families = [
      `${constant(publicationSource, 'DATA_CACHE_NAMESPACE')}:fpl:core:`,
      'llm:data:v2:fpl:live:',
      'llm:data:fpl:my-fpl:',
      `${constant(hotSource, 'HOT_KEY_PREFIX')}:`,
      'llm:tournament:preview:',
      constant(admissionSource, 'STATE_KEY').replace(/state$/, ''),
      'llm:queue:coordination:',
      `${constant(admissionSource, 'TELEMETRY_PREFIX')}`,
      'ops:runtime-heartbeat:',
      constant(schedulerProgressSource, 'SCHEDULER_PROGRESS_KEY'),
      constant(governanceSource, 'SNAPSHOT_PREFIX'),
      constant(governanceSource, 'ADMISSION_PREFIX'),
      constant(governanceSource, 'MONITOR_LEASE_PREFIX'),
    ];
    // Keep the runtime heartbeat source in the extraction set even though its
    // key is returned from a function rather than a named constant.
    expect(heartbeatSource).toContain('ops:runtime-heartbeat:');
    expect(previewSource).toContain('llm:tournament:preview:');
    for (const family of [...new Set(families)]) {
      expect(read('docs/redis-contract.md')).toContain(family);
    }
  });

  test('keeps migration identity and duplicate-prefix policy explicit', () => {
    const filenames = readdirSync(join(root, 'migrations'))
      .filter((filename) => filename.endsWith('.sql'))
      .sort();
    const byPrefix = new Map<string, string[]>();
    for (const filename of filenames) {
      const prefix = /^(\d+)_/.exec(filename)?.[1];
      if (!prefix) throw new Error(`Migration filename has no numeric prefix: ${filename}`);
      const entries = byPrefix.get(prefix) ?? [];
      entries.push(filename);
      byPrefix.set(prefix, entries);
    }
    const duplicatePrefixes = [...byPrefix.entries()]
      .filter(([, entries]) => entries.length > 1)
      .map(([prefix]) => prefix)
      .sort();
    expect(duplicatePrefixes).toEqual([
      '0016',
      '0017',
      '0018',
      '0019',
      '0020',
      '0025',
      '0026',
      '0032',
    ]);
    expect(read('migrations/README.md')).toContain('complete filename');
    for (const prefix of duplicatePrefixes) expect(read('migrations/README.md')).toContain(prefix);
  });

  test('does not advertise the removed generic Supabase client aliases', () => {
    const deployExample = read('.env.deploy.example');
    expect(deployExample).not.toMatch(/^SUPABASE_(URL|KEY)=/m);
  });
});
