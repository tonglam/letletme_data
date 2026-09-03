import { describe, expect, test } from 'bun:test';

import {
  acquisitionJobV1Schema,
  parseFormalRunRequestV1,
} from '../../../src/content/acquisition/formal-run-contract';
import { resolveFormalAcquisitionPhase } from '../../../src/content/acquisition/formal-run-repository';
import {
  compileXKeywordRequest,
  compileXSemanticRequest,
} from '../../../src/content/acquisition/x-query-compiler';

describe('formal acquisition request contracts', () => {
  test('keeps the BullMQ payload to schema version and run ID', () => {
    expect(
      acquisitionJobV1Schema.parse({
        schemaVersion: 1,
        runId: '00000000-0000-4000-8000-000000000001',
      }),
    ).toEqual({ schemaVersion: 1, runId: '00000000-0000-4000-8000-000000000001' });
    expect(() =>
      acquisitionJobV1Schema.parse({
        schemaVersion: 1,
        runId: '00000000-0000-4000-8000-000000000001',
        query: 'runtime drift',
      }),
    ).toThrow();
  });

  test('compiles one author query for a whole partition without page topics', () => {
    const request = compileXKeywordRequest({
      handles: ['OfficialFPL', 'premierleague'],
      windowStart: new Date('2026-08-21T23:58:00.000Z'),
      windowEnd: new Date('2026-08-22T00:30:00.000Z'),
    });
    expect(request).toEqual({
      toolName: 'x_keyword_search',
      query:
        '(from:OfficialFPL OR from:premierleague) since:2026-08-21_23:58:00_UTC until:2026-08-22_00:30:00_UTC -is:retweet',
      mode: 'Latest',
      limit: 10,
    });
    expect(request.query).not.toMatch(/injury|week|news|views|features/i);
  });

  test('compiles only versioned semantic profiles with exact time bounds', () => {
    const request = compileXSemanticRequest({
      semanticProfileKey: 'availability-v1',
      windowStart: new Date('2026-08-21T12:00:00.000Z'),
      windowEnd: new Date('2026-08-21T13:00:00.000Z'),
    });
    expect(request.toolName).toBe('x_semantic_search');
    expect(request.fromDate).toBe('2026-08-21');
    expect(request.toDate).toBe('2026-08-21');
    expect(() =>
      compileXSemanticRequest({
        semanticProfileKey: 'runtime-free-text',
        windowStart: new Date('2026-08-21T12:00:00.000Z'),
        windowEnd: new Date('2026-08-21T13:00:00.000Z'),
      }),
    ).toThrow('Unknown semantic profile');
  });

  test('uses the next FPL deadline to resolve NORMAL, APPROACHING and FINAL90', () => {
    const now = new Date('2026-08-21T10:00:00.000Z');
    expect(resolveFormalAcquisitionPhase({ now, nextDeadline: null })).toBe('NORMAL');
    expect(
      resolveFormalAcquisitionPhase({
        now,
        nextDeadline: new Date('2026-08-22T08:00:00.000Z'),
      }),
    ).toBe('APPROACHING');
    expect(
      resolveFormalAcquisitionPhase({
        now,
        nextDeadline: new Date('2026-08-21T11:29:59.000Z'),
      }),
    ).toBe('FINAL90');
  });

  test('persists TikHub only for fixed-account scans and defaults old snapshots to Grok', () => {
    const baseRequest = {
      schemaVersion: 1,
      phase: 'NORMAL',
      profileKey: 'x-official-v2',
      profileRevision: 2,
      windowStart: '2026-08-30T06:00:00.000Z',
      windowEnd: '2026-08-30T18:00:00.000Z',
      jobKind: 'X_KEYWORD_SCAN',
      adapterKind: 'X_ACCOUNT',
      coverageMode: 'BACKSTOP',
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
            profileKey: 'x-official-v2',
            locator: { handle: 'OfficialFPL' },
            stableExternalId: '761568335138058240',
            identityRequirement: 'REQUIRED',
            rightsPolicy: {},
          },
        ],
      },
      toolRequest: compileXKeywordRequest({
        handles: ['OfficialFPL'],
        windowStart: new Date('2026-08-30T06:00:00.000Z'),
        windowEnd: new Date('2026-08-30T18:00:00.000Z'),
      }),
    } as const;
    expect(parseFormalRunRequestV1(baseRequest)).toMatchObject({
      providerRoute: 'GROK_BUILD',
    });
    expect(
      parseFormalRunRequestV1({ ...baseRequest, providerRoute: 'TIKHUB_TIMELINE' }),
    ).toMatchObject({ providerRoute: 'TIKHUB_TIMELINE' });
    expect(() =>
      parseFormalRunRequestV1({
        ...baseRequest,
        providerRoute: 'TIKHUB_TIMELINE',
        jobKind: 'X_SEMANTIC_SCAN',
        adapterKind: 'X_SEMANTIC',
        toolRequest: compileXSemanticRequest({
          semanticProfileKey: 'availability-v1',
          windowStart: new Date('2026-08-30T06:00:00.000Z'),
          windowEnd: new Date('2026-08-30T18:00:00.000Z'),
        }),
      }),
    ).toThrow('TikHub timeline is only valid for fixed-account keyword scans');
  });

  test('allows generated fallback to resume a video explicitly deferred after native attempts', () => {
    const request = {
      schemaVersion: 1,
      phase: 'NORMAL',
      profileKey: 'youtube-caption-first-v1',
      profileRevision: 1,
      windowStart: '2026-08-22T00:00:00.000Z',
      windowEnd: '2026-08-22T00:00:00.000Z',
      jobKind: 'YOUTUBE_TRANSCRIPT',
      adapterKind: 'SUPADATA_TRANSCRIPT',
      endpoint: {
        endpointId: '00000000-0000-4000-8000-000000000001',
        endpointKey: 'fpl-focal-youtube',
        sourceId: '00000000-0000-4000-8000-000000000002',
        sourceKey: 'fpl-focal',
        adapterKind: 'YOUTUBE_CHANNEL',
        profileKey: 'youtube-caption-first-v1',
        locator: { channelId: 'UC72QokPHXQ9r98ROfNZmaDw' },
        stableExternalId: 'UC72QokPHXQ9r98ROfNZmaDw',
        rightsPolicy: {},
      },
      discoveryItem: {
        endpointKey: 'fpl-focal-youtube',
        externalItemId: 'yA8S_bMekDU',
        canonicalUrl: 'https://www.youtube.com/watch?v=yA8S_bMekDU',
        sourceUrl: 'https://www.youtube.com/watch?v=yA8S_bMekDU',
        linkAvailability: 'DIRECT',
        publishedAt: '2026-08-21T20:00:00.000Z',
        updatedAt: null,
        title: 'Deferred video',
        authorExternalId: 'UC72QokPHXQ9r98ROfNZmaDw',
        contentKind: 'VIDEO',
        body: { availability: 'METADATA_ONLY', text: null },
        media: [
          {
            kind: 'VIDEO',
            url: 'https://www.youtube.com/watch?v=yA8S_bMekDU',
            mimeType: null,
            durationSeconds: 119,
          },
        ],
        transcript: {
          status: 'DEFERRED',
          language: null,
          trackKind: null,
          providerRevision: null,
          segments: [],
        },
        video: {
          lifecycleState: 'FINISHED',
          durationSeconds: 119,
          captionsAvailable: false,
          scheduledStartAt: null,
          actualStartAt: null,
          actualEndAt: null,
          providerRevision: 'youtube-data-api-v3',
        },
      },
      mode: 'AUTO',
      attemptStage: 'GENERATED',
      policy: {
        maximumDurationSeconds: 10_800,
        maximumContentAgeMinutes: 20_160,
        language: 'en',
      },
    } as const;
    expect(parseFormalRunRequestV1(request)).toMatchObject({
      attemptStage: 'GENERATED',
      discoveryItem: { transcript: { status: 'DEFERRED' } },
    });
    expect(() =>
      parseFormalRunRequestV1({ ...request, attemptStage: 'NATIVE_SECOND', mode: 'NATIVE' }),
    ).toThrow();
  });
});
