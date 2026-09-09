import { assertIntegrationEnv } from './helpers/env-guard';
assertIntegrationEnv();
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import postgres from 'postgres';
import { explicitSeasonRef } from '../../src/domain/fpl-season';
import {
  entryEventCupResultsRepository as repository,
  type EntryEventCupResultInput,
} from '../../src/repositories/entry-event-cup-results';
const season = explicitSeasonRef('9798');
const entryId = 995_701;
const eventId = 17;
const sql = postgres(process.env.DATABASE_URL!, { max: 2 });
async function cleanup() {
  await sql`DELETE FROM competition.entry_event_cup_results WHERE season_id=${season.seasonId}`;
  await sql`DELETE FROM competition.entries WHERE season_id=${season.seasonId}`;
  await sql`DELETE FROM fpl.events WHERE season_id=${season.seasonId}`;
  await sql`DELETE FROM fpl.seasons WHERE season_id=${season.seasonId}`;
}
beforeEach(async () => {
  await cleanup();
  await sql`INSERT INTO fpl.seasons (season_id,season_code,display_name,start_year,end_year,lifecycle_state) VALUES (${season.seasonId},${season.seasonCode},'Cup fixture',2097,2098,'reference_only')`;
  await sql`INSERT INTO fpl.events (season_id,event_id,name) VALUES (${season.seasonId},${eventId},'Cup GW17')`;
  await sql`INSERT INTO competition.entries (season_id,entry_id,entry_name,player_name) VALUES (${season.seasonId},${entryId},'Fixture','Fixture')`;
});
afterEach(async () => {
  mock.restore();
  await cleanup();
});
afterAll(() => sql.end());
function record(points: number): EntryEventCupResultInput {
  return {
    entryId,
    eventId,
    opponentEntryId: null,
    opponentName: null,
    result: 'win',
    entryPoints: points,
    opponentPoints: 0,
    entryName: 'Fixture',
    playerName: 'Fixture',
    againstEntryName: null,
    againstPlayerName: null,
    eventPoints: points,
    againstEntryId: null,
    againstEventPoints: 0,
  };
}
for (const existing of [false, true]) {
  test(`a slower Cup attempt cannot overwrite a newer ${existing ? 'replacement' : 'first publication'}`, async () => {
    if (existing) await repository.replaceBatch(season, [record(1)], new Map());
    const old = await repository.findRevisions(season, eventId, [entryId]);
    await repository.replaceBatch(season, [record(20)], old);
    await expect(repository.replaceBatch(season, [record(10)], old)).rejects.toMatchObject({
      code: 'CUP_RESULT_SOURCE_STALE',
    });
    const [row] =
      await sql`SELECT entry_points FROM competition.entry_event_cup_results WHERE season_id=${season.seasonId} AND entry_id=${entryId}`;
    expect(row!.entry_points).toBe(20);
  });
}

test('the Cup worker calls the provider without an open mutation transaction and rejects a superseded response', async () => {
  const { processTournamentSyncJob } = await import('../../src/workers/tournament-sync.worker');
  const seasonJobs = await import('../../src/services/season-scoped-job.service');
  const { tournamentInfoRepository } = await import('../../src/repositories/tournament-infos');
  const { tournamentEntryRepository } = await import('../../src/repositories/tournament-entries');
  const { fplClient } = await import('../../src/clients/fpl');
  const { getDbClient } = await import('../../src/db/singleton');
  spyOn(seasonJobs, 'requireCurrentSeasonForJob').mockResolvedValue(season);
  spyOn(tournamentInfoRepository, 'findActive').mockResolvedValue([{ id: entryId }] as never);
  spyOn(tournamentEntryRepository, 'findEntryIdsByTournamentId').mockResolvedValue([entryId]);
  spyOn(fplClient, 'getEntryCup').mockImplementation(async () => {
    // Root clients expose begin; mutation TransactionSql does not. The real
    // competing publication also exercises the repository's database fence.
    expect(typeof (await getDbClient()).begin).toBe('function');
    await repository.replaceBatch(season, [record(20)], new Map());
    return {
      cup_matches: [
        {
          event: eventId,
          entry_1_entry: entryId,
          entry_2_entry: null,
          entry_1_points: 10,
          entry_2_points: 0,
          winner: entryId,
        },
      ],
    } as never;
  });
  await expect(
    processTournamentSyncJob({
      id: 'integration-cup-short',
      name: 'tournament-cup-results',
      queueName: 'tournament-sync',
      attemptsMade: 0,
      timestamp: Date.now(),
      opts: {},
      data: { ...season, eventId, source: 'manual' },
    } as never),
  ).rejects.toMatchObject({ code: 'CUP_RESULT_SOURCE_STALE' });
  const [row] =
    await sql`SELECT entry_points FROM competition.entry_event_cup_results WHERE season_id=${season.seasonId} AND entry_id=${entryId}`;
  expect(row!.entry_points).toBe(20);
});

test('Cup completion advances the cascade only after its result transaction commits', async () => {
  const { processTournamentSyncJob } = await import('../../src/workers/tournament-sync.worker');
  const seasonJobs = await import('../../src/services/season-scoped-job.service');
  const jobs = await import('../../src/jobs/tournament-sync.jobs');
  const { tournamentInfoRepository } = await import('../../src/repositories/tournament-infos');
  const { tournamentEntryRepository } = await import('../../src/repositories/tournament-entries');
  const { fplClient } = await import('../../src/clients/fpl');
  const { getDbClient } = await import('../../src/db/singleton');
  spyOn(seasonJobs, 'requireCurrentSeasonForJob').mockResolvedValue(season);
  spyOn(tournamentInfoRepository, 'findActive').mockResolvedValue([{ id: entryId }] as never);
  spyOn(tournamentEntryRepository, 'findEntryIdsByTournamentId').mockResolvedValue([entryId]);
  spyOn(fplClient, 'getEntryCup').mockResolvedValue({
    cup_matches: [
      {
        event: eventId,
        entry_1_entry: entryId,
        entry_2_entry: null,
        entry_1_points: 10,
        entry_2_points: 0,
        winner: entryId,
      },
    ],
  } as never);
  const handoffFailure = new Error('injected post-commit handoff failure');
  const handoff = spyOn(jobs, 'noteCascadeStructureJobComplete').mockImplementation(async () => {
    expect(typeof (await getDbClient()).begin).toBe('function');
    const [row] =
      await sql`SELECT entry_points FROM competition.entry_event_cup_results WHERE season_id=${season.seasonId} AND entry_id=${entryId}`;
    expect(row!.entry_points).toBe(10);
    throw handoffFailure;
  });
  await expect(
    processTournamentSyncJob({
      id: 'integration-cup-handoff',
      name: 'tournament-cup-results',
      queueName: 'tournament-sync',
      attemptsMade: 0,
      timestamp: Date.now(),
      opts: {},
      data: { ...season, eventId, source: 'manual', cascadeId: 'integration-cup-handoff' },
    } as never),
  ).rejects.toBe(handoffFailure);
  expect(handoff).toHaveBeenCalledTimes(1);
});

for (const failureMode of ['provider', 'later-batch-conflict'] as const) {
  test(`Cup preserves earlier results on ${failureMode}`, async () => {
    const { syncTournamentEventCupResults } = await import(
      '../../src/services/tournament-event-cup-results.service'
    );
    const { tournamentInfoRepository } = await import('../../src/repositories/tournament-infos');
    const { tournamentEntryRepository } = await import('../../src/repositories/tournament-entries');
    const { fplClient } = await import('../../src/clients/fpl');
    const entrants = Array.from({ length: 27 }, (_, index) => entryId + index);
    await sql`INSERT INTO competition.entries (season_id,entry_id,entry_name,player_name) SELECT ${season.seasonId}, id, 'Fixture', 'Fixture' FROM unnest(${entrants.slice(1)}::int[]) AS id`;
    await repository.replaceBatch(
      season,
      entrants.map((id) => ({ ...record(1), entryId: id })),
      new Map(),
    );
    const revisions = await repository.findRevisions(season, eventId, entrants);
    spyOn(tournamentInfoRepository, 'findActive').mockResolvedValue([{ id: entryId }] as never);
    spyOn(tournamentEntryRepository, 'findEntryIdsByTournamentId').mockResolvedValue(entrants);
    const lastEntryId = entrants.at(-1)!;
    spyOn(fplClient, 'getEntryCup').mockImplementation(async (id) => {
      if (id === lastEntryId) {
        if (failureMode === 'provider') throw new Error('last provider failed');
        await repository.replaceBatch(season, [{ ...record(20), entryId: id }], revisions);
      }
      return {
        cup_matches: [
          {
            event: eventId,
            entry_1_entry: id,
            entry_2_entry: null,
            entry_1_points: 10,
            entry_2_points: 0,
            winner: id,
          },
        ],
      } as never;
    });
    await expect(syncTournamentEventCupResults(season, eventId)).rejects.toMatchObject({
      code: failureMode === 'provider' ? 'DATA_SYNC_INCOMPLETE' : 'CUP_RESULT_SOURCE_STALE',
    });
    const rows =
      await sql`SELECT entry_id,entry_points FROM competition.entry_event_cup_results WHERE season_id=${season.seasonId} ORDER BY entry_id`;
    expect(rows).toHaveLength(27);
    expect(rows.slice(0, 26).every((row) => row.entry_points === 1)).toBe(true);
    expect(rows.at(-1)!.entry_points).toBe(failureMode === 'provider' ? 1 : 20);
  });
}
