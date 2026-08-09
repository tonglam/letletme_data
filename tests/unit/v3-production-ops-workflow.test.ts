import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');

function job(name: string, nextName?: string): string {
  const start = workflow.indexOf(`\n  ${name}:`);
  if (start < 0) throw new Error(`Missing workflow job ${name}`);
  const end = nextName ? workflow.indexOf(`\n  ${nextName}:`, start + 1) : workflow.length;
  if (end < 0) throw new Error(`Missing workflow job ${nextName}`);
  return workflow.slice(start, end);
}

describe('v3 production hard-cut workflow', () => {
  test('keeps the VPS preflight read-only', () => {
    const preflight = job('v3_preflight', 'v3_activate_database');

    for (const mutation of [
      'git fetch',
      'git reset',
      'docker compose pull',
      'docker compose run',
      'docker compose up',
      'docker compose stop',
    ]) {
      expect(preflight).not.toContain(mutation);
    }
    expect(preflight).toContain('docker compose ps --all');
  });

  test('requires GraphQL down and gates the exact release before stopping Data', () => {
    const activation = job('v3_activate_database', 'v3_redis_queues');
    const graphqlStopped = activation.indexOf('GraphQL is still running on port 4000');
    const releaseGate = activation.indexOf('bun scripts/v3-release-gate.ts');
    const migrationContract = activation.indexOf('bun run db:migration-contract');
    const stopWorker = activation.indexOf('docker compose stop -t 30 worker');
    const stopApi = activation.indexOf('docker compose stop -t 30 api');
    const migrate = activation.indexOf('bun run db:migrate');

    expect(graphqlStopped).toBeGreaterThan(0);
    expect(releaseGate).toBeGreaterThan(graphqlStopped);
    expect(migrationContract).toBeGreaterThan(releaseGate);
    expect(stopWorker).toBeGreaterThan(migrationContract);
    expect(stopApi).toBeGreaterThan(stopWorker);
    expect(migrate).toBeGreaterThan(stopApi);
    expect(activation).not.toContain('docker compose up');
  });

  test('keeps queue copy and cache publication separately manifest-gated', () => {
    const queues = job('v3_redis_queues', 'v3_core_cache');
    const cache = job('v3_core_cache', 'v3_start_api');

    expect(queues).toContain('V3_REDIS_QUEUE_MANIFEST_SHA256');
    expect(queues).toContain('redis:cutover copy-queues --execute');
    expect(queues).toContain('redis:cutover verify-queues');
    expect(cache).toContain('V3_CORE_CACHE_APPROVAL');
    expect(cache).toContain('cache:publish-core --execute');
  });

  test('starts the worker only after Data API, GraphQL, and queue verification pass', () => {
    const worker = job('v3_start_worker', 'v3_status');
    const dataHealth = worker.indexOf('http://127.0.0.1:3000/health');
    const graphqlHealth = worker.indexOf('http://127.0.0.1:4000/health');
    const queueVerification = worker.indexOf('redis:cutover verify-queues');
    const startWorker = worker.indexOf('docker compose up -d --no-deps --no-build worker');

    expect(dataHealth).toBeGreaterThan(0);
    expect(graphqlHealth).toBeGreaterThan(dataHealth);
    expect(queueVerification).toBeGreaterThan(graphqlHealth);
    expect(startWorker).toBeGreaterThan(queueVerification);
  });

  test('does not expose legacy cleanup as a production operation', () => {
    const operations = workflow.slice(
      workflow.indexOf('      operation:'),
      workflow.indexOf('      sha:'),
    );

    expect(operations).not.toContain('cleanup');
    expect(operations).not.toContain('legacy-drop');
    expect(workflow).not.toContain('APPROVE_V3_LEGACY_DROP');
  });
});
