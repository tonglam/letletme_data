import type { AcquisitionBatchV1, AcquisitionItemV1 } from './acquisition-contract';
import { normalizeCanonicalText, sha256CanonicalJson } from './canonicalization';
import type { XScanRunRequestV1 } from './formal-run-contract';
import type { GrokBuildExecutionResult, GrokBuildXPostV1 } from './grok-build-executor';
import { canonicalXPostUrl } from './x-query-compiler';

const X_SNOWFLAKE_EPOCH_MS = 1_288_834_974_657n;
const SNOWFLAKE_TIME_TOLERANCE_MS = 5_000;

export type XPostRejection = Readonly<{
  endpointKey: string;
  externalItemId: string;
  reasonCode: string;
  nativeItemHash: string;
}>;

export type XPostAdapterResult = Readonly<{
  stateHint: 'EMPTY' | 'COMPLETED' | 'PARTIAL' | 'SATURATED';
  batches: readonly AcquisitionBatchV1[];
  rejections: readonly XPostRejection[];
  returnedCount: number;
  acceptedCount: number;
  saturated: boolean;
  newestPostId: string | null;
  oldestAcceptedAt: string | null;
}>;

export type ResolvedSemanticXAuthor = Readonly<{
  authorHandle: string;
  endpointKey: string;
  stableExternalId: string | null;
}>;

export class XPostQualityError extends Error {
  readonly failureClass: string;
  readonly rejections: readonly XPostRejection[];

  constructor(failureClass: string, message: string, rejections: readonly XPostRejection[] = []) {
    super(message);
    this.name = 'XPostQualityError';
    this.failureClass = failureClass;
    this.rejections = rejections;
  }
}

export function xSnowflakeTimestamp(postId: string): Date {
  let value: bigint;
  try {
    value = BigInt(postId);
  } catch {
    throw new XPostQualityError('X_POST_ID_INVALID', 'X post ID is not a numeric Snowflake');
  }
  if (value <= 0n) {
    throw new XPostQualityError('X_POST_ID_INVALID', 'X post ID must be positive');
  }
  const milliseconds = (value >> 22n) + X_SNOWFLAKE_EPOCH_MS;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new XPostQualityError('X_POST_ID_INVALID', 'X post Snowflake time is out of range');
  }
  const timestamp = new Date(Number(milliseconds));
  if (!Number.isFinite(timestamp.getTime())) {
    throw new XPostQualityError('X_POST_ID_INVALID', 'X post Snowflake time is invalid');
  }
  return timestamp;
}

function validateReturnedUrl(post: GrokBuildXPostV1): void {
  let url: URL;
  try {
    url = new URL(post.url);
  } catch {
    throw new XPostQualityError('X_POST_URL_INVALID', 'X post URL is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname.toLowerCase())
  ) {
    throw new XPostQualityError('X_POST_URL_INVALID', 'X post URL is not an HTTPS X URL');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const statusIndex = parts.findIndex((part) => part.toLowerCase() === 'status');
  if (
    statusIndex !== 1 ||
    parts[0]?.toLowerCase() !== post.authorHandle.toLowerCase() ||
    parts[2] !== post.postId
  ) {
    throw new XPostQualityError('X_POST_URL_MISMATCH', 'X post URL facts do not match the post');
  }
}

function validatePostFacts(input: { post: GrokBuildXPostV1; request: XScanRunRequestV1 }): void {
  const createdAt = Date.parse(input.post.createdAt);
  const windowStart = Date.parse(input.request.windowStart);
  const windowEnd = Date.parse(input.request.windowEnd);
  if (createdAt < windowStart || createdAt > windowEnd) {
    throw new XPostQualityError(
      'X_POST_OUTSIDE_WINDOW',
      'X post creation time is outside the persisted request window',
    );
  }
  if (
    Math.abs(xSnowflakeTimestamp(input.post.postId).getTime() - createdAt) >
    SNOWFLAKE_TIME_TOLERANCE_MS
  ) {
    throw new XPostQualityError(
      'X_SNOWFLAKE_TIME_MISMATCH',
      'X post Snowflake and createdAt differ by more than five seconds',
    );
  }
  if (!normalizeCanonicalText(input.post.text)) {
    throw new XPostQualityError('X_POST_TEXT_EMPTY', 'X post text is blank after normalization');
  }
  validateReturnedUrl(input.post);
}

function toAcquisitionItem(input: {
  post: GrokBuildXPostV1;
  endpointKey: string;
  stableExternalId: string | null;
}): AcquisitionItemV1 {
  const canonicalUrl = canonicalXPostUrl(input.post.authorHandle, input.post.postId);
  return {
    endpointKey: input.endpointKey,
    externalItemId: input.post.postId,
    canonicalUrl,
    sourceUrl: canonicalUrl,
    linkAvailability: 'DIRECT',
    publishedAt: new Date(input.post.createdAt).toISOString(),
    updatedAt: null,
    title: null,
    authorExternalId: input.stableExternalId,
    contentKind: 'POST',
    body: { availability: 'FULL', text: input.post.text },
    media: [],
    transcript: {
      status: 'NOT_APPLICABLE',
      language: null,
      trackKind: null,
      providerRevision: null,
      segments: [],
    },
  };
}

function uniqueExecutionPosts(
  posts: readonly GrokBuildXPostV1[],
): ReadonlyMap<string, GrokBuildXPostV1> {
  const uniquePosts = new Map<string, GrokBuildXPostV1>();
  for (const post of posts) {
    const prior = uniquePosts.get(post.postId);
    if (prior && sha256CanonicalJson(prior) !== sha256CanonicalJson(post)) {
      throw new XPostQualityError(
        'X_POST_CONFLICT',
        `Grok returned conflicting facts for X post ${post.postId}`,
      );
    }
    uniquePosts.set(post.postId, post);
  }
  return uniquePosts;
}

export function prevalidateGrokBuildPostsForAuthorResolution(input: {
  request: XScanRunRequestV1;
  execution: GrokBuildExecutionResult;
}): readonly GrokBuildXPostV1[] {
  const valid: GrokBuildXPostV1[] = [];
  for (const post of uniqueExecutionPosts(input.execution.posts).values()) {
    try {
      validatePostFacts({ post, request: input.request });
      valid.push(post);
    } catch (error) {
      if (!(error instanceof XPostQualityError)) throw error;
    }
  }
  return valid;
}

function adaptMappedPosts(input: {
  request: XScanRunRequestV1;
  execution: GrokBuildExecutionResult;
  checkedAt: Date;
  limit: number;
  fallbackEndpointKey: string;
  resolveAuthor: (
    post: GrokBuildXPostV1,
  ) => Readonly<{ endpointKey: string; stableExternalId: string | null }> | undefined;
}): XPostAdapterResult {
  const uniquePosts = uniqueExecutionPosts(input.execution.posts);

  const itemsByEndpoint = new Map<string, AcquisitionItemV1[]>();
  const rejections: XPostRejection[] = [];
  for (const post of uniquePosts.values()) {
    let endpoint: Readonly<{ endpointKey: string; stableExternalId: string | null }> | undefined;
    try {
      endpoint = input.resolveAuthor(post);
      validatePostFacts({ post, request: input.request });
      if (!endpoint) {
        throw new XPostQualityError(
          'X_AUTHOR_UNRESOLVED',
          'X post author has no resolved source endpoint',
        );
      }
      const items = itemsByEndpoint.get(endpoint.endpointKey) ?? [];
      items.push(
        toAcquisitionItem({
          post,
          endpointKey: endpoint.endpointKey,
          stableExternalId: endpoint.stableExternalId,
        }),
      );
      itemsByEndpoint.set(endpoint.endpointKey, items);
    } catch (error) {
      const qualityError =
        error instanceof XPostQualityError
          ? error
          : new XPostQualityError('X_POST_INVALID', 'X post failed deterministic validation');
      rejections.push({
        endpointKey: endpoint?.endpointKey ?? input.fallbackEndpointKey,
        externalItemId: post.postId,
        reasonCode: qualityError.failureClass,
        nativeItemHash: sha256CanonicalJson(post),
      });
    }
  }

  const checkedAt = input.checkedAt.toISOString();
  const batches = [...itemsByEndpoint.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([endpointKey, items]) => ({
      schemaVersion: 1 as const,
      endpointKey,
      checkedAt,
      validator: {
        etag: null,
        lastModified: null,
        providerCursor:
          items
            .map((item) => item.externalItemId)
            .sort((left, right) => (BigInt(left) > BigInt(right) ? -1 : 1))[0] ?? null,
        cacheNotBefore: null,
      },
      transportBodyHash: null,
      items: items.sort((left, right) => {
        const timeDifference =
          Date.parse(right.publishedAt ?? '') - Date.parse(left.publishedAt ?? '');
        return timeDifference || right.externalItemId.localeCompare(left.externalItemId);
      }),
    }));
  const acceptedCount = batches.reduce((total, batch) => total + batch.items.length, 0);
  if (acceptedCount === 0 && rejections.length > 0) {
    throw new XPostQualityError(
      'X_ALL_POSTS_REJECTED',
      `All ${rejections.length} Grok posts failed deterministic validation`,
      rejections,
    );
  }
  const saturated = input.execution.posts.length >= input.limit;
  const stateHint =
    rejections.length > 0
      ? ('PARTIAL' as const)
      : acceptedCount === 0
        ? ('EMPTY' as const)
        : saturated
          ? ('SATURATED' as const)
          : ('COMPLETED' as const);
  const newestPostId =
    batches
      .flatMap((batch) => batch.items.map((item) => item.externalItemId))
      .sort((left, right) => (BigInt(left) > BigInt(right) ? -1 : 1))[0] ?? null;
  const oldestAcceptedAt =
    batches
      .flatMap((batch) =>
        batch.items.flatMap((item) => (item.publishedAt ? [item.publishedAt] : [])),
      )
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
  return {
    stateHint,
    batches,
    rejections,
    returnedCount: input.execution.posts.length,
    acceptedCount,
    saturated,
    newestPostId,
    oldestAcceptedAt,
  };
}

export function adaptGrokBuildPosts(input: {
  request: XScanRunRequestV1;
  execution: GrokBuildExecutionResult;
  checkedAt: Date;
}): XPostAdapterResult {
  if (input.request.jobKind !== 'X_KEYWORD_SCAN' && input.request.jobKind !== 'X_THREAD_FETCH') {
    throw new XPostQualityError(
      'X_SEMANTIC_MAPPING_UNAVAILABLE',
      'Semantic X posts require discovered-author source mapping before persistence',
    );
  }
  if (
    (input.request.jobKind === 'X_KEYWORD_SCAN' &&
      (input.request.toolRequest.toolName !== 'x_keyword_search' ||
        input.execution.toolName !== 'x_keyword_search')) ||
    (input.request.jobKind === 'X_THREAD_FETCH' &&
      (input.request.toolRequest.toolName !== 'x_thread_fetch' ||
        input.execution.toolName !== 'x_thread_fetch'))
  ) {
    throw new XPostQualityError('X_TOOL_MISMATCH', 'Keyword run did not use x_keyword_search');
  }
  const endpointByHandle = new Map(
    input.request.partition.members.map((member) => [
      member.locator.handle?.toLowerCase() ?? '',
      member,
    ]),
  );
  if (endpointByHandle.has('')) {
    throw new XPostQualityError('X_IDENTITY_INVALID', 'X partition member has no handle');
  }
  const allowedHandles = new Set(endpointByHandle.keys());
  const fallbackEndpointKey = input.request.partition.members[0]!.endpointKey;
  return adaptMappedPosts({
    ...input,
    limit:
      input.request.toolRequest.toolName === 'x_keyword_search'
        ? input.request.toolRequest.limit
        : 101,
    fallbackEndpointKey,
    resolveAuthor: (post) => {
      if (!allowedHandles.has(post.authorHandle.toLowerCase())) {
        throw new XPostQualityError(
          'X_AUTHOR_OUTSIDE_PARTITION',
          'X post author is outside the persisted partition snapshot',
        );
      }
      const endpoint = endpointByHandle.get(post.authorHandle.toLowerCase());
      if (!endpoint?.stableExternalId || !/^\d{1,20}$/.test(endpoint.stableExternalId)) {
        throw new XPostQualityError(
          'X_IDENTITY_INVALID',
          'X partition member is not bound to a numeric user ID',
        );
      }
      return { endpointKey: endpoint.endpointKey, stableExternalId: endpoint.stableExternalId };
    },
  });
}

export function adaptGrokBuildSemanticPosts(input: {
  request: XScanRunRequestV1;
  execution: GrokBuildExecutionResult;
  checkedAt: Date;
  authors: readonly ResolvedSemanticXAuthor[];
}): XPostAdapterResult {
  if (
    input.request.jobKind !== 'X_SEMANTIC_SCAN' ||
    input.request.toolRequest.toolName !== 'x_semantic_search' ||
    input.execution.toolName !== 'x_semantic_search'
  ) {
    throw new XPostQualityError('X_TOOL_MISMATCH', 'Semantic run did not use x_semantic_search');
  }
  const authorByHandle = new Map<string, ResolvedSemanticXAuthor>();
  for (const author of input.authors) {
    const key = author.authorHandle.toLowerCase();
    const prior = authorByHandle.get(key);
    if (prior && sha256CanonicalJson(prior) !== sha256CanonicalJson(author)) {
      throw new XPostQualityError(
        'X_AUTHOR_MAPPING_CONFLICT',
        `Semantic author ${author.authorHandle} has conflicting endpoint mappings`,
      );
    }
    authorByHandle.set(key, author);
  }
  return adaptMappedPosts({
    request: input.request,
    execution: input.execution,
    checkedAt: input.checkedAt,
    limit: input.request.toolRequest.limit,
    fallbackEndpointKey: input.request.partition.members[0]!.endpointKey,
    resolveAuthor: (post) => authorByHandle.get(post.authorHandle.toLowerCase()),
  });
}
