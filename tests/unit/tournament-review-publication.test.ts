import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

import {
  hasCompleteTournamentReviewH2HGroupCoverage,
  hasCanonicalTournamentReviewGroupAssignment,
  h2hMatchPointsMatchScore,
  isTournamentReviewEntryApplicable,
  normalizeTournamentReviewPointsRow,
  rankTournamentReviewH2HStandings,
  resolveTournamentReviewFormat,
  tournamentReviewScoreMatchesEntryResult,
  tournamentReviewFailureFingerprint,
  tournamentReviewRetryDelayMs,
  tournamentReviewSourceSpan,
  tournamentReviewSemanticSha256,
  splitTournamentReviewChunks,
} from '../../src/services/tournament-review-publication.service';
import {
  effectiveTournamentReviewEntryStartEventId,
  rankTournamentReviewPointsGroups,
} from '../../src/services/tournament-points-race-results.service';

const publicationSource = readFileSync(
  'src/services/tournament-review-publication.service.ts',
  'utf8',
);
const entryEventResultsSource = readFileSync('src/repositories/entry-event-results.ts', 'utf8');
const backfillSource = readFileSync('scripts/backfill-tournament-review-v2.ts', 'utf8');
const hardCutMigration = readFileSync(
  'migrations/0090_my_tournament_review_v2_1_hard_cut.sql',
  'utf8',
);

describe('My Tournament Review V2 format and retry policy', () => {
  test('nulls tournament metrics for non-applicable points rows', () => {
    const row = normalizeTournamentReviewPointsRow({
      entryId: 1,
      entryName: 'Entry',
      playerName: 'Player',
      applicable: false,
      groupId: 1,
      rank: 1,
      previousRank: 2,
      grossPoints: 10,
      transferCost: 0,
      netPoints: 10,
      tournamentScore: 10,
      seasonNetPoints: 10,
      seasonGrossPoints: 10,
      eventRank: 3,
      overallPoints: 42,
      overallRank: 7,
    });
    expect(row).toMatchObject({
      applicable: false,
      groupId: null,
      rank: null,
      previousRank: null,
      grossPoints: null,
      transferCost: null,
      netPoints: null,
      tournamentScore: null,
      seasonNetPoints: null,
      seasonGrossPoints: null,
      eventRank: null,
      overallPoints: 42,
      overallRank: 7,
    });
  });

  test('handles the empty-database sentinel before requiring a current season', () => {
    expect(backfillSource.indexOf('WHERE season_id = 0')).toBeGreaterThan(-1);
    expect(backfillSource.indexOf('currentSeasonRows.length === 0')).toBeGreaterThan(-1);
    expect(backfillSource.indexOf('seasonRepository.requireByCode')).toBeGreaterThan(
      backfillSource.indexOf('currentSeasonRows.length === 0'),
    );
    expect(hardCutMigration).toContain('ops.bootstrap_tournament_review_v2_1_backup_marker');
    expect(hardCutMigration).toContain(
      'GRANT EXECUTE ON FUNCTION ops.bootstrap_tournament_review_v2_1_backup_marker',
    );
    expect(hardCutMigration).not.toMatch(
      /GRANT INSERT ON TABLE ops\.tournament_review_v2_1_backup_manifest/,
    );
  });

  test('uses one mutually-exclusive format per finalized event', () => {
    const config = {
      groupMode: 'points_races' as const,
      groupStartedEventId: 1,
      groupEndedEventId: 10,
      knockoutMode: 'single_elimination' as const,
      knockoutStartedEventId: 11,
      knockoutEndedEventId: 13,
    };
    expect(resolveTournamentReviewFormat(config, 10)).toBe('POINTS');
    expect(resolveTournamentReviewFormat(config, 11)).toBe('KNOCKOUT');
    expect(resolveTournamentReviewFormat(config, 14)).toBeNull();
    expect(
      resolveTournamentReviewFormat(
        { ...config, groupMode: 'battle_races', knockoutMode: 'no_knockout' },
        5,
      ),
    ).toBe('H2H');
  });

  test('keeps source rechecks separate from execution retries', () => {
    expect(tournamentReviewRetryDelayMs('source', 1)).toBe(60_000);
    expect(tournamentReviewRetryDelayMs('source', 2)).toBe(180_000);
    expect(tournamentReviewRetryDelayMs('source', 3)).toBe(600_000);
    expect(tournamentReviewRetryDelayMs('source', 4)).toBeNull();
    expect(tournamentReviewRetryDelayMs('execution', 1)).toBe(60_000);
    expect(tournamentReviewRetryDelayMs('execution', 2)).toBe(300_000);
    expect(tournamentReviewRetryDelayMs('execution', 3)).toBe(900_000);
    expect(tournamentReviewRetryDelayMs('execution', 4)).toBeNull();
  });

  test('fingerprints failure dimensions without persisting raw errors', () => {
    const first = tournamentReviewFailureFingerprint('SOURCE', '6953:1:5:1');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(tournamentReviewFailureFingerprint('SOURCE', '6953:1:5:1'));
    expect(first).not.toBe(tournamentReviewFailureFingerprint('SOURCE', '6953:1:5:2'));
  });

  test('floors the persisted source span at the finalized event checkpoint', () => {
    const checkpoint = '2026-08-30T10:00:00.000Z';
    const span = tournamentReviewSourceSpan(checkpoint, [
      '2026-08-01T00:00:00.000Z',
      '2026-08-30T10:05:00.000Z',
    ]);
    expect(span.sourceMin.toISOString()).toBe(checkpoint);
    expect(span.sourceMax.toISOString()).toBe('2026-08-30T10:05:00.000Z');
  });

  test('validates H2H fixture coverage independently for every group', () => {
    const eligibleEntryIds = new Set([1, 2, 3, 4, 5, 6]);
    const entryGroupIds = new Map([
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 2],
      [5, 2],
      [6, 2],
    ]);
    expect(
      hasCompleteTournamentReviewH2HGroupCoverage({
        eligibleEntryIds,
        entryGroupIds,
        matchCountByGroup: new Map([
          [1, 2],
          [2, 2],
        ]),
        averageSidesByGroup: new Map([
          [1, 1],
          [2, 1],
        ]),
      }),
    ).toBe(true);
    expect(
      hasCompleteTournamentReviewH2HGroupCoverage({
        eligibleEntryIds,
        entryGroupIds,
        matchCountByGroup: new Map([
          [1, 2],
          [2, 1],
        ]),
        averageSidesByGroup: new Map([
          [1, 1],
          [2, 0],
        ]),
      }),
    ).toBe(false);
  });

  test('rejects complete but stale H2H group assignments', () => {
    const entryIds = new Set([1, 2, 3, 4]);
    const observedEntryGroupIds = new Map([
      [1, 10],
      [2, 10],
      [3, 20],
      [4, 20],
    ]);
    expect(
      hasCanonicalTournamentReviewGroupAssignment({
        entryIds,
        observedEntryGroupIds,
        canonicalRows: [
          { entry_id: 1, group_id: 10 },
          { entry_id: 2, group_id: 10 },
          { entry_id: 3, group_id: 20 },
          { entry_id: 4, group_id: 20 },
        ],
      }),
    ).toBe(true);
    // Every derived row can be internally coherent while being shifted to a
    // different canonical group.  That must not publish as a valid review.
    expect(
      hasCanonicalTournamentReviewGroupAssignment({
        entryIds,
        observedEntryGroupIds,
        canonicalRows: [
          { entry_id: 1, group_id: 20 },
          { entry_id: 2, group_id: 20 },
          { entry_id: 3, group_id: 10 },
          { entry_id: 4, group_id: 10 },
        ],
      }),
    ).toBe(false);
    expect(
      hasCanonicalTournamentReviewGroupAssignment({
        entryIds,
        observedEntryGroupIds,
        canonicalRows: [
          { entry_id: 1, group_id: 10 },
          { entry_id: 1, group_id: 20 },
          { entry_id: 3, group_id: 20 },
          { entry_id: 4, group_id: 20 },
        ],
      }),
    ).toBe(false);
  });

  test('represents pre-entry H2H participants without treating their scores as ready', () => {
    expect(isTournamentReviewEntryApplicable(null, 5)).toBe(true);
    expect(isTournamentReviewEntryApplicable(5, 5)).toBe(true);
    expect(isTournamentReviewEntryApplicable(6, 5)).toBe(false);
  });

  test('uses competition ranking for tied H2H scoring keys', () => {
    expect(
      rankTournamentReviewH2HStandings([
        { entryId: 3, matchPoints: 6, pointsFor: 120 },
        { entryId: 1, matchPoints: 6, pointsFor: 120 },
        { entryId: 2, matchPoints: 3, pointsFor: 110 },
      ]).map(({ entryId, rank }) => ({ entryId, rank })),
    ).toEqual([
      { entryId: 1, rank: 1 },
      { entryId: 3, rank: 1 },
      { entryId: 2, rank: 3 },
    ]);
  });

  test('keeps late-joining H2H participants visible but unranked', () => {
    expect(
      rankTournamentReviewH2HStandings([
        { entryId: 2, matchPoints: 0, pointsFor: -5, applicable: true },
        { entryId: 1, matchPoints: 0, pointsFor: 0, applicable: false },
      ]).map(({ entryId, rank }) => ({ entryId, rank })),
    ).toEqual([
      { entryId: 2, rank: 1 },
      { entryId: 1, rank: null },
    ]);
  });

  test('accepts only score-derived H2H match points', () => {
    expect(h2hMatchPointsMatchScore(70, 55, 3, 0)).toBe(true);
    expect(h2hMatchPointsMatchScore(70, 55, 1, 1)).toBe(false);
    expect(h2hMatchPointsMatchScore(55, 55, 1, 1)).toBe(true);
    expect(h2hMatchPointsMatchScore(55, 55, 3, 0)).toBe(false);
  });

  test('keeps the producer tie rank aligned with the immutable points validator', () => {
    const ranks = rankTournamentReviewPointsGroups([
      { entryId: 2, totalNetPoints: 100, overallRank: 10 },
      { entryId: 1, totalNetPoints: 100, overallRank: 10 },
      { entryId: 3, totalNetPoints: 80, overallRank: 30 },
    ]);
    expect(ranks.get('100-10')).toBe(1);
    expect(ranks.get('80-30')).toBe(3);
  });

  test('clamps points cumulative totals to each entry start event', () => {
    expect(effectiveTournamentReviewEntryStartEventId(5, null)).toBe(5);
    expect(effectiveTournamentReviewEntryStartEventId(5, 3)).toBe(5);
    expect(effectiveTournamentReviewEntryStartEventId(5, 7)).toBe(7);
  });

  test('repairs historical points ranks with finalized cumulative inputs', () => {
    const migration = readFileSync(
      'migrations/0078_repair_tournament_points_group_ranks.sql',
      'utf8',
    );
    expect(migration).toContain('event.finished = true');
    expect(migration).toContain('event.data_checked = true');
    expect(migration).toContain('RANK() OVER');
    expect(migration).toContain('ORDER BY cumulative_net_points DESC, overall_rank NULLS LAST');
    expect(migration).toContain('points.event_group_rank IS DISTINCT FROM ranked.repaired_rank');
  });

  test('requires derived matchup scores to cover the entry result watermark', () => {
    const result = {
      event_net_points: 70,
      updated_at: '2026-08-30T10:00:00.000Z',
      rich_synced_at: '2026-08-30T09:59:00.000Z',
    };
    expect(
      tournamentReviewScoreMatchesEntryResult(
        70,
        '2026-08-30T10:01:00.000Z',
        '2026-08-30T10:02:00.000Z',
        result,
      ),
    ).toBe(true);
    expect(
      tournamentReviewScoreMatchesEntryResult(
        69,
        '2026-08-30T10:01:00.000Z',
        '2026-08-30T10:02:00.000Z',
        result,
      ),
    ).toBe(false);
    expect(
      tournamentReviewScoreMatchesEntryResult(
        70,
        '2026-08-30T09:58:00.000Z',
        '2026-08-30T09:58:00.000Z',
        result,
      ),
    ).toBe(false);
    expect(tournamentReviewScoreMatchesEntryResult(70, null, null, null)).toBe(false);
  });

  test('reconciles incrementally and retires scopes under the publication lock', () => {
    expect(publicationSource).toContain('COALESCE(state.existing_eligible_at');
    expect(publicationSource).toContain('event.updated_at AS event_updated_at');
    expect(publicationSource).toContain('const eventMetadataChanged =');
    expect(publicationSource).toContain('eventMetadataChanged ? [event.updated_at] : []');
    expect(publicationSource).toContain('previous.payload AS existing_payload');
    expect(publicationSource).toContain('tournament.updated_at AS tournament_updated_at');
    expect(publicationSource).toContain('tournamentMetadataChanged');
    expect(publicationSource).toContain('tournament_metadata_eligible_at');
    expect(publicationSource).toContain('existing.metadata_payload AS existing_metadata_payload');
    expect(publicationSource).toContain(
      'existing.metadata_payload IS DISTINCT FROM candidate.tournament_payload',
    );
    expect(publicationSource).toMatch(/\+ interval '1 microsecond'/);
    expect(publicationSource).toContain('metadata_payload = EXCLUDED.metadata_payload');
    expect(publicationSource).toContain('entry_metadata_payload = COALESCE');
    expect(publicationSource).toContain('entry_metadata_eligible_at');
    expect(publicationSource).toContain('canonical_group_assignments AS MATERIALIZED');
    expect(publicationSource).toContain('group_assignment_eligible_at');
    expect(publicationSource).toMatch(/existing\.state = 'READY'/);
    expect(publicationSource).toContain(
      'existing.state = \x27DEGRADED\x27 AND existing.next_attempt_at IS NULL',
    );
    expect(publicationSource).toContain('existing.group_assignment_payload');
    expect(publicationSource).toContain('group_assignment_payload = COALESCE');
    expect(publicationSource).toContain('jsonb_object_agg(');
    expect(publicationSource).toMatch(/jsonb_typeof\(previous\.payload #> '\{points,rows\}'\)/);
    expect(publicationSource).toMatch(/jsonb_typeof\(previous\.payload #> '\{h2h,standings\}'\)/);
    expect(publicationSource).toMatch(/'\[\]'::jsonb/);
    expect(publicationSource).toMatch(/'startedEvent', entry\.started_event/);
    expect(publicationSource).toContain('state.existing_eligible_at IS NULL');
    expect(publicationSource).toContain('state.format <> \x27KNOCKOUT\x27');
    expect(publicationSource).toContain('state.group_started_event_id');
    expect(publicationSource).toContain('renewReviewObligationLease');
    expect(publicationSource).toMatch(
      /lease_expires_at = clock_timestamp\(\) \+ interval '2 minutes'/,
    );
    expect(publicationSource).toContain('TOURNAMENT_REVIEW_LEASE_RENEW_INTERVAL_MS');
    expect(publicationSource).toContain('event.finished = true');
    expect(publicationSource).toContain('event.data_checked = true');
    expect(publicationSource).toContain('history_group_mismatch_count');
    expect(publicationSource).toContain('historical points group assignment is stale');
    expect(publicationSource).toContain('previous points group ranks are stale');
    expect(publicationSource).toContain('RANK() OVER');
    expect(publicationSource).toContain('history.event_id >= GREATEST(');
    expect(publicationSource).toContain(
      'history_group.event_points IS DISTINCT FROM history_result.event_points',
    );
    expect(publicationSource).toContain(
      'history_group.event_cost IS DISTINCT FROM history_result.event_transfers_cost',
    );
    expect(publicationSource).toContain('points group ranks are inconsistent');
    expect(publicationSource).toContain('payload_row->>\x27applicable\x27');
    expect(publicationSource).toContain('readiness: {');
    expect(publicationSource).toContain('expectedSubjectCount: built.expectedSubjectCount');
    expect(publicationSource).toContain(
      'notApplicableSubjectCount: built.notApplicableSubjectCount',
    );
    expect(publicationSource).toContain('state.existing_payload IS NOT NULL');
    expect(publicationSource).toMatch(/state\.existing_payload->'points'->'rows'/);
    expect(publicationSource).toMatch(/state\.existing_payload->'h2h'->'standings'/);
    expect(publicationSource).toMatch(/state\.existing_payload->'knockout'->'matches'/);
    expect(publicationSource).toContain('payload #>>');
    expect(publicationSource).toContain('await tx`');
    expect(publicationSource).toContain('pg_advisory_xact_lock');
    expect(publicationSource).toContain('locked_stale_scopes AS MATERIALIZED');
    expect(publicationSource).toContain('DELETE FROM competition.tournament_review_heads');
    expect(publicationSource).toContain('DELETE FROM competition.tournament_review_obligations');
    expect(publicationSource).toContain('\x27review:\x27 || ${season.seasonId}::text');
    const retirementProbe = publicationSource.slice(
      publicationSource.indexOf('const potentialStaleScopes'),
      publicationSource.indexOf('for (const scope of potentialStaleScopes)'),
    );
    expect(retirementProbe).not.toContain('event.finished = true');
    expect(retirementProbe).not.toContain('event.data_checked = true');
    expect(retirementProbe).not.toContain('event.data_checked_at IS NOT NULL');
  });

  test('includes entry metadata and validated cumulative history in provenance', () => {
    expect(publicationSource).toContain('entry.updated_at AS entry_updated_at');
    expect(publicationSource).toContain('const eventMetadataChanged =');
    expect(publicationSource).toContain('eventMetadataChanged ? [event.updated_at] : []');
    expect(publicationSource).toContain('COALESCE(entry.started_event, 1)');
    expect(publicationSource).toContain('history_sources.source_min_checked_at');
    expect(publicationSource).toContain('sourceTimes.push(...historySourceDates)');
    expect(publicationSource).toContain(
      'sourceTimes.push(...brackets.map((bracket) => bracket.updated_at))',
    );
    expect(publicationSource).toContain('knockout match source is stale');
    expect(entryEventResultsSource).toContain('isNotNull(eventsInFpl.dataCheckedAt)');
  });

  test('preserves source checkpoints for unchanged official facts', () => {
    const officialH2HSource = readFileSync('src/repositories/tournament-official-h2h.ts', 'utf8');
    const knockoutSource = readFileSync('src/repositories/tournament-knockouts.ts', 'utf8');
    expect(officialH2HSource).toContain('battlePayloadUnchanged');
    expect(officialH2HSource).toContain('knockoutPayloadUnchanged');
    expect(officialH2HSource).toContain('fetchedOfficialMatchIds');
    expect(officialH2HSource).toContain('officialMatchWasFetched');
    expect(officialH2HSource).toContain('WHEN ${officialMatchWasFetched}');
    expect(officialH2HSource).toContain('existing.homeEntryId !== incoming.homeEntryId');
    expect(officialH2HSource).toContain(
      'THEN ${tournamentBattleGroupResultsInCompetition.sourceCheckedAt}',
    );
    expect(officialH2HSource).toContain(
      'THEN ${tournamentKnockoutResultsInCompetition.sourceCheckedAt}',
    );
    expect(knockoutSource).toContain('knockoutPayloadUnchanged');
    expect(knockoutSource).toContain('fetchedMatchIds');
    expect(knockoutSource).toContain('bracketMatchWasFetched');
    expect(knockoutSource).toContain('WHEN ${bracketMatchWasFetched}');
    expect(knockoutSource).toContain('THEN ${tournamentKnockoutsInCompetition.updatedAt}');
  });

  test('semantic hash ignores observation clocks but changes with business values', () => {
    const first = {
      schemaVersion: 'my-tournament-review-v2.1',
      metricVersion: 'settled-review-v2',
      points: { rows: [{ entryId: 6953, grossPoints: 70, updatedAt: '2026-08-30T10:00:00Z' }] },
      freshness: { sourceMaxCheckedAt: '2026-08-30T10:01:00Z' },
    };
    const second = {
      ...first,
      points: { rows: [{ entryId: 6953, grossPoints: 70, updatedAt: '2026-09-01T10:00:00Z' }] },
      freshness: { sourceMaxCheckedAt: '2026-09-01T10:01:00Z' },
    };
    expect(tournamentReviewSemanticSha256(first, ['a'.repeat(64)])).toBe(
      tournamentReviewSemanticSha256(second, ['a'.repeat(64)]),
    );
    expect(
      tournamentReviewSemanticSha256(
        { ...second, points: { rows: [{ entryId: 6953, grossPoints: 71 }] } },
        ['a'.repeat(64)],
      ),
    ).not.toBe(tournamentReviewSemanticSha256(first, ['a'.repeat(64)]));
  });

  test('makes correction retries idempotent by Change ID and keeps status JSON fail-closed', () => {
    expect(publicationSource).toContain(
      'previousHead[0]?.correction_change_id === correction.changeId',
    );
    expect(publicationSource).toContain('previousHead[0]?.correction_reason === correction.reason');
    expect(publicationSource).toContain('state: \x27REUSED\x27');
    expect(publicationSource).toContain(
      'jsonb_typeof(publication.payload -> \x27manifest\x27) = \x27object\x27',
    );
    expect(publicationSource).toContain(
      'jsonb_typeof(publication.payload -> \x27manifest\x27 -> \x27sectionCount\x27) = \x27number\x27',
    );
    expect(publicationSource).toContain(
      'jsonb_typeof(section -> \x27itemCount\x27) IS DISTINCT FROM \x27number\x27',
    );
    expect(publicationSource).toContain('isSafeReviewManifestCount');
    expect(publicationSource).toContain(
      'jsonb_typeof(section -> \x27chunkHashes\x27) <> \x27array\x27',
    );
    expect(publicationSource).toContain('Keep any attached repair issue on the descendant');
    expect(publicationSource).toContain('first_eligible_at = clock_timestamp()');
    expect(publicationSource).toContain(String.raw`/^[0-9a-f]{64}$/.test(chunkSha256)`);
    expect(publicationSource).toContain('[...expectedKeys].some((key) => !actual.has(key))');
    expect(publicationSource).toContain('TOURNAMENT_REVIEW_SEMANTIC_VERIFY_BATCH_SIZE = 100');
    expect(publicationSource).toContain('Semantic verification is a bounded');
    expect(publicationSource).toContain('chunkItemCounts');
    expect(publicationSource).toContain('(section ->> \x27itemCount\x27)::numeric');
    expect(publicationSource).toContain('(item_count::text)::numeric = 0');
    expect(publicationSource).toContain(
      'concat(\x27SYSTEM-REACTIVATION:\x27, ${season.seasonId}::text, \x27:\x27, tournament_id::text, \x27:\x27, event_id::text, \x27:\x27, historical_revision::text)',
    );
    expect(publicationSource).toContain(
      '(publication.payload -> \x27manifest\x27 ->> \x27chunkCount\x27)::numeric',
    );
    expect(publicationSource).toContain(
      'sum(\n                           CASE\n                             WHEN jsonb_typeof(section -> \x27chunkHashes\x27) = \x27array\x27',
    );
    expect(publicationSource).toContain(
      'SELECT count(*)::numeric\n                       FROM jsonb_array_elements(CASE',
    );
    const sqlQuote = String.fromCharCode(39);
    expect(publicationSource).toContain(
      'count(DISTINCT section ->> ' + sqlQuote + 'sectionKey' + sqlQuote + ')',
    );
    expect(publicationSource).toContain('WHEN ' + sqlQuote + 'POINTS' + sqlQuote + ' THEN');
    expect(publicationSource).toContain(sqlQuote + 'POINTS_TRAJECTORIES' + sqlQuote);
    expect(publicationSource).toContain(sqlQuote + 'H2H_FIXTURES' + sqlQuote);
    expect(publicationSource).toContain(sqlQuote + 'KNOCKOUT_BRACKET' + sqlQuote);
  });

  test('splits review sections into bounded deterministic chunks', () => {
    const chunks = splitTournamentReviewChunks({
      format: 'POINTS',
      points: {
        rows: Array.from({ length: 205 }, (_, index) => ({ entryId: index + 1 })),
        trajectoryRows: Array.from({ length: 205 }, (_, index) => ({ entryId: 205 - index })),
      },
    });
    expect(chunks.map((chunk) => chunk.itemCount)).toEqual([100, 100, 5, 100, 100, 5]);
    expect(chunks.every((chunk) => chunk.itemCount <= 100)).toBe(true);
    expect(chunks[0].chunkSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('publishes a distinct rank-ordered trajectory section', () => {
    const chunks = splitTournamentReviewChunks({
      format: 'POINTS',
      points: {
        rows: [{ entryId: 1 }, { entryId: 2 }],
        trajectoryRows: [{ entryId: 2 }, { entryId: 1 }],
      },
    });
    expect(chunks.filter((chunk) => chunk.sectionKey === 'POINTS_STANDINGS')[0]?.items).toEqual([
      { entryId: 1 },
      { entryId: 2 },
    ]);
    expect(chunks.filter((chunk) => chunk.sectionKey === 'POINTS_TRAJECTORIES')[0]?.items).toEqual([
      { entryId: 2 },
      { entryId: 1 },
    ]);
    expect(chunks[0]?.chunkSha256).not.toBe(chunks[2]?.chunkSha256);
  });
});
