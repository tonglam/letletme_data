import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import type { XScanRunRequestV1 } from '../../../src/content/acquisition/formal-run-contract';
import {
  TikHubXTimelineClient,
  TikHubXTimelineError,
  type TikHubXTimelineFetch,
} from '../../../src/content/acquisition/tikhub-x-timeline-client';
import { sha256CanonicalJson } from '../../../src/content/acquisition/canonicalization';
import { adaptTikHubTimelinePosts } from '../../../src/content/acquisition/x-post-adapter';

const X_SNOWFLAKE_EPOCH_MS = 1_288_834_974_657n;

function snowflakeAt(iso: string, sequence = 0n): string {
  return ((BigInt(Date.parse(iso)) - X_SNOWFLAKE_EPOCH_MS) * 4_194_304n + sequence).toString();
}

const request: XScanRunRequestV1 = {
  schemaVersion: 1,
  jobKind: 'X_KEYWORD_SCAN',
  adapterKind: 'X_ACCOUNT',
  providerRoute: 'TIKHUB_TIMELINE',
  coverageMode: 'BACKSTOP',
  phase: 'NORMAL',
  profileKey: 'x-creator-v2',
  profileRevision: 2,
  windowStart: '2026-08-30T06:00:00.000Z',
  windowEnd: '2026-08-30T18:00:00.000Z',
  partition: {
    partitionId: '00000000-0000-4000-8000-000000000001',
    partitionKey: 'creators-test',
    members: [
      {
        endpointId: '00000000-0000-4000-8000-000000000002',
        endpointKey: 'fpl-focal-x',
        sourceId: '00000000-0000-4000-8000-000000000003',
        sourceKey: 'fpl-focal',
        adapterKind: 'X_ACCOUNT',
        profileKey: 'x-creator-v2',
        locator: { handle: 'FPLFocal' },
        stableExternalId: '123456789',
        identityRequirement: 'REQUIRED',
        rightsPolicy: {},
      },
      {
        endpointId: '00000000-0000-4000-8000-000000000004',
        endpointKey: 'fpl-raptor-x',
        sourceId: '00000000-0000-4000-8000-000000000005',
        sourceKey: 'fpl-raptor',
        adapterKind: 'X_ACCOUNT',
        profileKey: 'x-creator-v2',
        locator: { handle: 'FPL_Raptor' },
        stableExternalId: null,
        identityRequirement: 'HANDLE_ONLY',
        rightsPolicy: {},
      },
    ],
  },
  toolRequest: {
    toolName: 'x_keyword_search',
    query:
      '(from:FPLFocal OR from:FPL_Raptor) since:2026-08-30_06:00:00_UTC until:2026-08-30_18:00:00_UTC -is:retweet',
    mode: 'Latest',
    limit: 10,
  },
};

function post(input: {
  handle: string;
  restId: string;
  createdAt: string;
  text: string;
  sequence?: bigint;
  retweet?: boolean;
}) {
  return {
    tweet_id: snowflakeAt(input.createdAt, input.sequence),
    created_at: new Date(input.createdAt).toUTCString(),
    text: input.text,
    author: { screen_name: input.handle, rest_id: input.restId },
    retweeted_tweet: input.retweet ? { tweet_id: '1' } : null,
    entities: [],
    media: {},
  };
}

function response(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('TikHub fixed-account timeline client', () => {
  test('pages each member by stable identity, filters locally, and preserves durable evidence', async () => {
    const calls: URL[] = [];
    const fetchImpl: TikHubXTimelineFetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push(url);
      expect(init?.headers).toMatchObject({ authorization: 'Bearer fixture-secret' });
      expect(url.toString()).not.toContain('fixture-secret');
      if (url.searchParams.get('rest_id') === '123456789' && !url.searchParams.has('cursor')) {
        expect(url.searchParams.has('screen_name')).toBe(false);
        return response({
          code: 200,
          request_id: 'request-1',
          data: {
            user: { rest_id: '123456789', screen_name: 'FPLFocal' },
            next_cursor: 'cursor-1',
            timeline: [
              post({
                handle: 'FPLFocal',
                restId: '123456789',
                createdAt: '2026-08-30T17:30:00.000Z',
                text: 'Useful in-window post',
              }),
              post({
                handle: 'FPLFocal',
                restId: '123456789',
                createdAt: '2026-08-30T17:00:00.000Z',
                text: 'Wrapper retweet',
                sequence: 1n,
                retweet: true,
              }),
            ],
          },
        });
      }
      if (url.searchParams.get('cursor') === 'cursor-1') {
        return response({
          code: 200,
          request_id: 'request-2',
          data: {
            user: { rest_id: '123456789', screen_name: 'FPLFocal' },
            next_cursor: 'cursor-2',
            timeline: [
              post({
                handle: 'FPLFocal',
                restId: '123456789',
                createdAt: '2026-08-30T07:00:00.000Z',
                text: 'Second in-window post',
              }),
              post({
                handle: 'FPLFocal',
                restId: '123456789',
                createdAt: '2026-08-30T05:59:00.000Z',
                text: 'Older boundary post',
                sequence: 2n,
              }),
            ],
          },
        });
      }
      if (url.searchParams.get('cursor') === 'cursor-2') {
        return response({
          code: 200,
          request_id: 'request-3',
          data: {
            user: { rest_id: '123456789', screen_name: 'FPLFocal' },
            // An empty cursor is another terminal form observed from the
            // provider and must not fail schema validation.
            next_cursor: '',
            timeline: [
              post({
                handle: 'FPLFocal',
                restId: '123456789',
                createdAt: '2026-08-30T05:30:00.000Z',
                text: 'Fully outside the requested window',
                sequence: 3n,
              }),
            ],
          },
        });
      }
      expect(url.searchParams.get('screen_name')).toBe('FPL_Raptor');
      expect(url.searchParams.has('rest_id')).toBe(false);
      return response({
        code: 200,
        request_id: 'request-4',
        data: {
          user: { rest_id: '987654321', screen_name: 'FPL_Raptor' },
          next_cursor: null,
          timeline: [],
        },
      });
    };
    const beforeCalls: number[] = [];
    const startedCalls: number[] = [];
    const client = new TikHubXTimelineClient({
      apiKey: 'fixture-secret',
      timeoutMs: 5_000,
      maximumResponseBytes: 1_000_000,
      maximumPagesPerMember: 5,
      fetchImpl,
      endpointUrl: 'https://fixture.invalid/timeline',
    });
    const result = await client.execute(request, {
      beforeProviderCall: (index) => {
        beforeCalls.push(index);
      },
      onProviderCallStart: (index) => {
        startedCalls.push(index);
      },
    });

    expect(calls).toHaveLength(4);
    expect(beforeCalls).toEqual([0, 1, 2, 3]);
    expect(startedCalls).toEqual([0, 1, 2, 3]);
    expect(result.providerUnits).toBe(4);
    expect(result.posts.map((item) => item.text)).toEqual([
      'Useful in-window post',
      'Second in-window post',
    ]);
    expect(result.excludedRetweets).toBe(1);
    expect(result.excludedOutsideWindow).toBe(2);
    expect(result.saturated).toBe(false);
    expect(result.requestMetadataHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.responseMetadataHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.providerJobIdHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.estimatedCostUsd).toBeCloseTo(0.004, 6);

    const adapted = adaptTikHubTimelinePosts({
      request,
      execution: result,
      checkedAt: new Date('2026-08-30T18:01:00.000Z'),
    });
    expect(adapted.stateHint).toBe('COMPLETED');
    expect(adapted.acceptedCount).toBe(2);
    expect(adapted.batches).toHaveLength(1);
    expect(adapted.batches[0]?.endpointKey).toBe('fpl-focal-x');
  });

  test('marks a bounded page-cap result as saturated instead of EMPTY', async () => {
    const client = new TikHubXTimelineClient({
      apiKey: 'fixture-secret',
      timeoutMs: 5_000,
      maximumResponseBytes: 1_000_000,
      maximumPagesPerMember: 1,
      fetchImpl: async () =>
        response({
          code: 200,
          request_id: 'request-cap',
          data: {
            user: { rest_id: '123456789', screen_name: 'FPLFocal' },
            next_cursor: 'more',
            timeline: [
              post({
                handle: 'FPLFocal',
                restId: '123456789',
                createdAt: '2026-08-30T17:00:00.000Z',
                text: 'In-window wrapper retweet',
                retweet: true,
              }),
            ],
          },
        }),
      endpointUrl: 'https://fixture.invalid/timeline',
    });
    const singleMemberRequest = {
      ...request,
      partition: { ...request.partition, members: [request.partition.members[0]!] },
    };
    const result = await client.execute(singleMemberRequest);
    expect(result.saturated).toBe(true);
    expect(result.posts).toHaveLength(0);
    expect(
      adaptTikHubTimelinePosts({
        request: singleMemberRequest,
        execution: result,
        checkedAt: new Date('2026-08-30T18:01:00.000Z'),
      }).stateHint,
    ).toBe('SATURATED');
  });

  test('rejects conflicting facts for one post ID across provider pages', async () => {
    let call = 0;
    const conflictingPost = post({
      handle: 'FPLFocal',
      restId: '123456789',
      createdAt: '2026-08-30T17:00:00.000Z',
      text: 'First body',
    });
    const client = new TikHubXTimelineClient({
      apiKey: 'fixture-secret',
      timeoutMs: 5_000,
      maximumResponseBytes: 1_000_000,
      maximumPagesPerMember: 3,
      fetchImpl: async () => {
        call += 1;
        return response({
          code: 200,
          request_id: `request-conflict-${call}`,
          data: {
            user: { rest_id: '123456789', screen_name: 'FPLFocal' },
            next_cursor: call === 1 ? 'conflict-page-2' : null,
            timeline: [call === 1 ? conflictingPost : { ...conflictingPost, text: 'Changed body' }],
          },
        });
      },
      endpointUrl: 'https://fixture.invalid/timeline',
    });
    try {
      await client.execute({
        ...request,
        partition: { ...request.partition, members: [request.partition.members[0]!] },
      });
      throw new Error('Expected TikHub post conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(TikHubXTimelineError);
      expect(error).toMatchObject({
        failureClass: 'TIKHUB_POST_CONFLICT',
        evidence: { providerUnits: 2, httpStatus: 200 },
      });
    }
  });

  test('fails closed with bounded billable evidence and never exposes the API key', async () => {
    const client = new TikHubXTimelineClient({
      apiKey: 'top-secret-provider-key',
      timeoutMs: 5_000,
      maximumResponseBytes: 1_000_000,
      maximumPagesPerMember: 1,
      fetchImpl: async () => response({ code: 200, request_id: 'bad', data: null }),
      endpointUrl: 'https://fixture.invalid/timeline',
    });
    try {
      await client.execute({
        ...request,
        partition: { ...request.partition, members: [request.partition.members[0]!] },
      });
      throw new Error('Expected TikHub schema rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(TikHubXTimelineError);
      expect(error).toMatchObject({
        failureClass: 'TIKHUB_SCHEMA_INVALID',
        evidence: { providerUnits: 1, httpStatus: 200 },
      });
      expect(String(error)).not.toContain('top-secret-provider-key');
    }
  });

  test('resets stale HTTP status and retains partial member progress on a later page failure', async () => {
    const accepted = post({
      handle: 'FPLFocal',
      restId: '123456789',
      createdAt: '2026-08-30T17:00:00.000Z',
      text: 'Accepted post',
    });
    let calls = 0;
    const client = new TikHubXTimelineClient({
      apiKey: 'fixture-secret',
      timeoutMs: 5_000,
      maximumResponseBytes: 1_000_000,
      maximumPagesPerMember: 2,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return response({
            code: 200,
            request_id: 'progress-page-1',
            data: {
              user: { rest_id: '123456789', screen_name: 'FPLFocal' },
              next_cursor: 'progress-page-2',
              timeline: [
                accepted,
                accepted,
                post({
                  handle: 'FPLFocal',
                  restId: '123456789',
                  createdAt: '2026-08-30T16:00:00.000Z',
                  text: 'Retweet wrapper',
                  sequence: 1n,
                  retweet: true,
                }),
                post({
                  handle: 'FPLFocal',
                  restId: '123456789',
                  createdAt: '2026-08-30T05:59:00.000Z',
                  text: 'Outside window',
                  sequence: 2n,
                }),
              ],
            },
          });
        }
        throw new Error('fixture transport failure on page two');
      },
      endpointUrl: 'https://fixture.invalid/timeline',
    });

    try {
      await client.execute({
        ...request,
        partition: { ...request.partition, members: [request.partition.members[0]!] },
      });
      throw new Error('Expected TikHub transport failure');
    } catch (error) {
      expect(error).toBeInstanceOf(TikHubXTimelineError);
      expect(error).toMatchObject({
        failureClass: 'TIKHUB_TRANSPORT_FAILED',
        evidence: {
          providerUnits: 2,
          httpStatus: null,
          rawReturnedCount: 4,
          excludedRetweets: 1,
          excludedOutsideWindow: 1,
          duplicatePosts: 1,
          memberMetrics: [
            {
              endpointKey: 'fpl-focal-x',
              pages: 1,
              rawPosts: 4,
              acceptedPosts: 1,
              excludedRetweets: 1,
              excludedOutsideWindow: 1,
              duplicatePosts: 1,
              boundaryComplete: false,
              pageCapReached: false,
            },
          ],
        },
      });
    }
  });

  test('rejects a wrong top-level user even when a handle timeline is empty', async () => {
    const client = new TikHubXTimelineClient({
      apiKey: 'fixture-secret',
      timeoutMs: 5_000,
      maximumResponseBytes: 1_000_000,
      maximumPagesPerMember: 1,
      fetchImpl: async () =>
        response({
          code: 200,
          request_id: 'wrong-handle-user',
          data: {
            user: { rest_id: '987654321', screen_name: 'DifferentAccount' },
            next_cursor: null,
            timeline: [],
          },
        }),
      endpointUrl: 'https://fixture.invalid/timeline',
    });

    try {
      await client.execute({
        ...request,
        partition: { ...request.partition, members: [request.partition.members[1]!] },
      });
      throw new Error('Expected TikHub handle identity rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(TikHubXTimelineError);
      expect(error).toMatchObject({
        failureClass: 'TIKHUB_IDENTITY_MISMATCH',
        evidence: { providerUnits: 1 },
      });
    }
  });

  test('binds handle-only posts to the page-level stable user ID', async () => {
    const client = new TikHubXTimelineClient({
      apiKey: 'fixture-secret',
      timeoutMs: 5_000,
      maximumResponseBytes: 1_000_000,
      maximumPagesPerMember: 1,
      fetchImpl: async () =>
        response({
          code: 200,
          request_id: 'wrong-post-user-id',
          data: {
            user: { rest_id: '987654321', screen_name: 'FPL_Raptor' },
            next_cursor: null,
            timeline: [
              post({
                handle: 'FPL_Raptor',
                restId: '111111111',
                createdAt: '2026-08-30T17:00:00.000Z',
                text: 'Post from the wrong stable user',
              }),
            ],
          },
        }),
      endpointUrl: 'https://fixture.invalid/timeline',
    });

    try {
      await client.execute({
        ...request,
        partition: { ...request.partition, members: [request.partition.members[1]!] },
      });
      throw new Error('Expected TikHub post identity rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(TikHubXTimelineError);
      expect(error).toMatchObject({
        failureClass: 'TIKHUB_AUTHOR_MISMATCH',
        evidence: { providerUnits: 1 },
      });
    }
  });

  test('retains the provider request ID when a validated envelope is rejected', async () => {
    const requestId = 'provider-rejected-request';
    const client = new TikHubXTimelineClient({
      apiKey: 'fixture-secret',
      timeoutMs: 5_000,
      maximumResponseBytes: 1_000_000,
      maximumPagesPerMember: 1,
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: 429, request_id: requestId, data: null }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
      endpointUrl: 'https://fixture.invalid/timeline',
    });

    try {
      await client.execute({
        ...request,
        partition: { ...request.partition, members: [request.partition.members[0]!] },
      });
      throw new Error('Expected TikHub provider rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(TikHubXTimelineError);
      expect(error).toMatchObject({
        failureClass: 'TIKHUB_RATE_LIMITED',
        evidence: {
          providerUnits: 1,
          providerJobIdHash: sha256CanonicalJson([
            createHash('sha256').update(requestId, 'utf8').digest('hex'),
          ]),
        },
      });
    }
  });

  test('keeps the per-call timeout active while the response body stalls', async () => {
    const partialBody = new TextEncoder().encode('{"code":200,');
    const hangingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(partialBody);
      },
      pull: () => new Promise<void>(() => undefined),
    });
    const client = new TikHubXTimelineClient({
      apiKey: 'fixture-secret',
      timeoutMs: 1_000,
      maximumResponseBytes: 1_000_000,
      maximumPagesPerMember: 1,
      fetchImpl: async () =>
        new Response(hangingBody, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      endpointUrl: 'https://fixture.invalid/timeline',
    });

    const startedAt = Date.now();
    try {
      await client.execute({
        ...request,
        partition: { ...request.partition, members: [request.partition.members[0]!] },
      });
      throw new Error('Expected TikHub body timeout');
    } catch (error) {
      expect(error).toBeInstanceOf(TikHubXTimelineError);
      expect(error).toMatchObject({
        failureClass: 'TIKHUB_TIMEOUT',
        evidence: { providerUnits: 1, responseBytes: partialBody.byteLength },
      });
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    }
  });

  test('caps later pages by the supplied persisted-lease deadline', async () => {
    let call = 0;
    const hangingBody = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    });
    const client = new TikHubXTimelineClient({
      apiKey: 'fixture-secret',
      timeoutMs: 5_000,
      maximumResponseBytes: 1_000_000,
      maximumPagesPerMember: 3,
      fetchImpl: async () => {
        call += 1;
        if (call === 1) {
          return response({
            code: 200,
            request_id: 'request-before-run-deadline',
            data: {
              user: { rest_id: '123456789', screen_name: 'FPLFocal' },
              next_cursor: 'next-page',
              timeline: [
                post({
                  handle: 'FPLFocal',
                  restId: '123456789',
                  createdAt: '2026-08-30T17:00:00.000Z',
                  text: 'First page before the deadline',
                }),
              ],
            },
          });
        }
        return new Response(hangingBody, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      endpointUrl: 'https://fixture.invalid/timeline',
    });

    const startedAt = Date.now();
    try {
      await client.execute(
        {
          ...request,
          partition: { ...request.partition, members: [request.partition.members[0]!] },
        },
        {
          runDeadlineAtMs: startedAt + 1_200,
        },
      );
      throw new Error('Expected TikHub run timeout');
    } catch (error) {
      expect(error).toBeInstanceOf(TikHubXTimelineError);
      expect(error).toMatchObject({
        failureClass: 'TIKHUB_RUN_TIMEOUT',
        evidence: { providerUnits: 2 },
      });
      expect(Date.now() - startedAt).toBeLessThan(2_500);
    }
  });

  test('releases pagination admission when budget work consumes the run deadline', async () => {
    let fetchCalls = 0;
    let releasedAdmissions = 0;
    const startedCalls: number[] = [];
    const client = new TikHubXTimelineClient({
      apiKey: 'fixture-secret',
      timeoutMs: 5_000,
      maximumResponseBytes: 1_000_000,
      maximumPagesPerMember: 2,
      fetchImpl: async () => {
        fetchCalls += 1;
        return response({
          code: 200,
          request_id: 'first-page-before-deadline',
          data: {
            user: { rest_id: '123456789', screen_name: 'FPLFocal' },
            next_cursor: 'page-2',
            timeline: [],
          },
        });
      },
      endpointUrl: 'https://fixture.invalid/timeline',
    });

    try {
      await client.execute(
        {
          ...request,
          partition: { ...request.partition, members: [request.partition.members[0]!] },
        },
        {
          runDeadlineAtMs: Date.now() + 200,
          beforeProviderCall: async (index) => {
            if (index === 0) return;
            await new Promise((resolve) => setTimeout(resolve, 250));
            return {
              releaseIfUnused: () => {
                releasedAdmissions += 1;
              },
            };
          },
          onProviderCallStart: (index) => {
            startedCalls.push(index);
          },
        },
      );
      throw new Error('Expected TikHub run timeout before provider dispatch');
    } catch (error) {
      expect(error).toBeInstanceOf(TikHubXTimelineError);
      expect(error).toMatchObject({
        failureClass: 'TIKHUB_RUN_TIMEOUT',
        evidence: { providerUnits: 1 },
      });
    }

    expect(fetchCalls).toBe(1);
    expect(startedCalls).toEqual([0]);
    expect(releasedAdmissions).toBe(1);
  });
});
