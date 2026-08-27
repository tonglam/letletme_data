import { describe, expect, test } from 'bun:test';

import {
  computePollWindow,
  isPollDue,
  pollBudget,
  resolvePollPhase,
} from '../../../src/content/poll-policy';
import { isAcquisitionRunStale } from '../../../src/content/acquisition/run-lifecycle';
import {
  assertContentRuntimeFlags,
  parseContentApiKeyHashes,
  type ContentRuntimeFlags,
} from '../../../src/content/config';

const now = new Date('2026-08-20T10:00:00.000Z');

describe('content worker poll policy', () => {
  test('rejects Grok concurrency above the host runner limit', () => {
    const flags: ContentRuntimeFlags = {
      pipelineEnabled: true,
      acquisitionShadowMode: true,
      xScanEnabled: false,
      xBackstopEnabled: false,
      httpAcquisitionEnabled: false,
      podcastTranscriptEnabled: false,
      youtubeDiscoveryEnabled: false,
      youtubeNativeEnabled: false,
      youtubeGeneratedEnabled: false,
      realGrokEnabled: false,
      publicationEnabled: false,
      briefingPublicEnabled: false,
      grokConcurrency: 3,
      grokRunnerSocket: '/run/letletme-grok-runner/runner.sock',
      grokRunnerReleaseSha: null,
      httpConcurrency: 4,
      httpHostConcurrency: 2,
      hermesTranscriptConcurrency: 1,
      hermesTranscriptUrl: null,
      hermesTranscriptTokenPresent: false,
      hermesTranscriptTimeoutMs: 7_200_000,
      hermesTranscriptMaxOutputBytes: 16_777_216,
      supadataTimeoutMs: 75_000,
      supadataMaxOutputBytes: 16_777_216,
      supadataJobPollIntervalMs: 5_000,
      grokTimeoutMs: 240_000,
      grokMaxOutputBytes: 4_194_304,
      grokExpectedVersion: '1.0.5',
      httpTimeoutMs: 40_000,
      httpMaxOutputBytes: 8_388_608,
      dailyXCallLimit: 2_400,
      final90XCallLimit: 300,
      identityXCallLimit: 100,
      xLaneCapMultiplier: 1,
      supadataDailyCreditLimit: 0,
      hermesDailyAudioMinutes: 0,
      supadataApiKeyPresent: false,
      youtubeDataApiKeyPresent: false,
      revalidationUrl: null,
      revalidationSecret: null,
      editorApiKeyHashes: [],
      publisherApiKeyHashes: [],
    };
    expect(() => assertContentRuntimeFlags(flags)).toThrow('above 2');
    expect(() =>
      assertContentRuntimeFlags({
        ...flags,
        grokConcurrency: 2,
        grokTimeoutMs: 240_001,
      }),
    ).toThrow('CONTENT_GROK_TIMEOUT_MS must be a safe integer between 1000 and 240000');
    expect(() =>
      assertContentRuntimeFlags({
        ...flags,
        grokConcurrency: 2,
        grokTimeoutMs: Number.NaN,
      }),
    ).toThrow('CONTENT_GROK_TIMEOUT_MS must be a safe integer');
    expect(() =>
      assertContentRuntimeFlags({
        ...flags,
        httpAcquisitionEnabled: true,
        youtubeDiscoveryEnabled: true,
        youtubeNativeEnabled: true,
        youtubeDataApiKeyPresent: true,
        supadataApiKeyPresent: true,
        supadataDailyCreditLimit: Number.NaN,
      }),
    ).toThrow('CONTENT_SUPADATA_DAILY_CREDIT_LIMIT must be a non-negative safe integer');
    expect(() =>
      assertContentRuntimeFlags({
        ...flags,
        httpAcquisitionEnabled: true,
        podcastTranscriptEnabled: true,
        hermesTranscriptUrl: 'https://hermes.invalid/transcribe',
        hermesTranscriptTokenPresent: true,
        hermesDailyAudioMinutes: 1.5,
      }),
    ).toThrow('CONTENT_HERMES_DAILY_AUDIO_MINUTES must be a non-negative safe integer');
    expect(() =>
      assertContentRuntimeFlags({
        ...flags,
        httpAcquisitionEnabled: true,
        podcastTranscriptEnabled: true,
        hermesTranscriptUrl: 'file:///tmp/hermes',
        hermesTranscriptTokenPresent: true,
        hermesDailyAudioMinutes: 1,
      }),
    ).toThrow('HERMES_TRANSCRIPT_URL must be an HTTP(S) URL without credentials');
    expect(() =>
      assertContentRuntimeFlags({
        ...flags,
        grokConcurrency: 2,
        publicationEnabled: true,
      }),
    ).toThrow('BRIEFING_REVALIDATE_URL');
    expect(() =>
      assertContentRuntimeFlags({
        ...flags,
        grokConcurrency: 2,
        publicationEnabled: true,
        revalidationUrl: 'https://web.example.test/api/revalidate',
        revalidationSecret: 's'.repeat(32),
      }),
    ).toThrow('CONTENT_PUBLISHER_API_KEY_HASHES');
    expect(() =>
      assertContentRuntimeFlags({
        ...flags,
        grokConcurrency: 2,
        publicationEnabled: true,
        revalidationUrl: 'https://web.example.test/api/revalidate',
        revalidationSecret: 's'.repeat(32),
        publisherApiKeyHashes: ['a'.repeat(64)],
      }),
    ).not.toThrow();
  });

  test('rejects malformed content role key hashes instead of dropping them', () => {
    expect(parseContentApiKeyHashes(undefined, 'CONTENT_EDITOR_API_KEY_HASHES')).toEqual([]);
    expect(
      parseContentApiKeyHashes(
        `${'a'.repeat(64)},${'A'.repeat(64)}`,
        'CONTENT_EDITOR_API_KEY_HASHES',
      ),
    ).toEqual(['a'.repeat(64)]);
    expect(() => parseContentApiKeyHashes('not-a-digest', 'CONTENT_EDITOR_API_KEY_HASHES')).toThrow(
      'CONTENT_EDITOR_API_KEY_HASHES',
    );
  });

  test('keeps FINAL_90 disabled unless a future duty window and budget are recorded', () => {
    const deadlineAt = '2026-08-20T11:00:00.000Z';
    const base = { deadlineAt, final90Enabled: true, final90Budget: 2 };
    expect(resolvePollPhase(base, now)).toBe('APPROACHING');
    expect(resolvePollPhase({ ...base, editorOnDutyUntil: '2026-08-20T10:30:00.000Z' }, now)).toBe(
      'FINAL_90',
    );
    expect(
      resolvePollPhase(
        { ...base, final90Budget: 1, editorOnDutyUntil: '2026-08-20T10:30:00.000Z' },
        now,
      ),
    ).toBe('FINAL_90');
  });

  test('uses safety lag, overlap and a bounded catch-up window', () => {
    const window = computePollWindow({
      policy: { safetyLagMinutes: 2, overlapMinutes: 5, maxCatchupMinutes: 60 },
      phase: 'NORMAL',
      now,
      checkpointEnd: new Date('2026-08-20T06:00:00.000Z'),
    });
    expect(window.windowEnd.toISOString()).toBe('2026-08-20T09:58:00.000Z');
    expect(window.windowStart.toISOString()).toBe('2026-08-20T08:58:00.000Z');
  });

  test('does not enqueue again before the phase-specific cadence elapses', () => {
    const checkpointEnd = new Date('2026-08-20T09:45:00.000Z');
    const policy = { normalMinutes: 30, approachingMinutes: 10, safetyLagMinutes: 2 };
    expect(isPollDue({ policy, phase: 'NORMAL', now, checkpointEnd })).toBe(false);
    expect(
      isPollDue({
        policy,
        phase: 'NORMAL',
        now: new Date('2026-08-20T10:17:00.000Z'),
        checkpointEnd,
      }),
    ).toBe(true);
    expect(isPollDue({ policy, phase: 'APPROACHING', now, checkpointEnd })).toBe(true);
  });

  test('returns a phase budget only for an enabled FINAL_90 policy', () => {
    expect(pollBudget({ final90Budget: 3 }, 'NORMAL')).toBeNull();
    expect(pollBudget({ final90Budget: 3 }, 'FINAL_90')).toBe(3);
    expect(pollBudget({ final90Budget: 0 }, 'FINAL_90')).toBeNull();
    expect(pollBudget({ final90Budget: 1 }, 'FINAL_90')).toBe(1);
  });

  test('reclaims only acquisition runs whose lease anchor is stale', () => {
    const now = new Date('2026-08-20T10:00:00.000Z');
    expect(
      isAcquisitionRunStale({
        startedAt: new Date('2026-08-20T09:55:00.001Z'),
        createdAt: now,
        now,
      }),
    ).toBe(false);
    expect(
      isAcquisitionRunStale({
        startedAt: new Date('2026-08-20T09:55:00.000Z'),
        createdAt: now,
        now,
      }),
    ).toBe(true);
    expect(
      isAcquisitionRunStale({
        startedAt: null,
        createdAt: new Date('2026-08-20T09:55:00.001Z'),
        now,
      }),
    ).toBe(false);
  });
});
