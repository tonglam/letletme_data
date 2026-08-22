import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { access, chmod, mkdir, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  grokBuildCliArgs,
  grokBuildChildEnvironment,
  GrokBuildExecutionError,
  parseGrokBuildStreamingMessages,
  runBoundedProcess,
  type GrokBuildExecutionResult,
} from './acquisition/grok-build-executor';
import {
  hostGrokExecutionRequestV1Schema,
  type HostGrokExecutionRequestV1,
  type HostGrokExecutionResponseV1,
} from './acquisition/host-grok-runner-contract';
import { sha256CanonicalJson } from './acquisition/canonicalization';
import { compileXUserRequest } from './acquisition/x-query-compiler';

const CONFIG = {
  socketPath: process.env.GROK_RUNNER_SOCKET?.trim() || '/run/letletme-grok-runner/runner.sock',
  runtimeDirectory: process.env.GROK_RUNNER_RUNTIME_DIR?.trim() || '/run/letletme-grok-runner',
  binary: process.env.GROK_RUNNER_BINARY?.trim() || '/home/deploy/.grok/bin/grok',
  home: process.env.GROK_RUNNER_HOME?.trim() || '/home/deploy',
  grokHome: process.env.GROK_HOME?.trim() || '/home/deploy/.grok',
  expectedVersion: process.env.CONTENT_GROK_EXPECTED_VERSION?.trim() || '1.0.5',
  releaseSha: process.env.GROK_RUNNER_RELEASE_SHA?.trim() || '',
  releaseFile:
    process.env.GROK_RUNNER_RELEASE_FILE?.trim() ||
    '/home/workspace/letletme-grok-runner/current.release',
  timeoutMs: Math.max(1, Number(process.env.CONTENT_GROK_TIMEOUT_MS ?? 240_000)),
  maximumOutputBytes: Math.min(
    4_194_304,
    Math.max(1, Number(process.env.CONTENT_GROK_MAX_OUTPUT_BYTES ?? 4_194_304)),
  ),
  maximumRequestBytes: 16 * 1024,
  maximumResponseBytes: 4 * 1024 * 1024,
  concurrency: 2,
};

const X_PROBE_MAX_AGE_MS = 30 * 60_000;

type RunnerFailure = Readonly<{
  failureClass: string;
  providerProcessStarted: boolean;
  errorDigest: string;
}>;

type StoredExecution = Readonly<{
  requestHash: string;
  response: HostGrokExecutionResponseV1;
  expiresAt: number;
}>;

type InFlightExecution = Readonly<{
  requestHash: string;
  promise: Promise<HostGrokExecutionResponseV1>;
}>;

const jsonContentType = { 'content-type': 'application/json; charset=utf-8' };

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function digestBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function boundedErrorDigest(error: unknown): string {
  return digest(
    error instanceof Error ? error.message.slice(0, 4_096) : String(error).slice(0, 4_096),
  );
}

function failureFrom(error: unknown, providerProcessStarted: boolean): RunnerFailure {
  const candidate = error as { failureClass?: unknown };
  return {
    failureClass:
      typeof candidate.failureClass === 'string'
        ? candidate.failureClass
        : 'RUNNER_EXECUTION_FAILED',
    providerProcessStarted,
    errorDigest: boundedErrorDigest(error),
  };
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, { ...jsonContentType, 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  return new Promise((resolve, reject) => {
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > CONFIG.maximumRequestBytes) {
        reject(new GrokBuildExecutionError('RUNNER_REQUEST_LIMIT', 'Request body exceeded limit'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once('error', reject);
    request.once('end', () => {
      if (bytes === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new GrokBuildExecutionError('RUNNER_REQUEST_INVALID', 'Request body is not JSON'));
      }
    });
  });
}

async function inspectGrokVersion(): Promise<string> {
  const runDirectory = await mkdtemp(join(tmpdir(), 'letletme-grok-inspect-'));
  try {
    const result = await runBoundedProcess({
      binary: CONFIG.binary,
      args: ['inspect', '--json'],
      cwd: runDirectory,
      timeoutMs: 30_000,
      maximumOutputBytes: 1024 * 1024,
      environment: grokBuildChildEnvironment({
        ...process.env,
        HOME: CONFIG.home,
        GROK_HOME: CONFIG.grokHome,
        GROK_NO_AUTO_UPDATE: '1',
      }),
    });
    const parsed = JSON.parse(result.stdout) as { grokVersion?: unknown };
    if (typeof parsed.grokVersion !== 'string') throw new Error('grok inspect omitted grokVersion');
    return parsed.grokVersion;
  } finally {
    await rm(runDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function assertHostRuntime(): Promise<{ grokVersion: string; binaryHash: string }> {
  await access(CONFIG.binary, fsConstants.X_OK);
  await access('/usr/bin/bwrap', fsConstants.X_OK).catch(async () => {
    await access('/bin/bwrap', fsConstants.X_OK);
  });
  const [grokVersion, binary] = await Promise.all([inspectGrokVersion(), readFile(CONFIG.binary)]);
  if (grokVersion !== CONFIG.expectedVersion) {
    throw new GrokBuildExecutionError(
      'GROK_VERSION_MISMATCH',
      `Expected Grok Build ${CONFIG.expectedVersion}, observed ${grokVersion}`,
    );
  }
  return { grokVersion, binaryHash: digestBytes(binary) };
}

async function resolveReleaseSha(): Promise<string> {
  const validate = (value: string): string => {
    if (value === 'unknown' || /^[0-9a-f]{7,128}$/i.test(value)) return value;
    throw new GrokBuildExecutionError('RUNNER_RELEASE_INVALID', 'Runner release SHA is invalid');
  };
  if (CONFIG.releaseSha) return validate(CONFIG.releaseSha);
  let value: string;
  try {
    value = (await readFile(CONFIG.releaseFile, 'utf8')).trim();
  } catch {
    return 'unknown';
  }
  return value ? validate(value) : 'unknown';
}

async function executeOnHost(
  request: HostGrokExecutionRequestV1,
  metadata: Readonly<{ grokVersion: string; binaryHash: string; releaseSha: string }>,
  signal?: AbortSignal,
): Promise<HostGrokExecutionResponseV1> {
  const requestHash = sha256CanonicalJson(request);
  let providerProcessStarted = false;
  let runDirectory: string | null = null;
  try {
    runDirectory = await mkdtemp(join(tmpdir(), `letletme-grok-${request.runId}-`));
    const result = await runBoundedProcess({
      binary: CONFIG.binary,
      args: grokBuildCliArgs({
        request: request.toolRequest,
        runDirectory,
        sandbox: 'strict',
      }),
      cwd: runDirectory,
      timeoutMs: CONFIG.timeoutMs,
      maximumOutputBytes: CONFIG.maximumOutputBytes,
      signal,
      environment: grokBuildChildEnvironment({
        ...process.env,
        HOME: CONFIG.home,
        GROK_HOME: CONFIG.grokHome,
        GROK_NO_AUTO_UPDATE: '1',
      }),
      onSpawn: () => {
        providerProcessStarted = true;
      },
    });
    const parsed: GrokBuildExecutionResult = parseGrokBuildStreamingMessages({
      output: result.stdout,
      request: request.toolRequest,
      durationMs: result.durationMs,
    });
    return {
      ok: true,
      runId: request.runId,
      requestHash,
      runnerReleaseSha: metadata.releaseSha,
      grokVersion: metadata.grokVersion,
      providerProcessStarted: true,
      result: {
        ...parsed,
        executionLocation: 'HOST_RUNNER',
        runnerReleaseSha: metadata.releaseSha,
        grokVersion: metadata.grokVersion,
        runnerBinaryHash: metadata.binaryHash,
      },
    };
  } catch (error) {
    const failure = failureFrom(error, providerProcessStarted);
    return {
      ok: false,
      runId: request.runId,
      requestHash,
      providerProcessStarted: failure.providerProcessStarted,
      failureClass: failure.failureClass,
      errorDigest: failure.errorDigest,
    };
  } finally {
    if (runDirectory) {
      await rm(runDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function startHostGrokRunner(): Promise<{
  close: () => Promise<void>;
  socketPath: string;
}> {
  const metadata = await assertHostRuntime();
  const releaseSha = await resolveReleaseSha();
  const runnerMetadata = { ...metadata, releaseSha };
  await mkdir(CONFIG.runtimeDirectory, { recursive: true, mode: 0o750 });
  await unlink(CONFIG.socketPath).catch(() => undefined);
  let active = 0;
  let lastXProbeAt: string | null = null;
  let lastXProbeOk: boolean | null = null;
  const executions = new Map<string, StoredExecution>();
  const inFlightExecutions = new Map<string, InFlightExecution>();
  const activeControllers = new Set<AbortController>();

  const failedExecutionResponse = (
    request: HostGrokExecutionRequestV1,
    failureClass: string,
    providerProcessStarted = false,
  ): HostGrokExecutionResponseV1 => ({
    ok: false,
    runId: request.runId,
    requestHash: sha256CanonicalJson(request),
    providerProcessStarted,
    failureClass,
    errorDigest: digest(failureClass),
  });

  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/v1/health') {
        const probeFresh =
          lastXProbeOk === true &&
          lastXProbeAt !== null &&
          Date.parse(lastXProbeAt) >= Date.now() - X_PROBE_MAX_AGE_MS;
        writeJson(response, probeFresh ? 200 : 503, {
          ok: true,
          ready: probeFresh,
          runnerReleaseSha: releaseSha,
          grokVersion: metadata.grokVersion,
          sandbox: 'strict',
          lastXProbeAt,
          lastXProbeOk,
        });
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/probes/x') {
        if (active >= CONFIG.concurrency) {
          writeJson(response, 429, {
            ok: false,
            runnerReleaseSha: releaseSha,
            grokVersion: metadata.grokVersion,
            toolName: 'x_user_search',
            failureClass: 'RUNNER_CAPACITY',
            errorDigest: digest('runner capacity'),
            providerProcessStarted: false,
          });
          return;
        }
        const toolRequest = compileXUserRequest('OfficialFPL');
        const probeRequest = hostGrokExecutionRequestV1Schema.parse({
          schemaVersion: 1,
          runId: randomUUID(),
          callerReleaseSha: releaseSha,
          toolRequest,
        });
        const abortController = new AbortController();
        active += 1;
        activeControllers.add(abortController);
        const abortProbe = () => abortController.abort();
        request.once('aborted', abortProbe);
        response.once('close', abortProbe);
        let probe: HostGrokExecutionResponseV1;
        try {
          probe = await executeOnHost(probeRequest, runnerMetadata, abortController.signal);
        } finally {
          request.off('aborted', abortProbe);
          response.off('close', abortProbe);
          activeControllers.delete(abortController);
          active -= 1;
        }
        const exactProbeUser = probe.ok
          ? probe.result.users.length === 1 &&
            probe.result.users[0]?.handle.toLowerCase() === 'officialfpl'
          : false;
        const probeOk = probe.ok && exactProbeUser;
        const probeUserCount = probe.ok ? probe.result.users.length : null;
        lastXProbeAt = new Date().toISOString();
        lastXProbeOk = probeOk;
        writeJson(response, probeOk ? 200 : 503, {
          ok: probeOk,
          runnerReleaseSha: releaseSha,
          grokVersion: metadata.grokVersion,
          toolName: toolRequest.toolName,
          ...(probeOk
            ? { userCount: probeUserCount }
            : {
                failureClass: probe.ok ? 'X_PROBE_NOT_EXACT' : probe.failureClass,
                errorDigest: probe.ok ? digest('X_PROBE_NOT_EXACT') : probe.errorDigest,
                providerProcessStarted: probe.providerProcessStarted,
              }),
        });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/executions') {
        writeJson(response, 404, { ok: false, error: 'NOT_FOUND' });
        return;
      }
      let requestBody: unknown;
      try {
        requestBody = await readJsonBody(request);
      } catch (error) {
        const failure = failureFrom(error, false);
        writeJson(response, failure.failureClass === 'RUNNER_REQUEST_LIMIT' ? 413 : 400, {
          ok: false,
          error: failure.failureClass,
          errorDigest: failure.errorDigest,
        });
        return;
      }
      const parsedRequest = hostGrokExecutionRequestV1Schema.safeParse(requestBody);
      if (!parsedRequest.success) {
        writeJson(response, 400, { ok: false, error: 'RUNNER_REQUEST_INVALID' });
        return;
      }
      const executionRequest = parsedRequest.data;
      if (
        executionRequest.callerReleaseSha !== 'unknown' &&
        executionRequest.callerReleaseSha !== releaseSha
      ) {
        writeJson(
          response,
          409,
          failedExecutionResponse(executionRequest, 'RUNNER_RELEASE_MISMATCH'),
        );
        return;
      }
      const requestHash = sha256CanonicalJson(executionRequest);
      const existing = executions.get(executionRequest.runId);
      if (existing && existing.expiresAt > Date.now()) {
        if (existing.requestHash !== requestHash) {
          writeJson(
            response,
            409,
            failedExecutionResponse(executionRequest, 'RUNNER_DUPLICATE_RUN_ID'),
          );
          return;
        }
        writeJson(response, 200, existing.response);
        return;
      }
      const inFlight = inFlightExecutions.get(executionRequest.runId);
      if (inFlight) {
        if (inFlight.requestHash !== requestHash) {
          writeJson(
            response,
            409,
            failedExecutionResponse(executionRequest, 'RUNNER_DUPLICATE_RUN_ID'),
          );
          return;
        }
        const result = await inFlight.promise;
        writeJson(response, result.ok ? 200 : 502, result);
        return;
      }
      if (active >= CONFIG.concurrency) {
        const saturated: HostGrokExecutionResponseV1 = {
          ok: false,
          runId: executionRequest.runId,
          requestHash,
          providerProcessStarted: false,
          failureClass: 'RUNNER_CAPACITY',
          errorDigest: digest('runner capacity'),
        };
        writeJson(response, 429, saturated);
        return;
      }
      active += 1;
      const abortController = new AbortController();
      activeControllers.add(abortController);
      const abortExecution = () => abortController.abort();
      request.once('aborted', abortExecution);
      response.once('close', abortExecution);
      const executionPromise = executeOnHost(
        executionRequest,
        runnerMetadata,
        abortController.signal,
      );
      inFlightExecutions.set(executionRequest.runId, { requestHash, promise: executionPromise });
      try {
        const result = await executionPromise;
        if (result.ok) {
          // A successful, trace-verified X execution is itself a fresh provider
          // liveness signal. The dedicated OfficialFPL probe still runs when
          // the runner has been idle long enough for this signal to expire.
          lastXProbeAt = new Date().toISOString();
          lastXProbeOk = true;
        }
        executions.set(executionRequest.runId, {
          requestHash,
          response: result,
          expiresAt: Date.now() + 10 * 60_000,
        });
        for (const [runId, stored] of executions) {
          if (stored.expiresAt <= Date.now()) executions.delete(runId);
        }
        writeJson(response, result.ok ? 200 : 502, result);
      } finally {
        request.off('aborted', abortExecution);
        response.off('close', abortExecution);
        inFlightExecutions.delete(executionRequest.runId);
        activeControllers.delete(abortController);
        active -= 1;
      }
    } catch (error) {
      writeJson(response, 500, {
        ok: false,
        error: 'RUNNER_INTERNAL_ERROR',
        errorDigest: boundedErrorDigest(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(CONFIG.socketPath, () => resolve());
  });
  await chmod(CONFIG.socketPath, 0o660);

  return {
    socketPath: CONFIG.socketPath,
    close: async () => {
      for (const controller of activeControllers) controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(CONFIG.socketPath).catch(() => undefined);
    },
  };
}

if (import.meta.main) {
  if (process.argv.includes('--self-test')) {
    const metadata = await assertHostRuntime();
    const releaseSha = await resolveReleaseSha();
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        grokVersion: metadata.grokVersion,
        runnerReleaseSha: releaseSha,
        sandbox: 'strict',
      })}\n`,
    );
  } else {
    const runner = await startHostGrokRunner();
    const shutdown = () => {
      void runner.close().finally(() => process.exit(0));
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }
}
