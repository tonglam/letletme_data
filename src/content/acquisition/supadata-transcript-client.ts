import { createHash } from 'node:crypto';

import { z } from 'zod';

import { normalizeCanonicalText, sha256CanonicalJson } from './canonicalization';
import type { CanonicalTranscriptSegmentV1, JsonValue } from './canonicalization';

const PROVIDER_REVISION = 'supadata-universal-transcript-v1';

const segmentSchema = z
  .object({
    text: z.string().min(1).max(20_000),
    offset: z.number().int().nonnegative(),
    duration: z.number().int().positive(),
    lang: z.string().min(1).max(64).optional(),
  })
  .passthrough();
const transcriptSchema = z
  .object({
    content: z.array(segmentSchema).max(20_000),
    lang: z.string().min(1).max(64),
    availableLangs: z.array(z.string().min(1).max(64)).max(256),
  })
  .passthrough();
const jobSchema = z.object({ jobId: z.string().min(1).max(512) }).passthrough();
const providerErrorSchema = z
  .object({
    error: z.string().min(1).max(200),
    message: z.string().max(2_000).optional(),
    details: z.string().max(10_000).optional(),
  })
  .passthrough();
const jobStatusSchema = z
  .object({
    status: z.enum(['queued', 'active', 'completed', 'failed']),
    content: z.array(segmentSchema).max(20_000).optional(),
    lang: z.string().min(1).max(64).optional(),
    availableLangs: z.array(z.string().min(1).max(64)).max(256).optional(),
    error: providerErrorSchema.optional(),
  })
  .passthrough();

export class SupadataTranscriptClientError extends Error {
  readonly failureClass: string;
  readonly httpStatus: number | null;

  constructor(message: string, failureClass: string, httpStatus: number | null = null) {
    super(message);
    this.name = 'SupadataTranscriptClientError';
    this.failureClass = failureClass;
    this.httpStatus = httpStatus;
  }
}

type ProviderEvidence = Readonly<{
  requestMetadataHash: string;
  responseMetadataHash: string;
  providerUnits: number;
  durationMs: number;
}>;

export type SupadataSubmitResult =
  | (ProviderEvidence &
      Readonly<{
        kind: 'COMPLETED';
        language: string;
        availableLanguages: readonly string[];
        segments: readonly CanonicalTranscriptSegmentV1[];
      }>)
  | (ProviderEvidence &
      Readonly<{
        kind: 'EMPTY';
        language: string;
        availableLanguages: readonly string[];
      }>)
  | (ProviderEvidence &
      Readonly<{
        kind: 'PENDING';
        jobId: string;
        providerJobIdHash: string;
      }>)
  | (ProviderEvidence &
      Readonly<{
        kind: 'UNAVAILABLE';
        errorCode: string;
        errorSummary: string;
      }>);

export type SupadataPollResult =
  | (ProviderEvidence &
      Readonly<{
        kind: 'PENDING';
        providerStatus: 'queued' | 'active';
        providerJobIdHash: string;
      }>)
  | (ProviderEvidence &
      Readonly<{
        kind: 'COMPLETED';
        language: string;
        availableLanguages: readonly string[];
        segments: readonly CanonicalTranscriptSegmentV1[];
        providerJobIdHash: string;
      }>)
  | (ProviderEvidence &
      Readonly<{
        kind: 'EMPTY';
        language: string;
        availableLanguages: readonly string[];
        providerJobIdHash: string;
      }>)
  | (ProviderEvidence &
      Readonly<{
        kind: 'FAILED';
        errorCode: string;
        errorSummary: string;
        providerJobIdHash: string;
      }>);

export type SupadataTranscriptClientLike = Readonly<{
  submit(input: {
    videoUrl: string;
    mode: 'native' | 'auto';
    language: string | null;
  }): Promise<SupadataSubmitResult>;
  poll(jobId: string): Promise<SupadataPollResult>;
}>;

export type SupadataTranscriptFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function billableUnits(response: Response, required: boolean): number {
  const raw = response.headers.get('x-billable-requests');
  if (raw === null) {
    if (!required) return 0;
    throw new SupadataTranscriptClientError(
      'Supadata success response omitted the billable-unit header',
      'BILLING_HEADER_MISSING',
      response.status,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SupadataTranscriptClientError(
      'Supadata returned an invalid billable-unit header',
      'BILLING_HEADER_INVALID',
      response.status,
    );
  }
  return value;
}

function jobIdHash(jobId: string): string {
  return createHash('sha256').update(jobId, 'utf8').digest('hex');
}

async function boundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > maximumBytes) {
    throw new SupadataTranscriptClientError(
      'Supadata response exceeded the byte limit',
      'OUTPUT_LIMIT',
      response.status,
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new SupadataTranscriptClientError(
      'Supadata response was not valid UTF-8',
      'UTF8_INVALID',
      response.status,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SupadataTranscriptClientError(
      'Supadata response was not JSON',
      'SCHEMA_FAILED',
      response.status,
    );
  }
}

function canonicalSegments(
  content: readonly z.infer<typeof segmentSchema>[],
): readonly CanonicalTranscriptSegmentV1[] {
  let priorStart = -1;
  let priorEnd = -1;
  return content.map((segment) => {
    const text = normalizeCanonicalText(segment.text);
    const endMs = segment.offset + segment.duration;
    if (!text || !Number.isSafeInteger(endMs) || segment.offset < priorStart || endMs < priorEnd) {
      throw new SupadataTranscriptClientError(
        'Supadata transcript segments failed monotonicity or text gates',
        'SEGMENT_INVALID',
      );
    }
    priorStart = segment.offset;
    priorEnd = endMs;
    return { startMs: segment.offset, endMs, text };
  });
}

function errorFacts(value: unknown): { code: string; summary: string } {
  const parsed = providerErrorSchema.safeParse(value);
  if (!parsed.success) return { code: 'provider-error', summary: 'Supadata rejected the request' };
  return {
    code: parsed.data.error,
    summary: normalizeCanonicalText(
      parsed.data.details ?? parsed.data.message ?? 'Supadata rejected the request',
    ).slice(0, 1_000),
  };
}

export class SupadataTranscriptClient implements SupadataTranscriptClientLike {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maximumResponseBytes: number;
  private readonly fetchImpl: SupadataTranscriptFetch;

  constructor(input: {
    apiKey: string;
    timeoutMs: number;
    maximumResponseBytes: number;
    fetchImpl?: SupadataTranscriptFetch;
  }) {
    if (!input.apiKey.trim()) throw new Error('Supadata API key is required');
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) {
      throw new Error('Supadata timeout must be a positive integer');
    }
    if (!Number.isSafeInteger(input.maximumResponseBytes) || input.maximumResponseBytes < 1) {
      throw new Error('Supadata response limit must be a positive integer');
    }
    this.apiKey = input.apiKey;
    this.timeoutMs = input.timeoutMs;
    this.maximumResponseBytes = input.maximumResponseBytes;
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  private async request(url: URL): Promise<{
    response: Response;
    decoded: unknown;
    durationMs: number;
    providerUnits: number;
  }> {
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json', 'x-api-key': this.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new SupadataTranscriptClientError(
        error instanceof Error ? error.message : 'Supadata transport failed',
        'TRANSPORT_FAILED',
      );
    }
    return {
      response,
      decoded: await boundedJson(response, this.maximumResponseBytes),
      durationMs: Date.now() - startedAt,
      providerUnits: billableUnits(response, response.ok || response.status === 206),
    };
  }

  async submit(input: {
    videoUrl: string;
    mode: 'native' | 'auto';
    language: string | null;
  }): Promise<SupadataSubmitResult> {
    const url = new URL('https://api.supadata.ai/v1/transcript');
    url.searchParams.set('url', input.videoUrl);
    url.searchParams.set('text', 'false');
    url.searchParams.set('mode', input.mode);
    if (input.language) url.searchParams.set('lang', input.language);
    const requestMetadataHash = sha256CanonicalJson({
      provider: 'supadata',
      revision: PROVIDER_REVISION,
      operation: 'transcript.submit',
      videoUrl: input.videoUrl,
      text: false,
      mode: input.mode,
      language: input.language,
    });
    const execution = await this.request(url);
    if (execution.providerUnits < 1) {
      throw new SupadataTranscriptClientError(
        'Supadata transcript submission reported no billable request',
        'BILLING_HEADER_INVALID',
        execution.response.status,
      );
    }
    const evidence = {
      requestMetadataHash,
      responseMetadataHash: sha256CanonicalJson({
        httpStatus: execution.response.status,
        body: execution.decoded as JsonValue,
      }),
      providerUnits: execution.providerUnits,
      durationMs: execution.durationMs,
    };
    if (execution.response.status === 206) {
      const error = errorFacts(execution.decoded);
      if (error.code !== 'transcript-unavailable') {
        throw new SupadataTranscriptClientError(
          error.summary,
          'PROVIDER_REJECTED',
          execution.response.status,
        );
      }
      return {
        kind: 'UNAVAILABLE',
        errorCode: error.code,
        errorSummary: error.summary,
        ...evidence,
      };
    }
    if (execution.response.status === 202) {
      const parsed = jobSchema.safeParse(execution.decoded);
      if (!parsed.success) {
        throw new SupadataTranscriptClientError(
          'Supadata async response did not contain a valid job ID',
          'SCHEMA_FAILED',
          execution.response.status,
        );
      }
      return {
        kind: 'PENDING',
        jobId: parsed.data.jobId,
        providerJobIdHash: jobIdHash(parsed.data.jobId),
        ...evidence,
      };
    }
    if (!execution.response.ok) {
      const error = errorFacts(execution.decoded);
      throw new SupadataTranscriptClientError(
        error.summary,
        execution.response.status === 401 || execution.response.status === 402
          ? 'AUTH_OR_QUOTA'
          : execution.response.status === 429
            ? 'RATE_LIMITED'
            : 'PROVIDER_REJECTED',
        execution.response.status,
      );
    }
    const parsed = transcriptSchema.safeParse(execution.decoded);
    if (!parsed.success) {
      throw new SupadataTranscriptClientError(
        `Supadata transcript schema failed: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        'SCHEMA_FAILED',
        execution.response.status,
      );
    }
    if (parsed.data.content.length === 0) {
      return {
        kind: 'EMPTY',
        language: parsed.data.lang,
        availableLanguages: parsed.data.availableLangs,
        ...evidence,
      };
    }
    return {
      kind: 'COMPLETED',
      language: parsed.data.lang,
      availableLanguages: parsed.data.availableLangs,
      segments: canonicalSegments(parsed.data.content),
      ...evidence,
    };
  }

  async poll(jobId: string): Promise<SupadataPollResult> {
    const parsedJobId = jobSchema.shape.jobId.parse(jobId);
    const providerJobIdHash = jobIdHash(parsedJobId);
    const requestMetadataHash = sha256CanonicalJson({
      provider: 'supadata',
      revision: PROVIDER_REVISION,
      operation: 'transcript.poll',
      providerJobIdHash,
    });
    const execution = await this.request(
      new URL(`https://api.supadata.ai/v1/transcript/${encodeURIComponent(parsedJobId)}`),
    );
    if (!execution.response.ok) {
      const error = errorFacts(execution.decoded);
      throw new SupadataTranscriptClientError(
        error.summary,
        execution.response.status === 404 ? 'PROVIDER_JOB_EXPIRED' : 'PROVIDER_POLL_FAILED',
        execution.response.status,
      );
    }
    const parsed = jobStatusSchema.safeParse(execution.decoded);
    if (!parsed.success) {
      throw new SupadataTranscriptClientError(
        `Supadata job schema failed: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        'SCHEMA_FAILED',
        execution.response.status,
      );
    }
    const evidence = {
      requestMetadataHash,
      responseMetadataHash: sha256CanonicalJson({
        httpStatus: execution.response.status,
        body: execution.decoded as JsonValue,
      }),
      providerUnits: execution.providerUnits,
      durationMs: execution.durationMs,
      providerJobIdHash,
    };
    if (parsed.data.status === 'queued' || parsed.data.status === 'active') {
      return { kind: 'PENDING', providerStatus: parsed.data.status, ...evidence };
    }
    if (parsed.data.status === 'failed') {
      const error = errorFacts(parsed.data.error);
      return { kind: 'FAILED', errorCode: error.code, errorSummary: error.summary, ...evidence };
    }
    const completed = transcriptSchema.safeParse({
      content: parsed.data.content,
      lang: parsed.data.lang,
      availableLangs: parsed.data.availableLangs,
    });
    if (!completed.success) {
      throw new SupadataTranscriptClientError(
        `Supadata completed job had no valid transcript: ${completed.error.issues[0]?.message ?? 'unknown'}`,
        'SCHEMA_FAILED',
        execution.response.status,
      );
    }
    if (completed.data.content.length === 0) {
      return {
        kind: 'EMPTY',
        language: completed.data.lang,
        availableLanguages: completed.data.availableLangs,
        ...evidence,
      };
    }
    return {
      kind: 'COMPLETED',
      language: completed.data.lang,
      availableLanguages: completed.data.availableLangs,
      segments: canonicalSegments(completed.data.content),
      ...evidence,
    };
  }
}

export const SUPADATA_PROVIDER_REVISION = PROVIDER_REVISION;
