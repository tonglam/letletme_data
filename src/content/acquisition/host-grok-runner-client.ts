import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';

import { z } from 'zod';

import {
  GrokBuildExecutionError,
  type GrokBuildExecutionHooks,
  type GrokBuildExecutionResult,
} from './grok-build-executor';
import {
  hostGrokExecutionRequestV1Schema,
  hostGrokExecutionResponseV1Schema,
  type HostGrokExecutionRequestV1,
} from './host-grok-runner-contract';
import { sha256CanonicalJson } from './canonicalization';
import { xToolRequestV1Schema, type XToolRequestV1 } from './x-query-compiler';

const hostGrokHealthSchema = z
  .object({
    ok: z.literal(true),
    ready: z.boolean(),
    runnerReleaseSha: z.string().min(1).max(128),
    grokVersion: z.string().min(1).max(64),
    sandbox: z.literal('strict'),
    lastXProbeAt: z.string().datetime({ offset: true }).nullable(),
    lastXProbeOk: z.boolean().nullable(),
  })
  .strict();

const hostGrokProbeResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      runnerReleaseSha: z.string().min(1).max(128),
      grokVersion: z.string().min(1).max(64),
      toolName: z.literal('x_user_search'),
      userCount: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      runnerReleaseSha: z.string().min(1).max(128),
      grokVersion: z.string().min(1).max(64),
      toolName: z.literal('x_user_search'),
      failureClass: z.string().min(1).max(128),
      errorDigest: z.string().regex(/^[0-9a-f]{64}$/),
      providerProcessStarted: z.boolean(),
    })
    .strict(),
]);

const PROBE_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 5_000;
const EXECUTION_DEADLINE_MS = 5 * 60_000;

type HostGrokRunnerClientOptions = Readonly<{
  socketPath: string;
  expectedVersion: string;
  expectedRunnerReleaseSha?: string | null;
  timeoutMs: number;
  maximumResponseBytes?: number;
}>;

type JsonResponse = Readonly<{ statusCode: number; body: unknown }>;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

function expectedToolInput(request: XToolRequestV1): Record<string, string | number> {
  if (request.toolName === 'x_keyword_search') {
    return { query: request.query, limit: request.limit, mode: request.mode };
  }
  if (request.toolName === 'x_semantic_search') {
    return {
      query: request.query,
      from_date: request.fromDate,
      to_date: request.toDate,
      limit: request.limit,
    };
  }
  if (request.toolName === 'x_user_search') {
    return { query: request.handle, count: 3 };
  }
  return { post_id: request.postId };
}

function readResponseBody(
  response: IncomingMessage,
  maximumResponseBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let oversized = false;
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes <= maximumResponseBytes) chunks.push(chunk);
      else oversized = true;
    });
    response.once('error', reject);
    response.once('end', () => {
      if (oversized) {
        reject(
          new GrokBuildExecutionError('RUNNER_OUTPUT_LIMIT', 'Runner response exceeded limit'),
        );
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

async function requestJson(input: {
  socketPath: string;
  path: string;
  method: 'GET' | 'POST';
  body?: unknown;
  timeoutMs: number;
  maximumResponseBytes: number;
  onTransportLossAfterDispatch?: () => void;
}): Promise<JsonResponse> {
  const body = input.body === undefined ? '' : JSON.stringify(input.body);
  return new Promise((resolve, reject) => {
    let dispatched = false;
    const markDispatched = () => {
      dispatched = true;
    };
    const request = httpRequest(
      {
        socketPath: input.socketPath,
        path: input.path,
        method: input.method,
        headers: {
          accept: 'application/json',
          ...(input.body === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
              }),
        },
      },
      async (response) => {
        try {
          const text = await readResponseBody(response, input.maximumResponseBytes);
          let parsed: unknown;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            throw new GrokBuildExecutionError(
              'RUNNER_RESPONSE_INVALID',
              'Runner response is not JSON',
            );
          }
          resolve({ statusCode: response.statusCode ?? 0, body: parsed });
        } catch (error) {
          if (dispatched) input.onTransportLossAfterDispatch?.();
          reject(error);
        }
      },
    );
    request.setTimeout(input.timeoutMs, () => {
      request.destroy(new GrokBuildExecutionError('RUNNER_TIMEOUT', 'Runner request timed out'));
    });
    request.once('finish', markDispatched);
    request.once('error', (error) => {
      if (dispatched) input.onTransportLossAfterDispatch?.();
      reject(error);
    });
    if (input.body === undefined) request.end();
    else request.end(body);
  });
}

export class HostGrokRunnerClient {
  private readonly socketPath: string;
  private readonly expectedVersion: string;
  private readonly expectedRunnerReleaseSha: string | null;
  private readonly timeoutMs: number;
  private readonly maximumResponseBytes: number;
  private healthCheck: Promise<void> | null = null;
  private probeCheck: Promise<void> | null = null;

  constructor(input: HostGrokRunnerClientOptions) {
    this.socketPath = input.socketPath;
    this.expectedVersion = input.expectedVersion;
    this.expectedRunnerReleaseSha = input.expectedRunnerReleaseSha?.trim() || null;
    this.timeoutMs = input.timeoutMs;
    this.maximumResponseBytes = Math.min(
      4 * 1024 * 1024,
      Math.max(1, input.maximumResponseBytes ?? 4 * 1024 * 1024),
    );
  }

  async assertVersion(
    hooks?: Pick<GrokBuildExecutionHooks, 'onProbeRequest' | 'onProbeProcessStart'>,
    deadlineAt = Date.now() + EXECUTION_DEADLINE_MS,
  ): Promise<void> {
    // Health is deliberately checked on every execution. The runner's probe
    // state is process-local and resets on a systemd restart; a TTL cache here
    // could otherwise start a provider call before the new process has passed
    // its real X probe. Coalesce concurrent checks, but never reuse a completed
    // check across executions.
    if (this.healthCheck) return this.healthCheck;
    const check = this.inspectHealth(hooks, deadlineAt);
    this.healthCheck = check;
    try {
      await check;
    } finally {
      if (this.healthCheck === check) this.healthCheck = null;
    }
  }

  private async inspectHealth(
    hooks?: Pick<GrokBuildExecutionHooks, 'onProbeRequest' | 'onProbeProcessStart'>,
    deadlineAt = Date.now() + EXECUTION_DEADLINE_MS,
  ): Promise<void> {
    const remainingTimeout = (maximumMs: number): number => {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        throw new GrokBuildExecutionError('RUNNER_TIMEOUT', 'Host Grok run deadline exceeded');
      }
      return Math.min(maximumMs, remainingMs);
    };
    const readHealth = async (): Promise<{
      response: JsonResponse;
      health: z.infer<typeof hostGrokHealthSchema>;
    }> => {
      try {
        const response = await requestJson({
          socketPath: this.socketPath,
          path: '/v1/health',
          method: 'GET',
          timeoutMs: remainingTimeout(Math.min(this.timeoutMs, HEALTH_TIMEOUT_MS)),
          maximumResponseBytes: 32 * 1024,
        });
        const health = hostGrokHealthSchema.safeParse(response.body);
        if (!health.success) {
          throw new GrokBuildExecutionError(
            'RUNNER_NOT_READY',
            'Host Grok runner health response is invalid',
          );
        }
        return { response, health: health.data };
      } catch (error) {
        if (error instanceof GrokBuildExecutionError) throw error;
        throw new GrokBuildExecutionError('RUNNER_UNAVAILABLE', errorMessage(error));
      }
    };

    const assertIdentity = (health: z.infer<typeof hostGrokHealthSchema>): void => {
      if (health.grokVersion !== this.expectedVersion) {
        throw new GrokBuildExecutionError(
          'GROK_VERSION_MISMATCH',
          `Expected Grok Build ${this.expectedVersion}, observed ${health.grokVersion}`,
        );
      }
      if (
        this.expectedRunnerReleaseSha &&
        this.expectedRunnerReleaseSha !== 'unknown' &&
        health.runnerReleaseSha !== this.expectedRunnerReleaseSha
      ) {
        throw new GrokBuildExecutionError(
          'RUNNER_RELEASE_MISMATCH',
          `Expected runner release ${this.expectedRunnerReleaseSha}, observed ${health.runnerReleaseSha}`,
        );
      }
    };

    let healthResponse = await readHealth();
    assertIdentity(healthResponse.health);
    if (
      healthResponse.response.statusCode !== 200 ||
      !healthResponse.health.ready ||
      healthResponse.health.lastXProbeOk !== true
    ) {
      await this.refreshProbe(hooks, deadlineAt);
      healthResponse = await readHealth();
      assertIdentity(healthResponse.health);
    }
    if (
      healthResponse.response.statusCode !== 200 ||
      !healthResponse.health.ready ||
      healthResponse.health.lastXProbeOk !== true
    ) {
      throw new GrokBuildExecutionError('RUNNER_NOT_READY', 'Host Grok runner health is not ready');
    }
  }

  private async refreshProbe(
    hooks?: Pick<GrokBuildExecutionHooks, 'onProbeRequest' | 'onProbeProcessStart'>,
    deadlineAt = Date.now() + EXECUTION_DEADLINE_MS,
  ): Promise<void> {
    if (this.probeCheck) return this.probeCheck;
    const probe = (async () => {
      let response: JsonResponse;
      const remainingTimeout = (): number => {
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) {
          throw new GrokBuildExecutionError('RUNNER_TIMEOUT', 'Host Grok run deadline exceeded');
        }
        return Math.min(this.timeoutMs, PROBE_TIMEOUT_MS, remainingMs);
      };
      try {
        await hooks?.onProbeRequest?.();
        response = await requestJson({
          socketPath: this.socketPath,
          path: '/v1/probes/x',
          method: 'POST',
          body: { schemaVersion: 1 },
          timeoutMs: remainingTimeout(),
          maximumResponseBytes: 32 * 1024,
          onTransportLossAfterDispatch: hooks?.onProbeProcessStart,
        });
      } catch (error) {
        if (error instanceof GrokBuildExecutionError) throw error;
        throw new GrokBuildExecutionError('RUNNER_UNAVAILABLE', errorMessage(error));
      }
      const parsed = hostGrokProbeResponseSchema.safeParse(response.body);
      if (!parsed.success || response.statusCode !== 200 || !parsed.data.ok) {
        if (
          parsed.success &&
          !parsed.data.ok &&
          ['RUNNER_CAPACITY', 'RUNNER_PROBE_RATE_LIMITED'].includes(parsed.data.failureClass)
        ) {
          throw new GrokBuildExecutionError('RUNNER_CAPACITY', 'Host Grok runner is at capacity');
        }
        if (!parsed.success || (response.statusCode !== 200 && parsed.data.ok)) {
          // The request reached the host runner, but a malformed/non-200
          // response cannot prove whether the provider process started. Charge
          // the probe conservatively so a lost response cannot bypass the X
          // call cap.
          hooks?.onProbeProcessStart?.();
        }
        if (parsed.success && !parsed.data.ok && parsed.data.providerProcessStarted) {
          hooks?.onProbeProcessStart?.();
        }
        throw new GrokBuildExecutionError(
          'RUNNER_NOT_READY',
          'Host Grok runner is not ready after the X probe failed',
        );
      }
      hooks?.onProbeProcessStart?.();
      if (parsed.data.grokVersion !== this.expectedVersion) {
        throw new GrokBuildExecutionError(
          'GROK_VERSION_MISMATCH',
          `Expected Grok Build ${this.expectedVersion}, observed ${parsed.data.grokVersion}`,
        );
      }
      if (
        this.expectedRunnerReleaseSha &&
        this.expectedRunnerReleaseSha !== 'unknown' &&
        parsed.data.runnerReleaseSha !== this.expectedRunnerReleaseSha
      ) {
        throw new GrokBuildExecutionError(
          'RUNNER_RELEASE_MISMATCH',
          `Expected runner release ${this.expectedRunnerReleaseSha}, observed ${parsed.data.runnerReleaseSha}`,
        );
      }
    })();
    this.probeCheck = probe;
    try {
      await probe;
    } finally {
      if (this.probeCheck === probe) this.probeCheck = null;
    }
  }

  async execute(
    requestValue: XToolRequestV1,
    hooks?: GrokBuildExecutionHooks,
  ): Promise<GrokBuildExecutionResult> {
    const toolRequest = xToolRequestV1Schema.parse(requestValue);
    const deadlineAt = Date.now() + EXECUTION_DEADLINE_MS;
    await this.assertVersion(hooks, deadlineAt);
    const request: HostGrokExecutionRequestV1 = hostGrokExecutionRequestV1Schema.parse({
      schemaVersion: 1,
      runId: hooks?.runId ?? randomUUID(),
      callerReleaseSha: this.expectedRunnerReleaseSha ?? 'unknown',
      toolRequest,
    });
    let providerProcessStarted = false;
    const markProviderStarted = () => {
      if (providerProcessStarted) return;
      providerProcessStarted = true;
      hooks?.onProviderProcessStart?.();
    };
    let response: JsonResponse;
    try {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        throw new GrokBuildExecutionError('RUNNER_TIMEOUT', 'Host Grok run deadline exceeded');
      }
      response = await requestJson({
        socketPath: this.socketPath,
        path: '/v1/executions',
        method: 'POST',
        body: request,
        timeoutMs: Math.min(this.timeoutMs, remainingMs),
        maximumResponseBytes: this.maximumResponseBytes,
        onTransportLossAfterDispatch: markProviderStarted,
      });
    } catch (error) {
      if (providerProcessStarted) {
        throw new GrokBuildExecutionError('RUNNER_TRANSPORT_AFTER_DISPATCH', errorMessage(error));
      }
      throw new GrokBuildExecutionError('RUNNER_UNAVAILABLE', errorMessage(error));
    }

    const parsed = hostGrokExecutionResponseV1Schema.safeParse(response.body);
    if (!parsed.success) {
      // A 5xx/2xx response after the request was dispatched means the Runner
      // may already have accepted and started the provider job.  Charge the
      // reservation conservatively; explicit 4xx validation/capacity errors
      // remain pre-provider failures and can release it.
      if (response.statusCode >= 500 || response.statusCode === 200) {
        markProviderStarted();
      }
      throw new GrokBuildExecutionError(
        'RUNNER_RESPONSE_INVALID',
        `Host runner response failed schema validation: ${digest(JSON.stringify(response.body))}`,
      );
    }
    if (parsed.data.runId !== request.runId) {
      markProviderStarted();
      throw new GrokBuildExecutionError(
        'RUNNER_RESPONSE_INVALID',
        'Runner returned the wrong run ID',
      );
    }
    if (parsed.data.requestHash !== sha256CanonicalJson(request)) {
      markProviderStarted();
      throw new GrokBuildExecutionError(
        'RUNNER_RESPONSE_INVALID',
        'Runner returned the wrong request hash',
      );
    }
    if (!parsed.data.ok) {
      if (parsed.data.providerProcessStarted) markProviderStarted();
      throw new GrokBuildExecutionError(parsed.data.failureClass, parsed.data.errorDigest);
    }
    markProviderStarted();
    if (
      response.statusCode !== 200 ||
      (this.expectedRunnerReleaseSha &&
        this.expectedRunnerReleaseSha !== 'unknown' &&
        parsed.data.runnerReleaseSha !== this.expectedRunnerReleaseSha) ||
      parsed.data.grokVersion !== this.expectedVersion ||
      parsed.data.result.executionLocation !== 'HOST_RUNNER' ||
      parsed.data.result.runnerReleaseSha !== parsed.data.runnerReleaseSha ||
      parsed.data.result.grokVersion !== parsed.data.grokVersion
    ) {
      throw new GrokBuildExecutionError(
        'RUNNER_IDENTITY_MISMATCH',
        'Runner identity did not match the request',
      );
    }
    const expectedMetadataHash = sha256CanonicalJson({
      toolName: request.toolRequest.toolName,
      input: expectedToolInput(request.toolRequest),
    });
    if (
      parsed.data.result.toolName !== request.toolRequest.toolName ||
      parsed.data.result.requestMetadataHash !== expectedMetadataHash
    ) {
      throw new GrokBuildExecutionError(
        'RUNNER_TOOL_METADATA_MISMATCH',
        'Runner result tool metadata did not match the persisted request',
      );
    }
    return parsed.data.result;
  }
}
