import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { databaseTransactionStorage, getDbClient } from '../../src/db/singleton';
import { explicitSeasonRef } from '../../src/domain/fpl-season';
import { tournamentRosterRepository } from '../../src/repositories/tournament-roster';
import { withMutationScopes } from '../../src/utils/mutation-scopes';

const SEASON_CODE = '8990';
const SEASON_ID = explicitSeasonRef(SEASON_CODE).seasonId;
const TOURNAMENT_ID = 991_951;
const LEAGUE_ID = 991_951;
const ENTRY_IDS = [991_951, 991_952, 991_953] as const;

async function cleanup(): Promise<void> {
  const sql = await getDbClient();
  await sql`
    DELETE FROM competition.entry_event_pick_heads
    WHERE season_id = ${SEASON_ID} AND entry_id = ANY(${sql.array([...ENTRY_IDS])}::integer[])
  `;
  await sql`
    DELETE FROM competition.entry_event_pick_repairs
    WHERE season_id = ${SEASON_ID} AND entry_id = ANY(${sql.array([...ENTRY_IDS])}::integer[])
  `;
  await sql`
    DELETE FROM competition.tournament_entries
    WHERE season_id = ${SEASON_ID} AND tournament_id = ${TOURNAMENT_ID}
  `;
  await sql`DELETE FROM competition.tournaments WHERE tournament_id = ${TOURNAMENT_ID}`;
  await sql`
    DELETE FROM competition.entries
    WHERE season_id = ${SEASON_ID} AND entry_id = ANY(${[...ENTRY_IDS]}::integer[])
  `;
  await sql`DELETE FROM fpl.seasons WHERE season_id = ${SEASON_ID}`;
}

async function seed(): Promise<void> {
  const sql = await getDbClient();
  await cleanup();
  await sql`
    INSERT INTO fpl.seasons (
      season_id, season_code, display_name, start_year, end_year, lifecycle_state, is_current
    ) VALUES (
      ${SEASON_ID}, ${SEASON_CODE}, 'Roster publication integration',
      ${SEASON_ID}, ${SEASON_ID + 1}, 'active', true
    )
  `;
  await sql`
    INSERT INTO competition.entries (season_id, entry_id, entry_name, player_name)
    SELECT
      ${SEASON_ID}, entry_id, 'Existing Entry ' || entry_id::text,
      'Existing Manager ' || entry_id::text
    FROM unnest(${[...ENTRY_IDS.slice(0, 2)]}::integer[]) AS entries(entry_id)
  `;
  await sql`
    INSERT INTO competition.tournaments (
      tournament_id, season_id, name, creator, admin_entry_id, league_id, league_type,
      total_team_num, tournament_mode, group_mode, group_auto_averages, state,
      roster_mode, roster_sync_status, setup_status
    ) VALUES (
      ${TOURNAMENT_ID}, ${SEASON_ID}, 'Roster publication integration', 'integration-test',
      ${ENTRY_IDS[0]}, ${LEAGUE_ID}, 'h2h', 2, 'normal', 'no_group', false, 'active',
      'official_sync', 'processing', 'ready'
    )
  `;
  await sql`
    INSERT INTO competition.tournament_entries (tournament_id, season_id, league_id, entry_id)
    SELECT ${TOURNAMENT_ID}, ${SEASON_ID}, ${LEAGUE_ID}, entry_id
    FROM unnest(${[...ENTRY_IDS.slice(0, 2)]}::integer[]) AS entries(entry_id)
  `;
  await sql`UPDATE competition.tournaments SET roster_sync_execution_id=gen_random_uuid()
    WHERE season_id=${SEASON_ID} AND tournament_id=${TOURNAMENT_ID}`;
}

beforeEach(seed);
afterEach(cleanup);

describe('authoritative tournament roster publication', () => {
  test('replaces tournament-owned structure and publishes newly joined entries', async () => {
    const season = explicitSeasonRef(SEASON_CODE);
    const tournament = await tournamentRosterRepository.findById(season, TOURNAMENT_ID);
    expect(tournament).not.toBeNull();

    const result = await tournamentRosterRepository.publishAuthoritativeRoster(
      season,
      tournament!,
      ENTRY_IDS.map((entryId) => ({
        id: String(entryId),
        team: `Published Entry ${entryId}`,
        manager: `Published Manager ${entryId}`,
        overallRank: entryId,
        totalPoints: 0,
      })),
      'Published H2H League',
    );

    expect(result).toEqual({
      changed: true,
      participantCount: ENTRY_IDS.length,
      automaticallyPaused: false,
      skipped: false,
    });

    const sql = await getDbClient();
    const entries = await sql<Array<{ entry_id: number }>>`
      SELECT entry_id
      FROM competition.tournament_entries
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${TOURNAMENT_ID}
      ORDER BY entry_id
    `;
    expect(entries.map((entry) => entry.entry_id)).toEqual([...ENTRY_IDS]);

    const [published] = await sql<
      Array<{
        total_team_num: number;
        source_league_name: string | null;
        roster_sync_status: string | null;
        setup_status: string;
      }>
    >`
      SELECT total_team_num, source_league_name, roster_sync_status, setup_status
      FROM competition.tournaments
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${TOURNAMENT_ID}
    `;
    expect(published).toEqual({
      total_team_num: ENTRY_IDS.length,
      source_league_name: 'Published H2H League',
      roster_sync_status: 'ready',
      setup_status: 'pending',
    });
  });

  test('fences a ready official H2H roster before a recovery worker claims it', async () => {
    const season = explicitSeasonRef(SEASON_CODE);
    const sql = await getDbClient();
    await sql`
      UPDATE competition.tournaments
      SET group_mode = 'battle_races', roster_sync_status = 'ready'
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${TOURNAMENT_ID}
    `;

    const marker = await tournamentRosterRepository.prepareUnlockedOfficialH2HRecovery(
      season,
      TOURNAMENT_ID,
    );
    expect(marker).toBeString();

    const [prepared] = await sql<Array<{ rosterSyncStatus: string | null; marker: string | null }>>`
      SELECT
        roster_sync_status AS "rosterSyncStatus",
        setup_progress_updated_at::text AS marker
      FROM competition.tournaments
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${TOURNAMENT_ID}
    `;
    expect(prepared).toEqual({ rosterSyncStatus: 'failed', marker });
    expect(
      await tournamentRosterRepository.claimUnlockedOfficialH2HRecovery(
        season,
        TOURNAMENT_ID,
        marker!,
      ),
    ).toBe(true);
    expect(
      await tournamentRosterRepository.claimUnlockedOfficialH2HRecovery(
        season,
        TOURNAMENT_ID,
        marker!,
      ),
    ).toBe(false);
  });

  test('publishes an additive recovery inside its production mutation scope', async () => {
    const season = explicitSeasonRef(SEASON_CODE);
    const sql = await getDbClient();
    await sql`
      UPDATE competition.tournaments
      SET group_mode = 'battle_races', roster_sync_status = 'ready'
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${TOURNAMENT_ID}
    `;
    const marker = await tournamentRosterRepository.prepareUnlockedOfficialH2HRecovery(
      season,
      TOURNAMENT_ID,
    );
    expect(marker).toBeString();
    expect(
      await tournamentRosterRepository.claimUnlockedOfficialH2HRecovery(
        season,
        TOURNAMENT_ID,
        marker!,
      ),
    ).toBe(true);
    const tournament = await tournamentRosterRepository.findById(season, TOURNAMENT_ID);
    expect(tournament).not.toBeNull();

    const result = await withMutationScopes(
      {
        queueName: 'integration-test',
        jobName: 'publish-authoritative-roster',
        scopes: [`integration:tournament-roster:${TOURNAMENT_ID}`],
      },
      () =>
        tournamentRosterRepository.publishAuthoritativeRoster(
          season,
          tournament!,
          ENTRY_IDS.map((entryId) => ({
            id: String(entryId),
            team: `Recovered Entry ${entryId}`,
            manager: `Recovered Manager ${entryId}`,
            overallRank: entryId,
            totalPoints: 0,
          })),
          'Recovered H2H League',
          {
            expectedProgressMarker: marker,
            guardUnlockedOfficialH2HRecovery: true,
          },
        ),
    );
    expect(result.changed).toBe(true);
    expect(result.participantCount).toBe(ENTRY_IDS.length);
  });

  test('rejects guarded recovery removals inside the publication transaction', async () => {
    const season = explicitSeasonRef(SEASON_CODE);
    const sql = await getDbClient();
    const [prepared] = await sql<Array<{ marker: string }>>`
      UPDATE competition.tournaments
      SET group_mode = 'battle_races',
          roster_sync_status = 'processing',
          setup_progress_updated_at = now()
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${TOURNAMENT_ID}
      RETURNING setup_progress_updated_at::text AS marker
    `;
    const tournament = await tournamentRosterRepository.findById(season, TOURNAMENT_ID);
    expect(tournament).not.toBeNull();

    await expect(
      tournamentRosterRepository.publishAuthoritativeRoster(
        season,
        tournament!,
        [
          {
            id: String(ENTRY_IDS[0]),
            team: 'Removal Attempt',
            manager: 'Removal Attempt',
            overallRank: ENTRY_IDS[0],
            totalPoints: 0,
          },
        ],
        'Unsafe H2H League',
        {
          expectedProgressMarker: prepared!.marker,
          guardUnlockedOfficialH2HRecovery: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'TOURNAMENT_OFFICIAL_H2H_RECOVERY_NOT_ADDITIVE' });
  });

  test('rejects publication when the official schedule locks after recovery claim', async () => {
    const season = explicitSeasonRef(SEASON_CODE);
    const sql = await getDbClient();
    await sql`
      UPDATE competition.tournaments
      SET group_mode = 'battle_races', roster_sync_status = 'ready'
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${TOURNAMENT_ID}
    `;
    const marker = await tournamentRosterRepository.prepareUnlockedOfficialH2HRecovery(
      season,
      TOURNAMENT_ID,
    );
    expect(marker).toBeString();
    expect(
      await tournamentRosterRepository.claimUnlockedOfficialH2HRecovery(
        season,
        TOURNAMENT_ID,
        marker!,
      ),
    ).toBe(true);
    await sql`
      UPDATE competition.tournaments
      SET official_schedule_locked_at = now()
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${TOURNAMENT_ID}
    `;
    const tournament = await tournamentRosterRepository.findById(season, TOURNAMENT_ID);
    expect(tournament).not.toBeNull();

    await expect(
      tournamentRosterRepository.publishAuthoritativeRoster(
        season,
        tournament!,
        ENTRY_IDS.map((entryId) => ({
          id: String(entryId),
          team: `Late Entry ${entryId}`,
          manager: `Late Manager ${entryId}`,
          overallRank: entryId,
          totalPoints: 0,
        })),
        'Locked H2H League',
        {
          expectedProgressMarker: marker,
          guardUnlockedOfficialH2HRecovery: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'TOURNAMENT_OFFICIAL_H2H_RECOVERY_UNSAFE' });
  });
});

for (const phase of ['profile', 'transfers'] as const) {
  test(`roster ${phase} provider wait leaves entrant mutation scope available`, async () => {
    const { reconcileTournamentRoster } = await import(
      '../../src/services/tournament-roster.service'
    );
    const leagueMembers = await import('../../src/services/tournament-league-members.service');
    const backfill = await import('../../src/services/tournament-backfill.service');
    const { fplClient } = await import('../../src/clients/fpl');
    const { acquireMutationScopes } = await import('../../src/utils/mutation-scopes');
    const { tournamentEntryCoreScopes } = await import('../../src/domain/mutation-scope');
    const postgres = (await import('postgres')).default;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldTransaction = false;
    const failProvider = async (): Promise<never> => {
      heldTransaction = databaseTransactionStorage.getStore() !== undefined;
      enter();
      await released;
      throw new Error('owned provider failure');
    };
    const league = spyOn(leagueMembers, 'fetchLeagueParticipants').mockResolvedValue({
      leagueId: LEAGUE_ID,
      leagueType: 'h2h',
      leagueName: 'Fixture',
      startEventId: 1,
      knockoutRounds: 0,
      participants: ENTRY_IDS.map((id) => ({
        id: String(id),
        team: 'Fixture',
        manager: 'Fixture',
        overallRank: 1,
        totalPoints: 0,
      })),
    });
    const profiles =
      phase === 'transfers'
        ? spyOn(backfill, 'syncTournamentEntryDetails').mockResolvedValue([])
        : undefined;
    const provider =
      phase === 'profile'
        ? spyOn(fplClient, 'getEntrySummary').mockImplementation(failProvider)
        : spyOn(fplClient, 'getEntryTransfers').mockImplementation(failProvider);
    const history = spyOn(fplClient, 'getEntryHistory').mockResolvedValue({
      current: [],
      past: [],
      chips: [],
    });
    const work = reconcileTournamentRoster(explicitSeasonRef(SEASON_CODE), TOURNAMENT_ID).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await Promise.race([
        entered,
        work.then(() => {
          throw new Error('Reconciliation ended before provider');
        }),
      ]);
      expect(heldTransaction).toBe(false);
      // A separate database session can acquire this same entry's canonical
      // mutation lock while the reconciliation is waiting on its provider.
      await sql.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '250ms'`;
        await acquireMutationScopes(tx, tournamentEntryCoreScopes(SEASON_ID, [ENTRY_IDS[2]]));
      });
      release();
      expect(await work).toBeInstanceOf(Error);
      const [saved] =
        await sql`SELECT count(*)::integer AS count FROM competition.tournament_entries
        WHERE season_id=${SEASON_ID} AND tournament_id=${TOURNAMENT_ID}`;
      expect(saved!.count).toBe(2);
    } finally {
      release();
      await work;
      league.mockRestore();
      profiles?.mockRestore();
      provider.mockRestore();
      history.mockRestore();
      await sql`DELETE FROM ops.mutation_scopes WHERE scope_key = ANY(${tournamentEntryCoreScopes(SEASON_ID, [ENTRY_IDS[2]])}::text[])`;
      await sql.end();
    }
  }, 15000);
}

test('core result backfill enters provider work without holding the batch scope', async () => {
  const { ensureTournamentCoreResults } = await import(
    '../../src/services/tournament-backfill.service'
  );
  const eventResults = await import('../../src/services/tournament-event-results.service');
  const { acquireMutationScopes } = await import('../../src/utils/mutation-scopes');
  const { tournamentEntryCoreScopes } = await import('../../src/domain/mutation-scope');
  const postgres = (await import('postgres')).default;
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const failure = new Error('owned backfill provider failure');
  const provider = spyOn(eventResults, 'syncTournamentEventResultsForEntryIds').mockImplementation(
    async () => {
      expect(databaseTransactionStorage.getStore()).toBeUndefined();
      await sql.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '250ms'`;
        await acquireMutationScopes(tx, tournamentEntryCoreScopes(SEASON_ID, [ENTRY_IDS[0]]));
      });
      throw failure;
    },
  );
  try {
    await expect(
      ensureTournamentCoreResults(explicitSeasonRef(SEASON_CODE), [ENTRY_IDS[0]], {
        startEventId: 1,
        endEventId: 1,
      }),
    ).rejects.toBe(failure);
  } finally {
    provider.mockRestore();
    await sql`DELETE FROM ops.mutation_scopes WHERE scope_key = ANY(${tournamentEntryCoreScopes(SEASON_ID, [ENTRY_IDS[0]])}::text[])`;
    await sql.end();
  }
});

for (const resume of [false, true]) {
  test(`an older ${resume ? 'resume' : 'normal'} execution cannot publish or fail a newer claim`, async () => {
    const season = explicitSeasonRef(SEASON_CODE);
    const sql = await getDbClient();
    let marker: string | null = null;
    if (resume) {
      await sql`UPDATE competition.tournaments SET state='inactive'
        WHERE season_id=${SEASON_ID} AND tournament_id=${TOURNAMENT_ID}`;
      marker = await tournamentRosterRepository.markResumeProcessingWithMarker(
        season,
        TOURNAMENT_ID,
      );
    }
    const old = (await tournamentRosterRepository.findById(season, TOURNAMENT_ID))!;
    const claimed = resume
      ? await tournamentRosterRepository.markResumeProcessingIfPending(
          season,
          TOURNAMENT_ID,
          marker!,
        )
      : await tournamentRosterRepository.markSyncProcessingIfMarker(season, TOURNAMENT_ID, marker);
    expect(claimed).toBe(true);
    const current = (await tournamentRosterRepository.findById(season, TOURNAMENT_ID))!;
    expect(current.executionId).not.toBe(old.executionId);
    expect(current.setupProgressUpdatedAt).toBe(old.setupProgressUpdatedAt);
    const participants = ENTRY_IDS.slice(0, 2).map((id) => ({
      id: String(id),
      team: 'Fixture',
      manager: 'Fixture',
      overallRank: 1,
      totalPoints: 0,
    }));
    const options = resume
      ? { allowInactive: true, resumeAfterSetup: true, resumeMarker: marker! }
      : undefined;
    expect(
      (
        await tournamentRosterRepository.publishAuthoritativeRoster(
          season,
          old,
          participants,
          'Stale',
          options,
        )
      ).skipped,
    ).toBe(true);
    expect(
      await tournamentRosterRepository.markSyncFailedIfOwned(
        season,
        TOURNAMENT_ID,
        old,
        'stale failure',
      ),
    ).toBe(false);
    expect((await tournamentRosterRepository.findById(season, TOURNAMENT_ID))!.executionId).toBe(
      current.executionId,
    );
    expect(
      (
        await tournamentRosterRepository.publishAuthoritativeRoster(
          season,
          current,
          participants,
          'Current',
          options,
        )
      ).skipped,
    ).toBe(false);
    expect(
      await tournamentRosterRepository.markSyncFailedIfOwned(
        season,
        TOURNAMENT_ID,
        current,
        'current execution failure after publication',
      ),
    ).toBe(resume);
  });
}

for (const failure of [false, true]) {
  test(`reconciliation ${failure ? 'failure' : 'publication'} preserves state written during its provider wait`, async () => {
    const { reconcileTournamentRoster } = await import(
      '../../src/services/tournament-roster.service'
    );
    const leagueMembers = await import('../../src/services/tournament-league-members.service');
    const { spyOn } = await import('bun:test');
    const { databaseTransactionStorage } = await import('../../src/db/singleton');
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const providerFailure = new Error('owned provider failure');
    let providerHeldTransaction = false;
    const provider = spyOn(leagueMembers, 'fetchLeagueParticipants').mockImplementation(
      async () => {
        providerHeldTransaction = databaseTransactionStorage.getStore() !== undefined;
        enter();
        await released;
        if (failure) throw providerFailure;
        return {
          leagueId: LEAGUE_ID,
          leagueType: 'h2h',
          leagueName: 'Fixture',
          startEventId: 1,
          knockoutRounds: 0,
          participants: ENTRY_IDS.slice(0, 2).map((id) => ({
            id: String(id),
            team: 'Fixture',
            manager: 'Fixture',
            overallRank: 1,
            totalPoints: 0,
          })),
        };
      },
    );
    const season = explicitSeasonRef(SEASON_CODE);
    const work = reconcileTournamentRoster(season, TOURNAMENT_ID).then(
      (value) => value,
      (error: unknown) => error,
    );
    try {
      await Promise.race([
        entered,
        work.then(() => {
          throw new Error('Provider not reached');
        }),
      ]);
      expect(providerHeldTransaction).toBe(false);
      const sql = await getDbClient();
      await sql`UPDATE competition.tournaments SET roster_sync_status='ready', setup_status='ready',
        source_league_name='Newer accepted state', updated_at=now()
        WHERE season_id=${SEASON_ID} AND tournament_id=${TOURNAMENT_ID}`;
      const current = (await tournamentRosterRepository.findById(season, TOURNAMENT_ID))!;
      release();
      const result = await work;
      if (failure) expect(result).toBe(providerFailure);
      else expect(result).toMatchObject({ changed: false, participantCount: 2 });
      const saved = (await tournamentRosterRepository.findById(season, TOURNAMENT_ID))!;
      expect(saved.executionId).toBe(current.executionId);
      expect(saved.rosterSyncStatus).toBe('ready');
      expect(saved.setupStatus).toBe('ready');
    } finally {
      release();
      await work;
      provider.mockRestore();
      const sql = await getDbClient();
      await sql`DELETE FROM ops.mutation_scopes WHERE scope_key = ANY(${[
        `tournament-setup:tournament:${TOURNAMENT_ID}`,
        `tournament-structure:tournament:${TOURNAMENT_ID}`,
      ]}::text[])`;
    }
  }, 15000);
}

for (const missingCheckpoint of [false, true]) {
  test(`a superseded profile ${missingCheckpoint ? 'still reports a missing target checkpoint' : 'converges on the committed target checkpoint'}`, async () => {
    const { syncTournamentEntryDetails } = await import(
      '../../src/services/tournament-backfill.service'
    );
    const { syncEntryInfo } = await import('../../src/services/entry-info.service');
    const { recordedEntrySummary } = await import('../fixtures/entry-info.fixtures');
    const { fplClient } = await import('../../src/clients/fpl');
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const summary = (id: number, name: string) => ({
      ...structuredClone(recordedEntrySummary),
      id,
      name,
      leagues: { classic: [], h2h: [] },
    });
    const oldProvider = spyOn(fplClient, 'getEntrySummary').mockImplementation(async (id) => {
      enter();
      await released;
      return summary(id, 'Older profile');
    });
    const history = spyOn(fplClient, 'getEntryHistory').mockResolvedValue({
      current: [],
      past: [],
      chips: [],
    });
    const season = explicitSeasonRef(SEASON_CODE);
    const work = syncTournamentEntryDetails(season, [ENTRY_IDS[2]], { targetEventId: 0 });
    try {
      await entered;
      await syncEntryInfo(
        season,
        ENTRY_IDS[2],
        {
          getEntrySummary: async (id) => summary(id, 'Newer profile'),
          getEntryHistory: async () => ({ current: [], past: [], chips: [] }),
        },
        0,
      );
      const sql = await getDbClient();
      if (missingCheckpoint)
        await sql`UPDATE competition.entries SET snapshot_synced_through_event_id=NULL
        WHERE season_id=${SEASON_ID} AND entry_id=${ENTRY_IDS[2]}`;
      release();
      const issues = await work;
      expect(issues.length).toBe(missingCheckpoint ? 1 : 0);
      const [saved] = await sql`SELECT entry_name FROM competition.entries
        WHERE season_id=${SEASON_ID} AND entry_id=${ENTRY_IDS[2]}`;
      expect(saved!.entry_name).toBe('Newer profile');
    } finally {
      release();
      await work;
      oldProvider.mockRestore();
      history.mockRestore();
      const sql = await getDbClient();
      await sql`DELETE FROM ops.mutation_scopes WHERE scope_key=${`entry-core:${SEASON_ID}:${ENTRY_IDS[2]}`}`;
    }
  }, 15000);
}

for (const resume of [false, true]) {
  test(`the current ${resume ? 'resume' : 'normal'} execution still records its provider failure`, async () => {
    const { reconcileTournamentRoster } = await import(
      '../../src/services/tournament-roster.service'
    );
    const leagueMembers = await import('../../src/services/tournament-league-members.service');
    const failure = new Error('current execution provider failure');
    const provider = spyOn(leagueMembers, 'fetchLeagueParticipants').mockRejectedValue(failure);
    const season = explicitSeasonRef(SEASON_CODE);
    const sql = await getDbClient();
    let marker: string | undefined;
    if (resume) {
      await sql`UPDATE competition.tournaments SET state='inactive'
        WHERE season_id=${SEASON_ID} AND tournament_id=${TOURNAMENT_ID}`;
      marker = await tournamentRosterRepository.markResumeProcessingWithMarker(
        season,
        TOURNAMENT_ID,
      );
    }
    try {
      await expect(
        reconcileTournamentRoster(
          season,
          TOURNAMENT_ID,
          resume
            ? {
                allowInactive: true,
                resumeAfterSetup: true,
                requireResumeMarker: true,
                resumeMarker: marker,
              }
            : undefined,
        ),
      ).rejects.toBe(failure);
      const saved = (await tournamentRosterRepository.findById(season, TOURNAMENT_ID))!;
      expect(saved.rosterSyncStatus).toBe('failed');
      expect(saved.setupStatus).toBe(resume ? 'failed' : 'ready');
      if (resume) expect(saved.setupProgressUpdatedAt).toBe(marker!);
    } finally {
      provider.mockRestore();
      await sql`DELETE FROM ops.mutation_scopes WHERE scope_key=${`tournament-setup:tournament:${TOURNAMENT_ID}`}`;
    }
  });
}

test('a current execution can settle an enqueue failure after its roster publication commits', async () => {
  const { reconcileTournamentRoster } = await import(
    '../../src/services/tournament-roster.service'
  );
  const leagueMembers = await import('../../src/services/tournament-league-members.service');
  const setupJobs = await import('../../src/jobs/tournament-setup.jobs');
  const failure = new Error('owned enqueue failure');
  const enqueue = spyOn(setupJobs, 'enqueueTournamentSetup').mockRejectedValue(failure);
  const provider = spyOn(leagueMembers, 'fetchLeagueParticipants').mockResolvedValue({
    leagueId: LEAGUE_ID,
    leagueType: 'h2h',
    leagueName: 'Fixture',
    startEventId: 1,
    knockoutRounds: 0,
    participants: ENTRY_IDS.slice(0, 2).map((id) => ({
      id: String(id),
      team: 'Fixture',
      manager: 'Fixture',
      overallRank: 1,
      totalPoints: 0,
    })),
  });
  const season = explicitSeasonRef(SEASON_CODE);
  try {
    await expect(reconcileTournamentRoster(season, TOURNAMENT_ID)).rejects.toBe(failure);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const saved = (await tournamentRosterRepository.findById(season, TOURNAMENT_ID))!;
    expect(saved.rosterSyncStatus).toBe('failed');
    expect(saved.setupStatus).toBe('failed');
  } finally {
    enqueue.mockRestore();
    provider.mockRestore();
    const sql = await getDbClient();
    await sql`DELETE FROM ops.mutation_scopes WHERE scope_key = ANY(${[
      `tournament-setup:tournament:${TOURNAMENT_ID}`,
      `tournament-structure:tournament:${TOURNAMENT_ID}`,
    ]}::text[])`;
  }
});

for (const resume of [false, true])
  for (const fails of [false, true]) {
    test(`rename during ${resume ? 'resume' : 'normal'} provider work preserves ${fails ? 'failure settlement' : 'publication and setup enqueue'}`, async () => {
      const { reconcileTournamentRoster } = await import(
        '../../src/services/tournament-roster.service'
      );
      const { tournamentManagementRepository } = await import(
        '../../src/repositories/tournament-management'
      );
      const leagueMembers = await import('../../src/services/tournament-league-members.service');
      const setupJobs = await import('../../src/jobs/tournament-setup.jobs');
      let enqueuedOptions: Parameters<typeof setupJobs.enqueueTournamentSetup>[3] | undefined;
      const enqueue = spyOn(setupJobs, 'enqueueTournamentSetup').mockImplementation(
        async (_season, _id, _source, options) => {
          expect(Boolean(databaseTransactionStorage.getStore())).toBe(false);
          enqueuedOptions = options;
          return undefined as never;
        },
      );
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const failure = new Error('owned provider failure after rename');
      const provider = spyOn(leagueMembers, 'fetchLeagueParticipants').mockImplementation(
        async () => {
          enter();
          await released;
          if (fails) throw failure;
          return {
            leagueId: LEAGUE_ID,
            leagueType: 'h2h',
            leagueName: 'Fixture',
            startEventId: 1,
            knockoutRounds: 0,
            participants: ENTRY_IDS.slice(0, 2).map((id) => ({
              id: String(id),
              team: 'Fixture',
              manager: 'Fixture',
              overallRank: 1,
              totalPoints: 0,
            })),
          };
        },
      );
      const season = explicitSeasonRef(SEASON_CODE);
      const sql = await getDbClient();
      let marker: string | undefined;
      if (resume) {
        await sql`UPDATE competition.tournaments SET state='inactive'
        WHERE season_id=${SEASON_ID} AND tournament_id=${TOURNAMENT_ID}`;
        marker = await tournamentRosterRepository.markResumeProcessingWithMarker(
          season,
          TOURNAMENT_ID,
        );
      }
      const work = reconcileTournamentRoster(
        season,
        TOURNAMENT_ID,
        resume
          ? {
              allowInactive: true,
              resumeAfterSetup: true,
              requireResumeMarker: true,
              resumeMarker: marker,
            }
          : undefined,
      ).then(
        (value) => value,
        (error: unknown) => error,
      );
      try {
        await Promise.race([
          entered,
          work.then(() => {
            throw new Error('Provider not reached');
          }),
        ]);
        const before = (await tournamentRosterRepository.findById(season, TOURNAMENT_ID))!;
        expect(
          await tournamentManagementRepository.updateNameOwned(
            season,
            TOURNAMENT_ID,
            ENTRY_IDS[0],
            'Renamed during provider',
          ),
        ).not.toBeNull();
        expect(
          (await tournamentRosterRepository.findById(season, TOURNAMENT_ID))!.executionId,
        ).toBe(before.executionId);
        release();
        const result = await work;
        if (fails) expect(result).toBe(failure);
        else expect(result).toMatchObject({ changed: false, participantCount: 2 });
        expect(enqueue).toHaveBeenCalledTimes(fails ? 0 : 1);
        const saved = (await tournamentRosterRepository.findById(season, TOURNAMENT_ID))!;
        if (!fails) {
          if (resume) {
            expect(enqueuedOptions).toMatchObject({ resumeMarker: marker });
            expect(enqueuedOptions?.setupMarker).toBeUndefined();
          } else {
            expect(enqueuedOptions?.setupMarker).toBe(saved.setupProgressUpdatedAt ?? undefined);
            expect(enqueuedOptions?.resumeMarker).toBeUndefined();
          }
        }
        expect(saved.rosterSyncStatus).toBe(fails ? 'failed' : resume ? 'processing' : 'ready');
        const [name] =
          await sql`SELECT name FROM competition.tournaments WHERE season_id=${SEASON_ID} AND tournament_id=${TOURNAMENT_ID}`;
        expect(name!.name).toBe('Renamed during provider');
      } finally {
        release();
        await work;
        provider.mockRestore();
        enqueue.mockRestore();
        await sql`DELETE FROM ops.mutation_scopes WHERE scope_key = ANY(${[
          `tournament-setup:tournament:${TOURNAMENT_ID}`,
          `tournament-structure:tournament:${TOURNAMENT_ID}`,
        ]}::text[])`;
      }
    }, 15000);
  }
