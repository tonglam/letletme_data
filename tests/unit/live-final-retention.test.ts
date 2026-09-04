import { describe, expect, test } from 'bun:test';

import {
  LIVE_POINTS_CONTRACT_VERSION,
  type Exactly15Picks,
  type EntryLiveInputV2,
} from '../../src/cache/live-publication-v2';
import type { DbEntryEventResult } from '../../src/db/schemas/platform.types';
import { buildFinalEntryLiveInputFromBaseAndResult } from '../../src/services/entries.service';
import { requiredLiveLeagueFinalCheckpointScopesV2 } from '../../src/services/live-league-checkpoint-v2.service';
import {
  LiveFinalRetentionIncompleteError,
  finalPublicationConflict,
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
  test('allows an exact same-identity provisional pointer to be promoted to FINAL', () => {
    const scope = { season: '2627', eventId: 2, entryId: 777 } as const;
    const raw = JSON.stringify({
      contractVersion: LIVE_POINTS_CONTRACT_VERSION,
      season: scope.season,
      eventId: scope.eventId,
      entryId: scope.entryId,
      publicationId: '00000000-0000-4000-8000-000000000777',
      generation: 5,
      state: 'PROVISIONAL',
    });

    expect(
      finalPublicationConflict(
        raw,
        { publicationId: '00000000-0000-4000-8000-000000000777', generation: 5 },
        scope,
        {
          contractVersion: LIVE_POINTS_CONTRACT_VERSION,
          state: 'FINAL',
          allowProvisionalSameIdentity: true,
        },
      ),
    ).toBe(false);
    expect(
      finalPublicationConflict(
        raw,
        {
          publicationId: '00000000-0000-4000-8000-000000000777',
          generation: 5,
        },
        scope,
        {
          contractVersion: LIVE_POINTS_CONTRACT_VERSION,
          state: 'FINAL',
        },
      ),
    ).toBe(true);
  });

  test('still fences a different identity while keeping an exact FINAL pointer idempotent', () => {
    const scope = { season: '2627', eventId: 2, entryId: 777 } as const;
    const base = {
      contractVersion: LIVE_POINTS_CONTRACT_VERSION,
      season: scope.season,
      eventId: scope.eventId,
      entryId: scope.entryId,
      generation: 5,
      state: 'PROVISIONAL',
    };
    const marker = {
      contractVersion: LIVE_POINTS_CONTRACT_VERSION,
      state: 'FINAL',
      allowProvisionalSameIdentity: true,
    } as const;

    expect(
      finalPublicationConflict(
        JSON.stringify({ ...base, publicationId: '00000000-0000-4000-8000-000000000777' }),
        { publicationId: '00000000-0000-4000-8000-000000000778', generation: 5 },
        scope,
        marker,
      ),
    ).toBe(true);
    expect(
      finalPublicationConflict(
        JSON.stringify({
          ...base,
          publicationId: '00000000-0000-4000-8000-000000000777',
          state: 'FINAL',
        }),
        { publicationId: '00000000-0000-4000-8000-000000000777', generation: 5 },
        scope,
        marker,
      ),
    ).toBe(false);
    expect(
      finalPublicationConflict(
        JSON.stringify({
          ...base,
          publicationId: '00000000-0000-4000-8000-000000000778',
          state: 'FINAL',
        }),
        { publicationId: '00000000-0000-4000-8000-000000000777', generation: 5 },
        scope,
        marker,
      ),
    ).toBe(true);
  });

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

describe('Live final retention league scope completeness', () => {
  test('requires missing active Classic and in-phase official H2H checkpoints', () => {
    const tournament = {
      rosterMode: 'snapshot',
      groupMode: 'no_group',
      groupStartedEventId: null,
      groupEndedEventId: null,
      knockoutStartedEventId: null,
      knockoutEndedEventId: null,
    } as const;

    expect(
      requiredLiveLeagueFinalCheckpointScopesV2('2627', 2, [
        { ...tournament, tournamentId: 3, leagueType: 'classic' },
        {
          ...tournament,
          tournamentId: 6,
          leagueType: 'h2h',
          rosterMode: 'official_sync',
          groupMode: 'battle_races',
          groupStartedEventId: 1,
          groupEndedEventId: 5,
        },
        {
          ...tournament,
          tournamentId: 7,
          leagueType: 'h2h',
          rosterMode: 'official_sync',
          groupMode: 'battle_races',
          groupStartedEventId: 3,
          groupEndedEventId: 5,
        },
      ]),
    ).toEqual([
      { season: '2627', eventId: 2, tournamentId: 3, scope: 'CLASSIC' },
      { season: '2627', eventId: 2, tournamentId: 6, scope: 'H2H_HEAD' },
      { season: '2627', eventId: 2, tournamentId: 6, scope: 'H2H_STANDINGS' },
    ]);
  });
});
