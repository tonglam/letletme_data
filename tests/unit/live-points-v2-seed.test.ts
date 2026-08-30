import { describe, expect, test } from 'bun:test';

import {
  assertLegacyEvidenceMatchesEventLives,
  assertLivePointsV2SeedDatabaseTarget,
  buildSeedHead,
  buildSeedInput,
  canSupersedeUncheckpointedSeedCurrent,
  canUseLegacyRelationalFacts,
  findMissingPickScopes,
  isNoOpLegacyFixtureEvidence,
  inspectPickScope,
  liveSeedActivePointerSha256,
  parseSeedArguments,
  rebaseLegacyFixturesAtCanonicalFence,
  resolveLivePointsV2SeedDatabaseUrl,
  resolveSeedObservationCheckedAt,
  seedClaimMatchesActiveFence,
  type ExistingPickRow,
  type FinalResultSeedRow,
  type LegacyFixtureEvidenceRow,
  type LegacyFixtureFactRow,
  type PreviousTotalsRow,
} from '../../scripts/seed-live-points-v2';
import {
  parseLivePublicationV2Manifest,
  parseLivePublicationV2OrderingFence,
  type LivePublicationV2,
} from '../../src/cache/live-publication-v2';
import {
  livePublicationSeedClaimAllowsCheckpoint,
  livePublicationSeedClaimMatchesCandidate,
  livePublicationSeedClaimMatchesPublication,
} from '../../src/services/live-publication-v2-checkpoint.service';

function rows(overrides: Partial<ExistingPickRow> = {}): ExistingPickRow[] {
  return Array.from({ length: 15 }, (_, index) => ({
    season_id: 2627,
    entry_id: 6953,
    event_id: 2,
    position: index + 1,
    element_id: index + 1,
    multiplier: index === 0 ? 2 : 1,
    is_captain: index === 0,
    is_vice_captain: index === 1,
    chip: index === 0 ? null : null,
    transfers: index === 0 ? 0 : null,
    transfers_cost: index === 0 ? 0 : null,
    source_created_at: new Date('2026-08-29T10:00:00.000Z'),
    source_updated_at: new Date('2026-08-29T10:01:00.000Z'),
    ...overrides,
  }));
}

describe('Live Points V2 entry-pick seed', () => {
  test('keeps the direct seed connection separate from the runtime connection', () => {
    expect(
      resolveLivePointsV2SeedDatabaseUrl({
        DATABASE_URL: 'postgresql://runtime',
        LIVE_POINTS_V2_SEED_DATABASE_URL: 'postgresql://migration',
      }),
    ).toBe('postgresql://migration');
    expect(resolveLivePointsV2SeedDatabaseUrl({ DATABASE_URL: 'postgresql://runtime' })).toBe(
      'postgresql://runtime',
    );
    expect(() => resolveLivePointsV2SeedDatabaseUrl({})).toThrow(
      'DATABASE_URL or LIVE_POINTS_V2_SEED_DATABASE_URL is required',
    );
  });

  test('requires an explicit seed connection for destructive execution', () => {
    expect(() =>
      resolveLivePointsV2SeedDatabaseUrl(
        { DATABASE_URL: 'postgresql://runtime' },
        { requireExplicitSeedUrl: true },
      ),
    ).toThrow('LIVE_POINTS_V2_SEED_DATABASE_URL is required for destructive execution');
  });

  test('rejects a seed connection that targets a different database project', () => {
    expect(() =>
      assertLivePointsV2SeedDatabaseTarget(
        'postgresql://postgres@db.other-project.supabase.co:5432/postgres',
        'postgresql://letletme_data_runtime@db.current-project.supabase.co:5432/postgres',
      ),
    ).toThrow('LIVE_POINTS_V2_SEED_DATABASE_URL must target the same PostgreSQL project');
  });

  test('accepts direct seed and runtime pooler URLs for the same database project', () => {
    expect(() =>
      assertLivePointsV2SeedDatabaseTarget(
        'postgresql://postgres@db.current-project.supabase.co:5432/postgres',
        'postgresql://letletme_data_runtime.current-project@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres',
      ),
    ).not.toThrow();
  });

  test('uses the persisted event fence without inventing a cutover timestamp', () => {
    const sourceCheckedAt = new Date('2026-08-30T15:30:08.402Z');
    const eventSnapshotCheckedAt = new Date('2026-08-30T15:31:08.555Z');

    expect(resolveSeedObservationCheckedAt(sourceCheckedAt, eventSnapshotCheckedAt)).toEqual(
      eventSnapshotCheckedAt,
    );
    expect(
      resolveSeedObservationCheckedAt(eventSnapshotCheckedAt, new Date('2026-08-30T15:30:08.402Z')),
    ).toEqual(eventSnapshotCheckedAt);
    expect(() => resolveSeedObservationCheckedAt(new Date('invalid'), null)).toThrow(
      'seed source timestamp is invalid',
    );
  });

  test('accepts later relational backfills only for immutable finalized events', () => {
    const sourceCheckedAt = new Date('2026-08-25T16:08:07.277Z');
    const historicalFacts = new Date('2026-08-25T16:08:00.000Z');
    const laterBackfill = new Date('2026-08-30T19:31:27.354Z');

    expect(canUseLegacyRelationalFacts('LIVE_ACTIVE', sourceCheckedAt, historicalFacts)).toBe(true);
    expect(canUseLegacyRelationalFacts('FINALIZED', sourceCheckedAt, laterBackfill)).toBe(true);
    expect(canUseLegacyRelationalFacts('GW_REVIEW', sourceCheckedAt, laterBackfill)).toBe(false);
    expect(canUseLegacyRelationalFacts('FINALIZED', sourceCheckedAt, null)).toBe(false);
  });

  test('supersedes only a non-durable cutover orphan at a proven source fence', () => {
    const current = {
      checkpointedAt: null,
      sourceCheckedAt: '2026-08-30T15:30:08.402Z',
      state: 'LIVE_ACTIVE' as const,
    };
    const seed = {
      sourceCheckedAt: new Date('2026-08-30T15:30:08.402Z'),
      observationCheckedAt: new Date('2026-08-30T15:31:08.555Z'),
      state: 'LIVE_ACTIVE' as const,
    };

    expect(canSupersedeUncheckpointedSeedCurrent(current, seed)).toBe(true);
    expect(
      canSupersedeUncheckpointedSeedCurrent(
        { ...current, checkpointedAt: '2026-08-30T15:32:00.000Z' },
        seed,
      ),
    ).toBe(false);
    expect(
      canSupersedeUncheckpointedSeedCurrent(current, {
        ...seed,
        sourceCheckedAt: new Date('2026-08-30T15:29:59.999Z'),
      }),
    ).toBe(false);
    expect(
      canSupersedeUncheckpointedSeedCurrent(
        { ...current, state: 'FINALIZED' },
        { ...seed, state: 'GW_REVIEW' },
      ),
    ).toBe(false);
    expect(
      canSupersedeUncheckpointedSeedCurrent(
        { ...current, state: 'FINALIZED' },
        { ...seed, state: 'FINALIZED' },
      ),
    ).toBe(true);
  });

  test('binds checkpoint permission to the exact durable seed claim', () => {
    const claimId = '00000000-0000-4000-8000-000000000001';
    expect(livePublicationSeedClaimAllowsCheckpoint(null, undefined)).toBe(true);
    expect(livePublicationSeedClaimAllowsCheckpoint(null, claimId)).toBe(false);
    expect(livePublicationSeedClaimAllowsCheckpoint(claimId, undefined)).toBe(false);
    expect(livePublicationSeedClaimAllowsCheckpoint(claimId, claimId)).toBe(true);
    expect(
      livePublicationSeedClaimAllowsCheckpoint(claimId, '00000000-0000-4000-8000-000000000002'),
    ).toBe(false);
    expect(liveSeedActivePointerSha256('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  test('binds a durable seed claim to the exact promoted candidate', () => {
    const sourceCheckedAt = '2026-08-30T15:30:08.402Z';
    const eventLiveSha256 = 'a'.repeat(64);
    const fixturesSha256 = 'b'.repeat(64);
    const publication = {
      state: 'LIVE_ACTIVE',
      sourceCheckedAt,
      items: {
        eventLive: { sha256: eventLiveSha256 },
        fixtures: { sha256: fixturesSha256 },
      },
    } as LivePublicationV2;
    const claim = {
      claimId: '00000000-0000-4000-8000-000000000001',
      expectedActiveSha256: 'c'.repeat(64),
      candidateState: 'LIVE_ACTIVE' as const,
      candidateSourceCheckedAt: sourceCheckedAt,
      candidateEventLiveSha256: eventLiveSha256,
      candidateFixturesSha256: fixturesSha256,
      claimedAt: '2026-08-30T15:30:07.402Z',
    };

    expect(livePublicationSeedClaimMatchesPublication(claim, publication)).toBe(true);
    expect(
      livePublicationSeedClaimMatchesPublication(claim, {
        ...publication,
        sourceCheckedAt: '2026-08-30T15:30:09.402Z',
      }),
    ).toBe(false);
    expect(
      livePublicationSeedClaimMatchesPublication(claim, {
        ...publication,
        items: {
          ...publication.items,
          fixtures: { ...publication.items.fixtures, sha256: 'd'.repeat(64) },
        },
      }),
    ).toBe(false);
    expect(
      livePublicationSeedClaimMatchesCandidate(claim, {
        candidateState: 'LIVE_ACTIVE',
        candidateSourceCheckedAt: sourceCheckedAt,
        candidateEventLiveSha256: eventLiveSha256,
        candidateFixturesSha256: fixturesSha256,
      }),
    ).toBe(true);
    expect(
      livePublicationSeedClaimMatchesCandidate(claim, {
        candidateState: 'LIVE_ACTIVE',
        candidateSourceCheckedAt: sourceCheckedAt,
        candidateEventLiveSha256: 'e'.repeat(64),
        candidateFixturesSha256: fixturesSha256,
      }),
    ).toBe(false);
  });

  test('retains ordering fences when revision or item metadata is corrupt', () => {
    const scope = { season: '2627', eventId: 2 } as const;
    const raw = JSON.stringify({
      contractVersion: 'live-points-v2',
      publicationId: 'corrupt-publication-identity',
      generation: 7,
      season: scope.season,
      eventId: scope.eventId,
      state: 'FINALIZED',
      sourceCheckedAt: '2026-08-30T15:30:08.402Z',
      publishedAt: '2026-08-30T15:30:09.402Z',
      checkpointedAt: null,
      expectedNextCheckAt: null,
      revisions: { corrupt: true },
      items: { corrupt: true },
    });

    expect(parseLivePublicationV2Manifest(raw, scope)).toBeNull();
    expect(parseLivePublicationV2OrderingFence(raw, scope)).toEqual({
      contractVersion: 'live-points-v2',
      generation: 7,
      season: '2627',
      eventId: 2,
      state: 'FINALIZED',
      sourceCheckedAt: '2026-08-30T15:30:08.402Z',
      checkpointedAt: null,
    });

    const damagedGeneration = JSON.stringify({
      ...JSON.parse(raw),
      generation: 'corrupt',
    });
    expect(parseLivePublicationV2OrderingFence(damagedGeneration, scope)).toEqual({
      contractVersion: 'live-points-v2',
      generation: null,
      season: '2627',
      eventId: 2,
      state: 'FINALIZED',
      sourceCheckedAt: '2026-08-30T15:30:08.402Z',
      checkpointedAt: null,
    });
  });

  test('does not weaken a complete manifest claim mismatch to its ordering fence', () => {
    const claim = {
      claimId: '00000000-0000-4000-8000-000000000001',
      expectedActiveSha256: 'c'.repeat(64),
      candidateState: 'LIVE_ACTIVE' as const,
      candidateSourceCheckedAt: '2026-08-30T15:30:08.402Z',
      candidateEventLiveSha256: 'a'.repeat(64),
      candidateFixturesSha256: 'b'.repeat(64),
      claimedAt: '2026-08-30T15:30:07.402Z',
    };
    const manifest = {
      state: claim.candidateState,
      sourceCheckedAt: claim.candidateSourceCheckedAt,
      items: {
        eventLive: { sha256: 'd'.repeat(64) },
        fixtures: { sha256: claim.candidateFixturesSha256 },
      },
    } as LivePublicationV2;
    const orderingFence = {
      contractVersion: 'live-points-v2' as const,
      generation: 7,
      season: '2627',
      eventId: 2,
      state: claim.candidateState,
      sourceCheckedAt: claim.candidateSourceCheckedAt,
      checkpointedAt: null,
    };

    expect(seedClaimMatchesActiveFence(claim, manifest, orderingFence)).toBe(false);
    expect(seedClaimMatchesActiveFence(claim, null, orderingFence)).toBe(true);
  });

  test('rebases the fixture sibling from canonical rows at a newer event fence', () => {
    const fixture = {
      id: 16,
      code: 2442288,
      event: 2,
      finished: false,
      finishedProvisional: false,
      kickoffTime: new Date('2026-08-30T13:00:00.000Z'),
      minutes: 45,
      provisionalStartTime: false,
      started: true,
      teamA: 1,
      teamAScore: 0,
      teamH: 2,
      teamHScore: 1,
      stats: [],
      teamHDifficulty: 3,
      teamADifficulty: 4,
      pulseId: 1234,
      createdAt: null,
      updatedAt: null,
    };
    const canonical: LegacyFixtureFactRow = {
      fixture_id: fixture.id,
      code: fixture.code,
      event_id: fixture.event,
      finished: fixture.finished,
      finished_provisional: fixture.finishedProvisional,
      kickoff_time: fixture.kickoffTime,
      minutes: fixture.minutes,
      provisional_start_time: fixture.provisionalStartTime,
      started: fixture.started,
      team_a_id: fixture.teamA,
      team_a_score: fixture.teamAScore,
      team_h_id: fixture.teamH,
      team_h_score: fixture.teamHScore,
      stats: fixture.stats,
      team_h_difficulty: fixture.teamHDifficulty,
      team_a_difficulty: fixture.teamADifficulty,
      pulse_id: fixture.pulseId,
      created_at: new Date('2026-08-29T10:00:00.000Z'),
      updated_at: new Date('2026-08-30T15:31:08.555Z'),
    };
    const seed = {
      source: { event_id: 2 },
      sourceCheckedAt: new Date('2026-08-30T15:30:08.402Z'),
      observationCheckedAt: new Date('2026-08-30T15:31:08.555Z'),
      fixtures: [fixture],
    };

    const rebased = rebaseLegacyFixturesAtCanonicalFence(seed, [
      {
        ...canonical,
        finished_provisional: true,
        minutes: 90,
        team_a_score: 2,
        team_h_score: 5,
      },
    ]);
    expect(rebased[0]).toMatchObject({
      id: 16,
      finishedProvisional: true,
      minutes: 90,
      teamAScore: 2,
      teamHScore: 5,
    });
    expect(() => rebaseLegacyFixturesAtCanonicalFence(seed, [])).toThrow(
      'Canonical fixtures do not prove the newer event fence',
    );
  });

  test('recognises only zero-contribution out-of-scope fixture rows as no-op evidence', () => {
    const noOp: LegacyFixtureEvidenceRow = {
      event_id: 2,
      fixture_id: 20,
      element_id: 28,
      minutes: 0,
      starts: null,
      goals: 0,
      assists: 0,
      own_goals: 0,
      yellow_cards: 0,
      red_cards: 0,
    };
    expect(isNoOpLegacyFixtureEvidence(noOp)).toBe(true);
    expect(isNoOpLegacyFixtureEvidence({ ...noOp, starts: 1 })).toBe(false);
    expect(isNoOpLegacyFixtureEvidence({ ...noOp, minutes: 1 })).toBe(false);
    expect(isNoOpLegacyFixtureEvidence({ ...noOp, goals: 1 })).toBe(false);
  });

  test('does not let an ignored DGW row suppress start-evidence coverage', () => {
    const noOp: LegacyFixtureEvidenceRow = {
      event_id: 2,
      fixture_id: 20,
      element_id: 28,
      minutes: 0,
      starts: null,
      goals: 0,
      assists: 0,
      own_goals: 0,
      yellow_cards: 0,
      red_cards: 0,
    };
    const attributableZero: LegacyFixtureEvidenceRow = {
      ...noOp,
      fixture_id: 16,
      starts: 0,
    };
    const eventLive = {
      eventId: 2,
      elementId: 28,
      minutes: 0,
      goalsScored: 0,
      assists: 0,
      cleanSheets: 0,
      goalsConceded: 0,
      ownGoals: 0,
      penaltiesSaved: 0,
      penaltiesMissed: 0,
      yellowCards: 0,
      redCards: 0,
      saves: 0,
      bonus: 0,
      bps: 0,
      defensiveContribution: 0,
      starts: true,
      expectedGoals: null,
      expectedAssists: null,
      expectedGoalInvolvements: null,
      expectedGoalsConceded: null,
      inDreamTeam: false,
      totalPoints: 0,
      createdAt: null,
      fixtureBreakdown: [{ fixtureId: 16, stats: [] }],
    };

    expect(() =>
      assertLegacyEvidenceMatchesEventLives(
        {
          source: { event_id: 2 },
          eventLives: [eventLive],
          fixtures: [{ id: 16 }, { id: 20 }],
        } as never,
        [noOp, attributableZero],
      ),
    ).toThrow('Legacy fixture evidence has no start marker');
  });

  test('creates a deterministic complete head for exactly 15 valid rows', () => {
    const head = buildSeedHead(rows());
    expect(head).toMatchObject({
      seasonId: 2627,
      entryId: 6953,
      eventId: 2,
      generation: 1,
      rowCount: 15,
      picksBaseRevision: head.contentSha256,
    });
    expect(head.contentSha256).toHaveLength(64);
    expect(head.publicationId).toHaveLength(64);
  });

  test('places malformed rowsets in repair scope instead of making a head', () => {
    const malformed = rows();
    malformed[14] = { ...malformed[14]!, element_id: malformed[0]!.element_id };
    const repair = inspectPickScope(malformed);
    expect(repair).toMatchObject({
      seasonId: 2627,
      entryId: 6953,
      eventId: 2,
      observedRowCount: 15,
    });
    expect(repair?.reasons).toContain('ELEMENTS_NOT_UNIQUE_POSITIVE');
    expect(() => buildSeedHead(malformed)).toThrow('Cannot seed invalid pick scope');
  });

  test('creates repair scope for an eligible entry with no pick rows', () => {
    const missing = findMissingPickScopes(
      [
        { seasonId: 2627, entryId: 6953, eventId: 2 },
        { seasonId: 2627, entryId: 7000, eventId: 2 },
      ],
      [rows()],
    );
    expect(missing).toEqual([
      {
        seasonId: 2627,
        entryId: 7000,
        eventId: 2,
        observedRowCount: 0,
        reasons: ['PICKS_ROWSET_MISSING'],
      },
    ]);
  });

  test('seeds previous totals and final evidence only when the data_checked fence is complete', () => {
    const previous: PreviousTotalsRow = {
      entry_id: 6953,
      through_event_id: 1,
      total_points: 71,
      overall_rank: 123,
    };
    const final: FinalResultSeedRow = {
      entry_id: 6953,
      event_id: 2,
      event_points: 17,
      overall_points: 88,
      event_picks: rows().map((row) => ({
        element: row.element_id,
        position: row.position,
        multiplier: row.multiplier,
        is_captain: row.is_captain,
        is_vice_captain: row.is_vice_captain,
      })),
      automatic_substitutions: [],
      rich_synced_at: new Date('2026-08-29T10:05:00.000Z'),
      data_checked_at: new Date('2026-08-29T10:04:00.000Z'),
    };
    const seeded = buildSeedInput('2627', rows(), previous, final);
    expect(seeded.input.previousTotals).toMatchObject({
      throughEventId: 1,
      totalPoints: 71,
      overallRank: 123,
    });
    expect(seeded.input.finalResult).toMatchObject({
      score: { eventPoints: 17, totalPoints: 88 },
      automaticSubs: [],
    });
    expect(seeded.sourceCheckedAt.toISOString()).toBe('2026-08-29T10:05:00.000Z');

    const stale = buildSeedInput('2627', rows(), previous, {
      ...final,
      rich_synced_at: new Date('2026-08-29T10:03:00.000Z'),
    });
    expect(stale.input.finalResult).toBeNull();
  });

  test('requires explicit scope arguments and rejects duplicate switches', () => {
    expect(parseSeedArguments(['--execute', '--season', '2627', '--event-id', '2'])).toEqual({
      execute: true,
      seedCache: false,
      allFinalized: false,
      season: '2627',
      eventId: 2,
    });
    expect(parseSeedArguments(['--cache', '--season', '2627'])).toEqual({
      execute: false,
      seedCache: true,
      allFinalized: false,
      season: '2627',
      eventId: null,
    });
    expect(
      parseSeedArguments(['--cache', '--all-finalized', '--season', '2627', '--event-id', '2']),
    ).toMatchObject({ allFinalized: true, season: '2627', eventId: 2 });
    expect(() => parseSeedArguments(['--cache'])).toThrow();
    expect(() => parseSeedArguments(['--all-finalized'])).toThrow();
    expect(() => parseSeedArguments(['--season', '2627', '--season', '2627'])).toThrow();
    expect(() => parseSeedArguments(['--event-id', '0'])).toThrow();
  });
});
