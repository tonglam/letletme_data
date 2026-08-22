import { describe, expect, test } from 'bun:test';

import type { XScanRunRequestV1 } from '../../../src/content/acquisition/formal-run-contract';
import type { GrokBuildExecutionResult } from '../../../src/content/acquisition/grok-build-executor';
import {
  adaptGrokBuildPosts,
  adaptGrokBuildSemanticPosts,
  prevalidateGrokBuildPostsForAuthorResolution,
  XPostQualityError,
  xSnowflakeTimestamp,
} from '../../../src/content/acquisition/x-post-adapter';

const request: XScanRunRequestV1 = {
  schemaVersion: 1,
  jobKind: 'X_KEYWORD_SCAN',
  adapterKind: 'X_ACCOUNT',
  phase: 'NORMAL',
  profileKey: 'x-official-core-v1',
  profileRevision: 1,
  windowStart: '2026-08-21T21:00:00.000Z',
  windowEnd: '2026-08-21T21:15:00.000Z',
  partition: {
    partitionId: '00000000-0000-4000-8000-000000000001',
    partitionKey: 'official-fpl',
    members: [
      {
        endpointId: '00000000-0000-4000-8000-000000000002',
        endpointKey: 'official-fpl-x',
        sourceId: '00000000-0000-4000-8000-000000000003',
        sourceKey: 'official-fpl',
        adapterKind: 'X_ACCOUNT',
        profileKey: 'x-official-core-v1',
        locator: { handle: 'OfficialFPL' },
        stableExternalId: '761568335138058240',
        rightsPolicy: {},
      },
    ],
  },
  toolRequest: {
    toolName: 'x_keyword_search',
    query:
      'from:OfficialFPL since:2026-08-21_21:00:00_UTC until:2026-08-21_21:15:00_UTC -is:retweet',
    mode: 'Latest',
    limit: 2,
  },
};

function execution(posts: GrokBuildExecutionResult['posts']): GrokBuildExecutionResult {
  return {
    toolName: 'x_keyword_search',
    toolInput: {
      query:
        'from:OfficialFPL since:2026-08-21_21:00:00_UTC until:2026-08-21_21:15:00_UTC -is:retweet',
      limit: 2,
      mode: 'Latest',
    },
    posts,
    users: [],
    requestMetadataHash: 'a'.repeat(64),
    responseMetadataHash: 'b'.repeat(64),
    traceHash: 'c'.repeat(64),
    toolCallIdHash: 'd'.repeat(64),
    eventCount: 5,
    durationMs: 100,
    inputTokens: 100,
    outputTokens: 20,
    totalCostUsd: 0.01,
    rawPostEvidenceAvailable: false,
  };
}

const posts = [
  {
    postId: '2090909465801371803',
    authorHandle: 'OfficialFPL',
    createdAt: '2026-08-21T21:10:38Z',
    text: 'I prefer not to speak',
    url: 'https://x.com/OfficialFPL/status/2090909465801371803',
  },
  {
    postId: '2090909411300507814',
    authorHandle: 'OfficialFPL',
    createdAt: '2026-08-21T21:10:25Z',
    text: 'How you feel after the low-owned player returns 😏',
    url: 'https://x.com/OfficialFPL/status/2090909411300507814',
  },
] as const;

describe('Grok Build X post adapter gates', () => {
  test('validates author, exact window, Snowflake time, URL, and saturation', () => {
    const result = adaptGrokBuildPosts({
      request,
      execution: execution(posts),
      checkedAt: new Date('2026-08-21T21:16:00.000Z'),
    });
    expect(result.stateHint).toBe('SATURATED');
    expect(result.acceptedCount).toBe(2);
    expect(result.rejections).toHaveLength(0);
    expect(result.batches[0]?.endpointKey).toBe('official-fpl-x');
    expect(result.batches[0]?.items[0]?.authorExternalId).toBe('761568335138058240');
    expect(result.batches[0]?.items[0]?.canonicalUrl).toBe(
      'https://x.com/OfficialFPL/status/2090909465801371803',
    );
  });

  test('derives a timestamp within five seconds of the attested createdAt', () => {
    expect(
      Math.abs(
        xSnowflakeTimestamp('2090909465801371803').getTime() - Date.parse('2026-08-21T21:10:38Z'),
      ),
    ).toBeLessThanOrEqual(5_000);
  });

  test('fails the run when every returned post is outside the persisted window', () => {
    try {
      adaptGrokBuildPosts({
        request,
        execution: execution([{ ...posts[0], createdAt: '2026-08-21T20:00:00Z' }]),
        checkedAt: new Date('2026-08-21T21:16:00.000Z'),
      });
      throw new Error('Expected all-rejected adapter failure');
    } catch (error) {
      expect(error).toBeInstanceOf(XPostQualityError);
      expect(error).toMatchObject({
        failureClass: 'X_ALL_POSTS_REJECTED',
        rejections: [
          {
            endpointKey: 'official-fpl-x',
            externalItemId: posts[0].postId,
            reasonCode: 'X_POST_OUTSIDE_WINDOW',
          },
        ],
      });
    }
  });

  test('does not resolve semantic authors for posts that fail deterministic post gates', () => {
    const valid = prevalidateGrokBuildPostsForAuthorResolution({
      request,
      execution: execution([
        posts[0],
        {
          ...posts[1],
          authorHandle: 'FakeAuthor',
          createdAt: '2026-08-21T20:00:00Z',
          url: `https://x.com/FakeAuthor/status/${posts[1].postId}`,
        },
      ]),
    });
    expect(valid.map((post) => post.authorHandle)).toEqual(['OfficialFPL']);
  });

  test('maps semantic results to resolved known and observed author endpoints', () => {
    const semanticRequest: XScanRunRequestV1 = {
      ...request,
      jobKind: 'X_SEMANTIC_SCAN',
      adapterKind: 'X_SEMANTIC',
      profileKey: 'x-semantic-availability-v1',
      partition: {
        ...request.partition,
        partitionKey: 'semantic-availability',
        members: [
          {
            ...request.partition.members[0]!,
            endpointKey: 'semantic-availability-x',
            adapterKind: 'X_SEMANTIC',
            profileKey: 'x-semantic-availability-v1',
            locator: { semanticProfileKey: 'availability-v1' },
            stableExternalId: 'availability-v1',
          },
        ],
      },
      toolRequest: {
        toolName: 'x_semantic_search',
        query: 'FPL player injury availability',
        fromDate: '2026-08-21',
        toDate: '2026-08-21',
        limit: 10,
      },
    };
    const result = adaptGrokBuildSemanticPosts({
      request: semanticRequest,
      execution: {
        ...execution([]),
        toolName: 'x_semantic_search',
        toolInput: {
          query: 'FPL player injury availability',
          from_date: '2026-08-21',
          to_date: '2026-08-21',
          limit: 10,
        },
        posts: [
          posts[0],
          {
            ...posts[1],
            authorHandle: 'FixtureScout',
            url: `https://x.com/FixtureScout/status/${posts[1].postId}`,
          },
        ],
      },
      checkedAt: new Date('2026-08-21T21:16:00.000Z'),
      authors: [
        {
          authorHandle: 'OfficialFPL',
          endpointKey: 'official-fpl-x',
          stableExternalId: '761568335138058240',
        },
        {
          authorHandle: 'FixtureScout',
          endpointKey: 'observed-fixture-scout-x',
          stableExternalId: null,
        },
      ],
    });
    expect(result.stateHint).toBe('COMPLETED');
    expect(result.batches.map((batch) => batch.endpointKey)).toEqual([
      'observed-fixture-scout-x',
      'official-fpl-x',
    ]);
    expect(
      result.batches.find((batch) => batch.endpointKey === 'observed-fixture-scout-x')?.items[0]
        ?.authorExternalId,
    ).toBeNull();
  });
});
