import { TextDecoder } from 'node:util';

import { z } from 'zod';

import { normalizeCanonicalText, sha256CanonicalJson } from './canonicalization';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const hermesResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal('COMPLETED'),
    mediaSha256: hash,
    engine: z.literal('faster-whisper'),
    modelRevision: z.string().min(1).max(200),
    optionsRevision: z.string().min(1).max(200),
    language: z.string().min(1).max(64).nullable(),
    durationSeconds: z
      .number()
      .finite()
      .positive()
      .max(24 * 60 * 60),
    segments: z
      .array(
        z
          .object({
            startMs: z.number().int().nonnegative(),
            endMs: z.number().int().positive(),
            text: z.string().min(1).max(20_000),
          })
          .strict(),
      )
      .min(1)
      .max(20_000),
    chunks: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            startMs: z.number().int().nonnegative(),
            endMs: z.number().int().positive(),
            audioSha256: hash,
          })
          .strict(),
      )
      .min(1)
      .max(1_000),
  })
  .strict();

export type HermesTranscriptExecution = Readonly<{
  mediaHash: string;
  engine: 'faster-whisper';
  modelRevision: string;
  optionsRevision: string;
  language: string | null;
  durationSeconds: number;
  segments: readonly Readonly<{ startMs: number; endMs: number; text: string }>[];
  chunkCount: number;
  requestMetadataHash: string;
  responseMetadataHash: string;
  providerUnits: number;
  durationMs: number;
}>;

export type HermesTranscriptClientLike = Readonly<{
  transcribe: (input: {
    runId: string;
    externalItemId: string;
    mediaUrl: string;
    expectedDurationSeconds: number;
    chunkDurationSeconds: number;
  }) => Promise<HermesTranscriptExecution>;
}>;

export type HermesFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class HermesTranscriptError extends Error {
  readonly failureClass: string;

  constructor(failureClass: string, message: string) {
    super(message);
    this.name = 'HermesTranscriptError';
    this.failureClass = failureClass;
  }
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new HermesTranscriptError(
      'HERMES_RESPONSE_TOO_LARGE',
      'Hermes Content-Length exceeds the configured limit',
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel('response limit exceeded').catch(() => undefined);
      throw new HermesTranscriptError(
        'HERMES_RESPONSE_TOO_LARGE',
        'Hermes response exceeded the configured limit',
      );
    }
    chunks.push(chunk.value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export class HermesTranscriptClient implements HermesTranscriptClientLike {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maximumResponseBytes: number;
  private readonly fetchImpl: HermesFetch;

  constructor(input: {
    endpoint: string;
    token: string;
    timeoutMs: number;
    maximumResponseBytes: number;
    fetchImpl?: HermesFetch;
  }) {
    const endpoint = new URL(input.endpoint);
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password
    ) {
      throw new Error('Hermes transcript endpoint must be an HTTP(S) URL without credentials');
    }
    if (!input.token.trim()) throw new Error('Hermes transcript token is required');
    this.endpoint = endpoint.toString();
    this.token = input.token;
    this.timeoutMs = input.timeoutMs;
    this.maximumResponseBytes = input.maximumResponseBytes;
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  async transcribe(input: {
    runId: string;
    externalItemId: string;
    mediaUrl: string;
    expectedDurationSeconds: number;
    chunkDurationSeconds: number;
  }): Promise<HermesTranscriptExecution> {
    const media = new URL(input.mediaUrl);
    if (!['http:', 'https:'].includes(media.protocol) || media.username || media.password) {
      throw new HermesTranscriptError(
        'HERMES_MEDIA_URL_INVALID',
        'Media URL is not public HTTP(S)',
      );
    }
    const requestBody = {
      schemaVersion: 1 as const,
      requestId: input.runId,
      externalItemId: input.externalItemId,
      mediaUrl: media.toString(),
      expectedDurationSeconds: input.expectedDurationSeconds,
      chunkDurationSeconds: input.chunkDurationSeconds,
    };
    const requestMetadataHash = sha256CanonicalJson({
      endpoint: this.endpoint,
      ...requestBody,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = performance.now();
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      clearTimeout(timer);
      throw new HermesTranscriptError(
        error instanceof DOMException && error.name === 'AbortError'
          ? 'HERMES_TIMEOUT'
          : 'HERMES_REQUEST_FAILED',
        error instanceof Error ? error.message : 'Hermes transcript request failed',
      );
    }
    try {
      if (response.status !== 200) {
        throw new HermesTranscriptError(
          response.status === 401 || response.status === 403
            ? 'HERMES_AUTH_FAILED'
            : 'HERMES_HTTP_STATUS',
          `Hermes transcript endpoint returned ${response.status}`,
        );
      }
      if (!/application\/json/i.test(response.headers.get('content-type') ?? '')) {
        throw new HermesTranscriptError(
          'HERMES_CONTENT_TYPE',
          'Hermes transcript endpoint did not return JSON',
        );
      }
      const bytes = await readBoundedResponse(response, this.maximumResponseBytes);
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        throw new HermesTranscriptError(
          'HERMES_RESPONSE_INVALID',
          'Hermes response is not UTF-8 JSON',
        );
      }
      const parsed = hermesResponseSchema.safeParse(value);
      if (!parsed.success) {
        throw new HermesTranscriptError(
          'HERMES_SCHEMA_FAILED',
          `Hermes response failed schema validation: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.')}:${issue.message}`)
            .join('; ')}`,
        );
      }
      if (Math.abs(parsed.data.durationSeconds - input.expectedDurationSeconds) > 5) {
        throw new HermesTranscriptError(
          'HERMES_DURATION_MISMATCH',
          'Hermes media duration differs from the persisted feed duration',
        );
      }
      let priorStart = -1;
      let priorEnd = -1;
      const segments = parsed.data.segments.map((segment) => {
        const text = normalizeCanonicalText(segment.text);
        if (
          !text ||
          segment.endMs <= segment.startMs ||
          segment.startMs < priorStart ||
          segment.endMs < priorEnd
        ) {
          throw new HermesTranscriptError(
            'HERMES_SEGMENTS_INVALID',
            'Hermes transcript segments are blank, inverted, or non-monotonic',
          );
        }
        priorStart = segment.startMs;
        priorEnd = segment.endMs;
        return { ...segment, text };
      });
      const finalSegment = segments.at(-1);
      if (finalSegment && finalSegment.endMs > parsed.data.durationSeconds * 1_000 + 2_000) {
        throw new HermesTranscriptError(
          'HERMES_SEGMENTS_EXCEED_MEDIA',
          'Hermes transcript exceeds the returned media duration',
        );
      }
      return {
        mediaHash: parsed.data.mediaSha256,
        engine: parsed.data.engine,
        modelRevision: parsed.data.modelRevision,
        optionsRevision: parsed.data.optionsRevision,
        language: parsed.data.language,
        durationSeconds: parsed.data.durationSeconds,
        segments,
        chunkCount: parsed.data.chunks.length,
        requestMetadataHash,
        responseMetadataHash: sha256CanonicalJson(parsed.data),
        providerUnits: parsed.data.durationSeconds,
        durationMs: Math.round(performance.now() - startedAt),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
