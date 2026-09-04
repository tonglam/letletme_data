import { describe, expect, test } from 'bun:test';

import {
  LIVE_POINTS_CONTRACT_VERSION,
  type Exactly15Picks,
  type EntryLiveInputV2,
} from '../../src/cache/live-publication-v2';
import type { DbEntryEventResult } from '../../src/db/schemas/platform.types';
import { buildFinalEntryLiveInputFromBaseAndResult } from '../../src/services/entries.service';
import {
  LiveFinalRetentionIncompleteError,
  liveFinalRetentionCompletionEvidence,
  type LiveFinalRetentionResult,
} from '../../src/services/live-final-retention.service';
import { contentHash } from '../../src/utils/content-hash';

const picks = Array.from({ length: 15 }, (_, index) => ({
  element: 100 + index,
  position: index + 1,
  multiplier: index === 0 ? 2 : 1,
  isCaptain: index === 0,
  isViceCaptain: index === 1,
})) as unknown as Exactly15Picks;

function provisionalInput(): EntryLiveInputV2 {
  return {
    contractVersion: LIVE_POINTS_CONTRACT_VERSION,
    season: '2627',
    eventId: 2,
    entryId: 777,
    picksBase: {
      revision: contentHash({
        picks,
        chip: null,
        reportedEventPoints: 55,
        assistantManagerPoints: null,
        transferCount: 1,
        transferCost: 4,
      }),
      contentUpdatedAt: '2026-09-04T08:00:00.000Z',
      picks,
      chip: null,
      reportedEventPoints: 55,
      transferCount: 1,
      transferCost: 4,
    },
    previousTotals: null,
    officialAdjustment: null,
    finalResult: null,
  };
}

function finalizedResult(overrides: Record<string, unknown> = {}): DbEntryEventResult {
  return {
    entryId: 777,
    eventId: 2,
    eventPoints: 70,
    overallPoints: 125,
    richSyncedAt: new Date('2026-09-04T08:05:00.000Z'),
    eventPicks: picks.map((pick) => ({
      element: pick.element,
      position: pick.position,
      multiplier: pick.multiplier,
      is_captain: pick.isCaptain,
      is_vice_captain: pick.isViceCaptain,
    })),
    eventAutoSub: [],
    ...overrides,
  } as unknown as DbEntryEventResult;
}

function retentionResult(
  overrides: Partial<LiveFinalRetentionResult> = {},
): LiveFinalRetentionResult {
  const family = {
    checked: 10,
    renewed: 4,
    restored: 5,
    failed: 1,
    minRemainingTtlMs: 86_400_001,
  };
  return {
    schemaVersion: 'live-final-retention-v1',
    eventId: 2,
    checkedAt: '2026-09-04T08:10:00.000Z',
    status: 'failed',
    complete: false,
    requiredArtifacts: 50,
    failed: 1,
    minRemainingTtlMs: 86_400_001,
    families: {
      global: family,
      matchDesk: family,
      matchDetail: family,
      entry: family,
      league: family,
    },
    ...overrides,
  };
}

describe('final entry retention recovery', () => {
  test('builds FINAL input only from the exact provisional base and durable result', () => {
    const input = buildFinalEntryLiveInputFromBaseAndResult(
      provisionalInput(),
      finalizedResult(),
      new Date('2026-09-04T08:00:00.000Z'),
    );

    expect(input).not.toBeNull();
    expect(input?.picksBase.picks).toEqual(picks);
    expect(input?.finalResult?.score).toEqual({ eventPoints: 70, totalPoints: 125 });
    expect(input?.finalResult?.picks).toEqual(picks);
    expect(input?.finalResult?.automaticSubs).toEqual([]);
    expect(input?.officialAdjustment?.multipliers).toEqual(
      picks.map((pick) => ({ element: pick.element, multiplier: pick.multiplier })),
    );
  });

  test('rejects missing, stale, or incomplete durable result data without guessing', () => {
    const base = provisionalInput();
    expect(
      buildFinalEntryLiveInputFromBaseAndResult(
        base,
        finalizedResult({ eventPicks: [] }),
        new Date('2026-09-04T08:00:00.000Z'),
      ),
    ).toBeNull();
    expect(
      buildFinalEntryLiveInputFromBaseAndResult(
        base,
        finalizedResult({ richSyncedAt: null }),
        new Date('2026-09-04T08:00:00.000Z'),
      ),
    ).toBeNull();
    expect(
      buildFinalEntryLiveInputFromBaseAndResult(
        base,
        finalizedResult({ richSyncedAt: new Date('2026-09-04T07:59:59.999Z') }),
        new Date('2026-09-04T08:00:00.000Z'),
      ),
    ).toBeNull();
  });
});

describe('Live final retention failure evidence', () => {
  test('keeps bounded family evidence on failed results without payloads', () => {
    const result = retentionResult();
    const evidence = liveFinalRetentionCompletionEvidence(result);
    expect(evidence).toEqual(result);
    expect(evidence).not.toHaveProperty('payload');
    expect(new LiveFinalRetentionIncompleteError(result).evidence).toEqual(evidence);
  });
});
