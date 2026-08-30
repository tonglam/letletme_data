import { createHash } from 'node:crypto';

import { z } from 'zod';

import { sha256CanonicalJson } from './canonicalization';
import type { XScanRunRequestV1 } from './formal-run-contract';
import type { GrokBuildXPostV1 } from './grok-build-executor';
import { canonicalXPostUrl } from './x-query-compiler';

const TIKHUB_TIMELINE_URL = 'https://api.tikhub.io/api/v1/twitter/web/fetch_user_post_tweet';
const DEFAULT_RUN_TIMEOUT_MS = 5 * 60_000;
const OBSERVED_UNIT_PRICE_USD = 0.001;
const OBSERVED_PRICING_REVISION = '2026-08-30-fetch-user-post-tweet';

const authorSchema = z
  .object({
    rest_id: z.string().regex(/^\d{1,20}$/),
    screen_name: z.string().min(1).max(100),
  })
  .passthrough();

const timelinePostSchema = z
  .object({
    tweet_id: z.string().regex(/^\d{1,20}$/),
    created_at: z.string().min(1).max(200),
    text: z.string().max(100_000),
    author: authorSchema,
    retweeted_tweet: z.unknown().optional(),
  })
  .passthrough();

const pageDataSchema = z
  .object({
    // TikHub has returned both null and an empty string at the end of a
    // timeline. Normalize either form after schema validation.
    next_cursor: z.string().max(20_000).nullable().optional(),
    timeline: z.array(z.unknown()).max(200),
    user: authorSchema,
  })
  .passthrough();

const responseEnvelopeSchema = z
  .object({
    code: z.number().int(),
    request_id: z.string().min(1).max(512),
  })
  .passthrough();

const responseSchema = responseEnvelopeSchema
  .extend({
    data: pageDataSchema,
  })
  .passthrough();

type TimelineMember = XScanRunRequestV1['partition']['members'][number];

export type TikHubXTimelineFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type TikHubXProviderCallAdmission = Readonly<{
  releaseIfUnused: () => Promise<void> | void;
}>;

export type TikHubXExecutionHooks = Readonly<{
  /** Local-clock deadline derived from the persisted PostgreSQL run lease. */
  runDeadlineAtMs?: number;
  beforeProviderCall?: (
    callIndex: number,
  ) => Promise<TikHubXProviderCallAdmission | void> | TikHubXProviderCallAdmission | void;
  onProviderCallStart?: (callIndex: number) => void;
}>;

export type TikHubXMemberMetrics = Readonly<{
  endpointKey: string;
  pages: number;
  rawPosts: number;
  acceptedPosts: number;
  excludedRetweets: number;
  excludedOutsideWindow: number;
  duplicatePosts: number;
  boundaryComplete: boolean;
  pageCapReached: boolean;
}>;

export type TikHubXTimelineExecutionResult = Readonly<{
  provider: 'tikhub';
  operation: 'fetch_user_post_tweet';
  posts: readonly GrokBuildXPostV1[];
  providerUnits: number;
  requestMetadataHash: string;
  responseMetadataHash: string;
  providerJobIdHash: string;
  durationMs: number;
  responseBytes: number;
  rawReturnedCount: number;
  excludedRetweets: number;
  excludedOutsideWindow: number;
  duplicatePosts: number;
  saturated: boolean;
  memberMetrics: readonly TikHubXMemberMetrics[];
  estimatedCostUsd: number;
  pricingRevision: string;
}>;

export type TikHubXFailureEvidence = Readonly<{
  provider: 'tikhub';
  operation: 'fetch_user_post_tweet';
  requestMetadataHash: string;
  responseMetadataHash: string | null;
  providerJobIdHash: string | null;
  providerUnits: number;
  durationMs: number;
  responseBytes: number;
  httpStatus: number | null;
  estimatedCostUsd: number;
  pricingRevision: string;
}>;

export class TikHubXTimelineError extends Error {
  readonly failureClass: string;
  readonly evidence: TikHubXFailureEvidence | null;

  constructor(
    failureClass: string,
    message: string,
    evidence: TikHubXFailureEvidence | null = null,
  ) {
    super(message);
    this.name = 'TikHubXTimelineError';
    this.failureClass = failureClass;
    this.evidence = evidence;
  }
}

type AttemptEvidence = {
  startedAt: number;
  requestHashes: string[];
  responseHashes: string[];
  requestIdHashes: string[];
  providerUnits: number;
  responseBytes: number;
  httpStatus: number | null;
};

function aggregateHash(values: readonly string[]): string {
  return sha256CanonicalJson([...values]);
}

function failureEvidence(attempt: AttemptEvidence): TikHubXFailureEvidence | null {
  if (attempt.providerUnits < 1) return null;
  return {
    provider: 'tikhub',
    operation: 'fetch_user_post_tweet',
    requestMetadataHash: aggregateHash(attempt.requestHashes),
    responseMetadataHash:
      attempt.responseHashes.length > 0 ? aggregateHash(attempt.responseHashes) : null,
    providerJobIdHash:
      attempt.requestIdHashes.length > 0 ? aggregateHash(attempt.requestIdHashes) : null,
    providerUnits: attempt.providerUnits,
    durationMs: Date.now() - attempt.startedAt,
    responseBytes: attempt.responseBytes,
    httpStatus: attempt.httpStatus,
    estimatedCostUsd: attempt.providerUnits * OBSERVED_UNIT_PRICE_USD,
    pricingRevision: OBSERVED_PRICING_REVISION,
  };
}

function withEvidence(error: unknown, attempt: AttemptEvidence): TikHubXTimelineError {
  const evidence = failureEvidence(attempt);
  if (error instanceof TikHubXTimelineError) {
    return error.evidence
      ? error
      : new TikHubXTimelineError(error.failureClass, error.message, evidence);
  }
  return new TikHubXTimelineError(
    'TIKHUB_REQUEST_FAILED',
    error instanceof Error ? error.message : 'TikHub timeline request failed',
    evidence,
  );
}

async function boundedJson(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
  timeoutFailure: Readonly<{ failureClass: string; message: string }>,
  onBytesRead: (bytes: number) => void,
): Promise<{ decoded: unknown; bytes: number; bodyHash: string }> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isSafeInteger(declared) && declared > maximumBytes) {
    await response.body?.cancel('TikHub response exceeded the byte limit');
    throw new TikHubXTimelineError(
      'TIKHUB_OUTPUT_LIMIT',
      'TikHub response exceeded the byte limit',
    );
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      if (signal.aborted) {
        await reader.cancel('TikHub response timed out').catch(() => undefined);
        throw new TikHubXTimelineError(timeoutFailure.failureClass, timeoutFailure.message);
      }
      let abortListener: (() => void) | null = null;
      let abortHandled = false;
      const abortPromise = new Promise<never>((_, reject) => {
        abortListener = () => {
          if (abortHandled) return;
          abortHandled = true;
          void reader.cancel('TikHub response timed out').catch(() => undefined);
          reject(new TikHubXTimelineError(timeoutFailure.failureClass, timeoutFailure.message));
        };
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) abortListener();
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), abortPromise]);
      } finally {
        if (abortListener) signal.removeEventListener('abort', abortListener);
      }
      const { done, value } = chunk;
      if (done) break;
      total += value.byteLength;
      onBytesRead(value.byteLength);
      if (total > maximumBytes) {
        await reader.cancel('TikHub response exceeded the byte limit');
        throw new TikHubXTimelineError(
          'TIKHUB_OUTPUT_LIMIT',
          'TikHub response exceeded the byte limit',
        );
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (signal.aborted) {
    throw new TikHubXTimelineError(timeoutFailure.failureClass, timeoutFailure.message);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TikHubXTimelineError('TIKHUB_UTF8_INVALID', 'TikHub response was not valid UTF-8');
  }
  try {
    return {
      decoded: JSON.parse(text),
      bytes: total,
      bodyHash: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    throw new TikHubXTimelineError('TIKHUB_SCHEMA_INVALID', 'TikHub response was not JSON');
  }
}

function memberRequest(member: TimelineMember): {
  key: 'rest_id' | 'screen_name';
  value: string;
  handle: string;
} {
  const handle = member.locator.handle?.trim();
  if (!handle) {
    throw new TikHubXTimelineError(
      'TIKHUB_MEMBER_IDENTITY_INVALID',
      'TikHub timeline member has no handle',
    );
  }
  if (member.stableExternalId !== null) {
    if (!/^\d{1,20}$/.test(member.stableExternalId)) {
      throw new TikHubXTimelineError(
        'TIKHUB_MEMBER_IDENTITY_INVALID',
        'TikHub timeline stable user ID is not numeric',
      );
    }
    return { key: 'rest_id', value: member.stableExternalId, handle };
  }
  if (member.identityRequirement !== 'HANDLE_ONLY') {
    throw new TikHubXTimelineError(
      'TIKHUB_MEMBER_IDENTITY_INVALID',
      'TikHub timeline member requires either a stable user ID or HANDLE_ONLY policy',
    );
  }
  return { key: 'screen_name', value: handle, handle };
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new TikHubXTimelineError(
      'TIKHUB_POST_TIME_INVALID',
      'TikHub timeline post has an invalid creation time',
    );
  }
  return parsed;
}

function isRetweet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

export class TikHubXTimelineClient {
  private readonly apiKey: string;
  private readonly fetchImpl: TikHubXTimelineFetch;
  private readonly timeoutMs: number;
  private readonly runTimeoutMs: number;
  private readonly maximumResponseBytes: number;
  private readonly maximumPagesPerMember: number;
  private readonly endpointUrl: string;

  constructor(input: {
    apiKey: string;
    timeoutMs: number;
    maximumResponseBytes: number;
    maximumPagesPerMember: number;
    runTimeoutMs?: number;
    fetchImpl?: TikHubXTimelineFetch;
    endpointUrl?: string;
  }) {
    if (!input.apiKey.trim()) throw new Error('TikHub API key is required');
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1_000) {
      throw new Error('TikHub timeout must be at least one second');
    }
    const runTimeoutMs = input.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(runTimeoutMs) ||
      runTimeoutMs < 1_000 ||
      runTimeoutMs > DEFAULT_RUN_TIMEOUT_MS
    ) {
      throw new Error('TikHub run timeout must be between one second and five minutes');
    }
    if (!Number.isSafeInteger(input.maximumResponseBytes) || input.maximumResponseBytes < 1_024) {
      throw new Error('TikHub response limit must be at least 1024 bytes');
    }
    if (
      !Number.isSafeInteger(input.maximumPagesPerMember) ||
      input.maximumPagesPerMember < 1 ||
      input.maximumPagesPerMember > 100
    ) {
      throw new Error('TikHub maximum pages per member must be between 1 and 100');
    }
    if (input.endpointUrl && !input.fetchImpl) {
      throw new Error('A custom TikHub endpoint is allowed only with an injected test fetch');
    }
    this.apiKey = input.apiKey.trim();
    this.fetchImpl = input.fetchImpl ?? fetch;
    this.timeoutMs = input.timeoutMs;
    this.runTimeoutMs = runTimeoutMs;
    this.maximumResponseBytes = input.maximumResponseBytes;
    this.maximumPagesPerMember = input.maximumPagesPerMember;
    this.endpointUrl = input.endpointUrl ?? TIKHUB_TIMELINE_URL;
  }

  async execute(
    request: XScanRunRequestV1,
    hooks: TikHubXExecutionHooks = {},
  ): Promise<TikHubXTimelineExecutionResult> {
    if (
      request.providerRoute !== 'TIKHUB_TIMELINE' ||
      request.jobKind !== 'X_KEYWORD_SCAN' ||
      request.adapterKind !== 'X_ACCOUNT'
    ) {
      throw new TikHubXTimelineError(
        'TIKHUB_REQUEST_INVALID',
        'TikHub timeline requires a persisted fixed-account scan request',
      );
    }
    const attempt: AttemptEvidence = {
      startedAt: Date.now(),
      requestHashes: [],
      responseHashes: [],
      requestIdHashes: [],
      providerUnits: 0,
      responseBytes: 0,
      httpStatus: null,
    };
    if (
      hooks.runDeadlineAtMs !== undefined &&
      (!Number.isSafeInteger(hooks.runDeadlineAtMs) || hooks.runDeadlineAtMs <= 0)
    ) {
      throw new TikHubXTimelineError(
        'TIKHUB_REQUEST_INVALID',
        'TikHub timeline run deadline is invalid',
      );
    }
    const runDeadlineAt = Math.min(
      attempt.startedAt + this.runTimeoutMs,
      hooks.runDeadlineAtMs ?? Number.POSITIVE_INFINITY,
    );
    const windowStart = Date.parse(request.windowStart);
    const windowEnd = Date.parse(request.windowEnd);
    const uniquePosts = new Map<string, GrokBuildXPostV1>();
    const memberMetrics: TikHubXMemberMetrics[] = [];
    let rawReturnedCount = 0;
    let excludedRetweets = 0;
    let excludedOutsideWindow = 0;
    let duplicatePosts = 0;

    try {
      for (const member of request.partition.members) {
        const identity = memberRequest(member);
        let cursor: string | null = null;
        const seenCursors = new Set<string>();
        let pages = 0;
        let memberRawPosts = 0;
        let memberAcceptedPosts = 0;
        let memberRetweets = 0;
        let memberOutside = 0;
        let memberDuplicates = 0;
        let boundaryComplete = false;
        let pageCapReached = false;

        while (pages < this.maximumPagesPerMember) {
          if (Date.now() >= runDeadlineAt) {
            throw new TikHubXTimelineError(
              'TIKHUB_RUN_TIMEOUT',
              'TikHub timeline run exceeded its bounded execution time',
            );
          }
          const url = new URL(this.endpointUrl);
          url.searchParams.set(identity.key, identity.value);
          if (cursor) url.searchParams.set('cursor', cursor);
          const requestMetadata = {
            operation: 'fetch_user_post_tweet',
            endpointKey: member.endpointKey,
            identityKind: identity.key,
            identityHash: createHash('sha256').update(identity.value, 'utf8').digest('hex'),
            cursorHash: cursor ? createHash('sha256').update(cursor, 'utf8').digest('hex') : null,
          };
          const requestMetadataHash = sha256CanonicalJson(requestMetadata);
          const callIndex = attempt.providerUnits;
          const admission = await hooks.beforeProviderCall?.(callIndex);
          const remainingRunMs = runDeadlineAt - Date.now();
          if (remainingRunMs <= 0) {
            await admission?.releaseIfUnused();
            throw new TikHubXTimelineError(
              'TIKHUB_RUN_TIMEOUT',
              'TikHub timeline run exceeded its bounded execution time',
            );
          }
          attempt.requestHashes.push(requestMetadataHash);
          try {
            hooks.onProviderCallStart?.(callIndex);
          } catch (error) {
            await admission?.releaseIfUnused();
            throw error;
          }
          attempt.providerUnits += 1;
          const controller = new AbortController();
          const runDeadlineLimitsCall = remainingRunMs <= this.timeoutMs;
          const timeoutFailure = runDeadlineLimitsCall
            ? {
                failureClass: 'TIKHUB_RUN_TIMEOUT',
                message: 'TikHub timeline run exceeded its bounded execution time',
              }
            : {
                failureClass: 'TIKHUB_TIMEOUT',
                message: 'TikHub timeline request timed out',
              };
          const timer = setTimeout(
            () => controller.abort(),
            Math.min(this.timeoutMs, remainingRunMs),
          );
          let response: Response;
          let body: { decoded: unknown; bytes: number; bodyHash: string };
          try {
            try {
              response = await this.fetchImpl(url, {
                method: 'GET',
                headers: {
                  accept: 'application/json',
                  authorization: `Bearer ${this.apiKey}`,
                },
                redirect: 'error',
                signal: controller.signal,
              });
              attempt.httpStatus = response.status;
              body = await boundedJson(
                response,
                this.maximumResponseBytes,
                controller.signal,
                timeoutFailure,
                (bytes) => {
                  attempt.responseBytes += bytes;
                },
              );
            } catch (error) {
              if (error instanceof TikHubXTimelineError) throw error;
              if (controller.signal.aborted) {
                throw new TikHubXTimelineError(timeoutFailure.failureClass, timeoutFailure.message);
              }
              throw new TikHubXTimelineError(
                'TIKHUB_TRANSPORT_FAILED',
                'TikHub timeline transport failed',
              );
            }
          } finally {
            clearTimeout(timer);
          }
          attempt.responseHashes.push(
            sha256CanonicalJson({
              status: response.status,
              bodyHash: body.bodyHash,
              bytes: body.bytes,
            }),
          );
          const envelope = responseEnvelopeSchema.safeParse(body.decoded);
          if (envelope.success) {
            attempt.requestIdHashes.push(
              createHash('sha256').update(envelope.data.request_id, 'utf8').digest('hex'),
            );
          }
          const parsed = responseSchema.safeParse(body.decoded);
          if (!response.ok || !parsed.success || parsed.data.code !== 200) {
            throw new TikHubXTimelineError(
              response.status === 401 || response.status === 403
                ? 'TIKHUB_AUTH_FAILED'
                : response.status === 429
                  ? 'TIKHUB_RATE_LIMITED'
                  : !parsed.success
                    ? envelope.success && envelope.data.code !== 200
                      ? 'TIKHUB_PROVIDER_REJECTED'
                      : 'TIKHUB_SCHEMA_INVALID'
                    : 'TIKHUB_PROVIDER_REJECTED',
              'TikHub timeline response failed HTTP, provider or schema validation',
            );
          }
          const responseUser = parsed.data.data.user;
          if (
            responseUser.screen_name.toLowerCase() !== identity.handle.toLowerCase() ||
            (identity.key === 'rest_id' && responseUser.rest_id !== identity.value)
          ) {
            throw new TikHubXTimelineError(
              'TIKHUB_IDENTITY_MISMATCH',
              'TikHub timeline response user does not match the persisted endpoint',
            );
          }
          pages += 1;
          const pageTimes: number[] = [];
          for (const rawPost of parsed.data.data.timeline) {
            const post = timelinePostSchema.safeParse(rawPost);
            if (!post.success) {
              throw new TikHubXTimelineError(
                'TIKHUB_POST_SCHEMA_INVALID',
                'TikHub timeline contained an unparseable post item',
              );
            }
            const createdAtMs = timestamp(post.data.created_at);
            pageTimes.push(createdAtMs);
            rawReturnedCount += 1;
            memberRawPosts += 1;
            if (
              post.data.author.screen_name.toLowerCase() !== identity.handle.toLowerCase() ||
              post.data.author.rest_id !== responseUser.rest_id
            ) {
              throw new TikHubXTimelineError(
                'TIKHUB_AUTHOR_MISMATCH',
                'TikHub timeline post author escaped the persisted endpoint identity',
              );
            }
            if (isRetweet(post.data.retweeted_tweet)) {
              excludedRetweets += 1;
              memberRetweets += 1;
              continue;
            }
            if (createdAtMs < windowStart || createdAtMs > windowEnd) {
              excludedOutsideWindow += 1;
              memberOutside += 1;
              continue;
            }
            const normalizedPost: GrokBuildXPostV1 = {
              postId: post.data.tweet_id,
              authorHandle: post.data.author.screen_name,
              createdAt: new Date(createdAtMs).toISOString(),
              text: post.data.text,
              url: canonicalXPostUrl(post.data.author.screen_name, post.data.tweet_id),
            };
            const prior = uniquePosts.get(normalizedPost.postId);
            if (prior) {
              if (sha256CanonicalJson(prior) !== sha256CanonicalJson(normalizedPost)) {
                throw new TikHubXTimelineError(
                  'TIKHUB_POST_CONFLICT',
                  'TikHub timeline returned conflicting facts for one post ID',
                );
              }
              duplicatePosts += 1;
              memberDuplicates += 1;
              continue;
            }
            uniquePosts.set(normalizedPost.postId, normalizedPost);
            memberAcceptedPosts += 1;
          }
          const pageNewest = pageTimes.length > 0 ? Math.max(...pageTimes) : null;
          cursor = parsed.data.data.next_cursor?.trim() || null;
          if (!cursor) {
            boundaryComplete = true;
            break;
          }
          if (seenCursors.has(cursor)) {
            throw new TikHubXTimelineError(
              'TIKHUB_CURSOR_LOOP',
              'TikHub timeline repeated a pagination cursor',
            );
          }
          seenCursors.add(cursor);
          // A pinned old post can appear above current posts on a timeline.
          // Crossing the window is therefore proven only when every post on
          // the fetched page is older than the window, not when any one item
          // is older. This may spend one extra page, but cannot stop early on
          // a pinned or otherwise out-of-order item.
          if (pageNewest !== null && pageNewest < windowStart) {
            boundaryComplete = true;
            break;
          }
        }
        if (!boundaryComplete) pageCapReached = true;
        memberMetrics.push({
          endpointKey: member.endpointKey,
          pages,
          rawPosts: memberRawPosts,
          acceptedPosts: memberAcceptedPosts,
          excludedRetweets: memberRetweets,
          excludedOutsideWindow: memberOutside,
          duplicatePosts: memberDuplicates,
          boundaryComplete,
          pageCapReached,
        });
      }
    } catch (error) {
      throw withEvidence(error, attempt);
    }

    return {
      provider: 'tikhub',
      operation: 'fetch_user_post_tweet',
      posts: [...uniquePosts.values()],
      providerUnits: attempt.providerUnits,
      requestMetadataHash: aggregateHash(attempt.requestHashes),
      responseMetadataHash: aggregateHash(attempt.responseHashes),
      providerJobIdHash: aggregateHash(attempt.requestIdHashes),
      durationMs: Date.now() - attempt.startedAt,
      responseBytes: attempt.responseBytes,
      rawReturnedCount,
      excludedRetweets,
      excludedOutsideWindow,
      duplicatePosts,
      saturated: memberMetrics.some((member) => member.pageCapReached),
      memberMetrics,
      estimatedCostUsd: attempt.providerUnits * OBSERVED_UNIT_PRICE_USD,
      pricingRevision: OBSERVED_PRICING_REVISION,
    };
  }
}
