import { describe, expect, test } from 'bun:test';
import { contentHash } from '../../src/utils/content-hash';
import { parseCorrectionArgs } from '../../scripts/correct-deleted-entry-final';
import { entryLiveInputFromFplPicks } from '../../src/cache/live-publication-v2';
import type { DbEntryEventResult } from '../../src/db/schemas/platform.types';
import { buildDeletedEntryFinalCorrection } from '../../src/services/entry-final-correction.service';
import { buildFinalEntryLiveInputFromBaseAndResult } from '../../src/services/entries.service';

function fixture() {
  const boundary = new Date('2026-09-01T00:00:00Z');
  const picks = {
    active_chip: null,
    automatic_subs: [],
    picks: Array.from({ length: 15 }, (_, i) => ({
      element: i + 1,
      position: i + 1,
      multiplier: i === 0 ? 2 : i < 11 ? 1 : 0,
      is_captain: i === 0,
      is_vice_captain: i === 1,
    })),
    entry_history: {
      event: 2,
      points: 56,
      total_points: 0,
      rank: null,
      overall_rank: 0,
      bank: 0,
      value: 1000,
      event_transfers: 0,
      event_transfers_cost: 0,
      points_on_bench: 0,
    },
  };
  const result = {
    entryId: 777,
    eventId: 2,
    eventPoints: 56,
    overallPoints: 0,
    eventRank: 0,
    overallRank: 0,
    eventTransfersCost: 0,
    eventTransfers: 0,
    eventChip: null,
    richSyncedAt: new Date('2026-09-01T00:01:00Z'),
    eventPicks: picks.picks,
    eventAutoSub: [],
    automaticSubstitutions: [],
  } as unknown as DbEntryEventResult;
  const base = entryLiveInputFromFplPicks(
    { seasonId: 2026, seasonCode: '2627' },
    2,
    777,
    picks,
    boundary,
  );
  const original = buildFinalEntryLiveInputFromBaseAndResult(
    base,
    { ...result, overallPoints: 56 },
    boundary,
  )!;
  return {
    original,
    result,
    picks,
    history: { ...picks.entry_history },
    identity: { entryName: 'Deleted', playerName: 'Deleted Player', overallRank: 0 },
    dataCheckedAt: boundary,
  };
}

describe('explicit deleted-entry FINAL correction', () => {
  test('changes only the proven cumulative total and preserves frozen source evidence', () => {
    const input = fixture();
    const corrected = buildDeletedEntryFinalCorrection(input);
    expect(corrected.finalResult?.score).toEqual({ eventPoints: 56, totalPoints: 0 });
    expect(corrected.finalResult?.picks).toEqual(input.original.finalResult!.picks);
    expect(corrected.picksBase).toEqual(input.original.picksBase);
    expect(corrected.previousTotals).toEqual(input.original.previousTotals);
    expect(input.original.finalResult!.score.totalPoints).toBe(56);
  });
  test('rejects live accounts, divergent provider totals, changed picks and wrong fallback totals', () => {
    const a = fixture();
    a.identity.entryName = 'Active';
    expect(() => buildDeletedEntryFinalCorrection(a)).toThrow();
    const b = fixture();
    b.history.total_points = 56;
    expect(() => buildDeletedEntryFinalCorrection(b)).toThrow();
    const c = fixture();
    c.picks.picks[0]!.multiplier = 1;
    expect(() => buildDeletedEntryFinalCorrection(c)).toThrow();
    const d = fixture();
    d.original = {
      ...d.original,
      finalResult: {
        ...d.original.finalResult!,
        score: { ...d.original.finalResult!.score, totalPoints: 57 },
      },
    };
    expect(() => buildDeletedEntryFinalCorrection(d)).toThrow();
    const e = fixture();
    e.result = { ...e.result, richSyncedAt: new Date('2026-08-31T00:00:00Z') };
    expect(() => buildDeletedEntryFinalCorrection(e)).toThrow();
  });
  test('preserves canonical microseconds in the FINAL and adjustment revisions', () => {
    const input = fixture();
    const boundary = '2026-09-01T00:00:00.001234Z';
    const original = buildFinalEntryLiveInputFromBaseAndResult(
      { ...input.original, finalResult: null },
      { ...input.result, overallPoints: 56 },
      boundary,
    )!;
    const corrected = buildDeletedEntryFinalCorrection({
      ...input,
      original,
      dataCheckedAt: boundary,
    });
    expect(corrected.officialAdjustment).toEqual(original.officialAdjustment);
    expect(corrected.finalResult!.revision).toBe(
      contentHash({
        dataCheckedAt: boundary,
        score: { eventPoints: 56, totalPoints: 0 },
        picks: corrected.finalResult!.picks,
        automaticSubs: [],
      }),
    );
  });
  test('rejects a durable chip conflict even when frozen and provider chips agree', () => {
    const input = fixture();
    expect(() =>
      buildDeletedEntryFinalCorrection({
        ...input,
        result: { ...input.result, eventChip: 'freehit' },
      }),
    ).toThrow('chip');
  });
  test('rejects transfer metadata and adjustment changes outside the zero-total correction', () => {
    const input = fixture();
    expect(() =>
      buildDeletedEntryFinalCorrection({
        ...input,
        result: { ...input.result, eventTransfers: 1 },
        picks: {
          ...input.picks,
          entry_history: { ...input.picks.entry_history, event_transfers: 1 },
        },
        history: { ...input.history, event_transfers: 1 },
      }),
    ).toThrow();
    expect(() =>
      buildDeletedEntryFinalCorrection({
        ...input,
        result: { ...input.result, eventTransfersCost: 4 },
        picks: {
          ...input.picks,
          entry_history: { ...input.picks.entry_history, event_transfers_cost: 4 },
        },
        history: { ...input.history, event_transfers_cost: 4 },
      }),
    ).toThrow();
    const changed = {
      ...input.original,
      officialAdjustment: {
        ...input.original.officialAdjustment!,
        multipliers: input.original.officialAdjustment!.multipliers.map((m, i) => ({
          ...m,
          multiplier: i === 0 ? 1 : m.multiplier,
        })),
      },
    };
    expect(() => buildDeletedEntryFinalCorrection({ ...input, original: changed })).toThrow(
      'official adjustment',
    );
  });
  test('rejects a result preceding the finalization boundary within the same millisecond', () => {
    const input = fixture();
    const stale = { ...input.result, richSyncedAt: new Date('2026-09-01T00:00:00.001Z') };
    expect(
      buildFinalEntryLiveInputFromBaseAndResult(
        { ...input.original, finalResult: null },
        stale,
        '2026-09-01T00:00:00.001234Z',
      ),
    ).toBeNull();
  });
  test('requires exact scope and defaults to read-only inspection', () => {
    const args = [
      '--season',
      '2627',
      '--entry',
      '777',
      '--event',
      '2',
      '--expected-publication',
      '00000000-0000-4000-8000-000000000001',
      '--expected-generation',
      '4',
      '--change-id',
      'gw2-final-correction',
    ];
    expect(parseCorrectionArgs(args).apply).toBe(false);
    expect(parseCorrectionArgs([...args, '--apply']).apply).toBe(true);
    expect(() => parseCorrectionArgs([...args, '--event', '39'])).toThrow();
    expect(() => parseCorrectionArgs(args.slice(0, -2))).toThrow();
  });
});
