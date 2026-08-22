import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { HostGrokRunnerClient } from '../../../src/content/acquisition/host-grok-runner-client';
import {
  hostGrokExecutionRequestV1Schema,
  hostGrokExecutionResponseV1Schema,
} from '../../../src/content/acquisition/host-grok-runner-contract';
import { sha256CanonicalJson } from '../../../src/content/acquisition/canonicalization';
import {
  compileXKeywordRequest,
  compileXSemanticRequest,
  compileXUserRequest,
} from '../../../src/content/acquisition/x-query-compiler';

const servers: Array<{ close: () => Promise<void>; directory: string }> = [];

async function fakeRunner(input: {
  releaseSha?: string;
  fail?: boolean;
  failBeforeStart?: boolean;
  metadataMismatch?: boolean;
  probeReady?: boolean;
  probeRefreshSucceeds?: boolean;
}) {
  const directory = mkdtempSync(join(tmpdir(), 'host-grok-runner-test-'));
  const socketPath = join(directory, 'runner.sock');
  const releaseSha = input.releaseSha ?? 'abc1234';
  let probeReady = input.probeReady !== false;
  const server = createServer((request, response) => {
    const send = (status: number, value: unknown) => {
      const body = JSON.stringify(value);
      response.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      response.end(body);
    };
    if (request.method === 'GET' && request.url === '/v1/health') {
      send(probeReady ? 200 : 503, {
        ok: true,
        ready: probeReady,
        runnerReleaseSha: releaseSha,
        grokVersion: '1.0.5',
        sandbox: 'strict',
        lastXProbeAt: probeReady ? new Date().toISOString() : null,
        lastXProbeOk: probeReady ? true : null,
      });
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method === 'POST' && request.url === '/v1/probes/x') {
        if (input.probeRefreshSucceeds === true) {
          probeReady = true;
          send(200, {
            ok: true,
            runnerReleaseSha: releaseSha,
            grokVersion: '1.0.5',
            toolName: 'x_user_search',
            userCount: 1,
          });
        } else {
          send(503, {
            ok: false,
            runnerReleaseSha: releaseSha,
            grokVersion: '1.0.5',
            toolName: 'x_user_search',
            failureClass: 'X_PROBE_FAILED',
            errorDigest: 'e'.repeat(64),
            providerProcessStarted: false,
          });
        }
        return;
      }
      const parsed = hostGrokExecutionRequestV1Schema.parse(
        JSON.parse(Buffer.concat(chunks).toString()),
      );
      const requestHash = sha256CanonicalJson(parsed);
      const requestedHandle =
        parsed.toolRequest.toolName === 'x_user_search' ? parsed.toolRequest.handle : 'OfficialFPL';
      const toolInput: Record<string, string | number> =
        parsed.toolRequest.toolName === 'x_keyword_search'
          ? {
              query: parsed.toolRequest.query,
              limit: parsed.toolRequest.limit,
              mode: parsed.toolRequest.mode,
            }
          : parsed.toolRequest.toolName === 'x_semantic_search'
            ? {
                query: parsed.toolRequest.query,
                from_date: parsed.toolRequest.fromDate,
                to_date: parsed.toolRequest.toDate,
                limit: parsed.toolRequest.limit,
              }
            : parsed.toolRequest.toolName === 'x_thread_fetch'
              ? { post_id: parsed.toolRequest.postId }
              : { query: requestedHandle, count: 3 };
      const expectedRequestMetadataHash = sha256CanonicalJson({
        toolName: parsed.toolRequest.toolName,
        input: toolInput,
      });
      if (input.fail || input.failBeforeStart) {
        send(502, {
          ok: false,
          runId: parsed.runId,
          requestHash,
          providerProcessStarted: !input.failBeforeStart,
          failureClass: 'GROK_TOOL_FAILED',
          errorDigest: 'e'.repeat(64),
        });
        return;
      }
      const result = {
        toolName: parsed.toolRequest.toolName,
        toolInput,
        posts:
          parsed.toolRequest.toolName === 'x_user_search'
            ? []
            : [
                {
                  postId: '2090909465801371803',
                  authorHandle: 'OfficialFPL',
                  createdAt: '2026-08-21T21:10:38Z',
                  text: 'Test post',
                  url: 'https://x.com/OfficialFPL/status/2090909465801371803',
                },
              ],
        users:
          parsed.toolRequest.toolName === 'x_user_search'
            ? [{ userId: '123', handle: requestedHandle, displayName: 'Official FPL' }]
            : [],
        requestMetadataHash: input.metadataMismatch ? 'f'.repeat(64) : expectedRequestMetadataHash,
        responseMetadataHash: 'b'.repeat(64),
        traceHash: 'c'.repeat(64),
        toolCallIdHash: 'd'.repeat(64),
        eventCount: 5,
        durationMs: 12,
        inputTokens: 10,
        outputTokens: 5,
        totalCostUsd: 0.01,
        rawPostEvidenceAvailable: false,
        executionLocation: 'HOST_RUNNER',
        runnerReleaseSha: releaseSha,
        grokVersion: '1.0.5',
        runnerBinaryHash: 'e'.repeat(64),
      };
      send(
        200,
        hostGrokExecutionResponseV1Schema.parse({
          ok: true,
          runId: parsed.runId,
          requestHash,
          runnerReleaseSha: releaseSha,
          grokVersion: '1.0.5',
          providerProcessStarted: true,
          result,
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  };
  servers.push({ close, directory });
  return { socketPath, close };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('host Grok runner client contract', () => {
  test('uses the Unix socket and propagates the provider-start budget hook', async () => {
    const runner = await fakeRunner({});
    const client = new HostGrokRunnerClient({
      socketPath: runner.socketPath,
      expectedVersion: '1.0.5',
      expectedRunnerReleaseSha: 'abc1234',
      timeoutMs: 2_000,
    });
    let providerStarted = false;
    const result = await client.execute(compileXUserRequest('OfficialFPL'), {
      runId: randomUUID(),
      onProviderProcessStart: () => {
        providerStarted = true;
      },
    });
    expect(providerStarted).toBe(true);
    expect(result.executionLocation).toBe('HOST_RUNNER');
    expect(result.users[0]?.handle).toBe('OfficialFPL');
  });

  test('supports all four fixed X tool request shapes through the same socket contract', async () => {
    const runner = await fakeRunner({});
    const client = new HostGrokRunnerClient({
      socketPath: runner.socketPath,
      expectedVersion: '1.0.5',
      expectedRunnerReleaseSha: 'abc1234',
      timeoutMs: 2_000,
    });
    const requests = [
      compileXKeywordRequest({
        handles: ['OfficialFPL'],
        windowStart: new Date('2026-08-21T21:00:00.000Z'),
        windowEnd: new Date('2026-08-21T21:15:00.000Z'),
        limit: 10,
      }),
      compileXSemanticRequest({
        semanticProfileKey: 'availability-v1',
        windowStart: new Date('2026-08-21T00:00:00.000Z'),
        windowEnd: new Date('2026-08-21T23:59:59.000Z'),
        limit: 10,
      }),
      compileXUserRequest('OfficialFPL'),
      { toolName: 'x_thread_fetch' as const, postId: '2090909465801371803' },
    ];
    for (const request of requests) {
      const result = await client.execute(request, { runId: randomUUID() });
      expect(result.toolName).toBe(request.toolName);
    }
  });

  test('fails closed on a release mismatch before executing X', async () => {
    const runner = await fakeRunner({ releaseSha: 'different' });
    const client = new HostGrokRunnerClient({
      socketPath: runner.socketPath,
      expectedVersion: '1.0.5',
      expectedRunnerReleaseSha: 'abc1234',
      timeoutMs: 2_000,
    });
    await expect(client.assertVersion()).rejects.toThrow('runner release');
  });

  test('fails closed until a recent real X probe is recorded', async () => {
    const runner = await fakeRunner({ probeReady: false });
    const client = new HostGrokRunnerClient({
      socketPath: runner.socketPath,
      expectedVersion: '1.0.5',
      expectedRunnerReleaseSha: 'abc1234',
      timeoutMs: 2_000,
    });
    await expect(client.assertVersion()).rejects.toThrow('not ready');
  });

  test('refreshes a stale probe before executing the next X request', async () => {
    const runner = await fakeRunner({ probeReady: false, probeRefreshSucceeds: true });
    const client = new HostGrokRunnerClient({
      socketPath: runner.socketPath,
      expectedVersion: '1.0.5',
      expectedRunnerReleaseSha: 'abc1234',
      timeoutMs: 2_000,
    });
    await expect(client.assertVersion()).resolves.toBeUndefined();
  });

  test('commits provider budget when the host runner reports a failed tool after spawn', async () => {
    const runner = await fakeRunner({ fail: true });
    const client = new HostGrokRunnerClient({
      socketPath: runner.socketPath,
      expectedVersion: '1.0.5',
      expectedRunnerReleaseSha: 'abc1234',
      timeoutMs: 2_000,
    });
    let providerStarted = false;
    await expect(
      client.execute(compileXUserRequest('OfficialFPL'), {
        runId: randomUUID(),
        onProviderProcessStart: () => {
          providerStarted = true;
        },
      }),
    ).rejects.toThrow('e'.repeat(64));
    expect(providerStarted).toBe(true);
  });

  test('releases provider budget when the host runner rejects before spawn', async () => {
    const runner = await fakeRunner({ failBeforeStart: true });
    const client = new HostGrokRunnerClient({
      socketPath: runner.socketPath,
      expectedVersion: '1.0.5',
      expectedRunnerReleaseSha: 'abc1234',
      timeoutMs: 2_000,
    });
    let providerStarted = false;
    await expect(
      client.execute(compileXUserRequest('OfficialFPL'), {
        runId: randomUUID(),
        onProviderProcessStart: () => {
          providerStarted = true;
        },
      }),
    ).rejects.toThrow('e'.repeat(64));
    expect(providerStarted).toBe(false);
  });

  test('rejects a runner response whose tool metadata drifts', async () => {
    const runner = await fakeRunner({ metadataMismatch: true });
    const client = new HostGrokRunnerClient({
      socketPath: runner.socketPath,
      expectedVersion: '1.0.5',
      expectedRunnerReleaseSha: 'abc1234',
      timeoutMs: 2_000,
    });
    await expect(client.execute(compileXUserRequest('OfficialFPL'))).rejects.toThrow(
      'tool metadata',
    );
  });

  test('request schema rejects arbitrary prompt and command fields', () => {
    expect(
      hostGrokExecutionRequestV1Schema.safeParse({
        schemaVersion: 1,
        runId: randomUUID(),
        callerReleaseSha: 'abc1234',
        toolRequest: { toolName: 'x_user_search', handle: 'OfficialFPL' },
        prompt: 'run arbitrary commands',
        command: 'cat auth',
      }).success,
    ).toBe(false);
  });
});
