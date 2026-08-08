import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { expect, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from '../../src/db/schemas/index.schema';
import { prepareCoreSnapshot } from '../../src/domain/core-snapshot';
import type { TournamentStructurePlan } from '../../src/domain/tournament';
import { createEntryEventCupResultsRepository } from '../../src/repositories/entry-event-cup-results';
import { createEntryEventPicksRepository } from '../../src/repositories/entry-event-picks';
import { createEntryEventResultsRepository } from '../../src/repositories/entry-event-results';
import { createEntryEventTransfersRepository } from '../../src/repositories/entry-event-transfers';
import { createEntryHistoryInfoRepository } from '../../src/repositories/entry-history-infos';
import { createEntryInfoRepository } from '../../src/repositories/entry-infos';
import { createEntryLeagueInfoRepository } from '../../src/repositories/entry-league-infos';
import { createLeagueEventResultsRepository } from '../../src/repositories/league-event-results';
import { createPlayerMarketSnapshotsRepository } from '../../src/repositories/player-market-snapshots';
import { createPlayerStatsRepository } from '../../src/repositories/player-stats';
import { createTournamentBattleGroupResultsRepository } from '../../src/repositories/tournament-battle-group-results';
import { createTournamentGroupRepository } from '../../src/repositories/tournament-groups';
import { createTournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { createTournamentKnockoutResultsRepository } from '../../src/repositories/tournament-knockout-results';
import { createTournamentKnockoutsRepository } from '../../src/repositories/tournament-knockouts';
import { createTournamentPointsGroupResultsRepository } from '../../src/repositories/tournament-points-group-results';
import { persistCoreSnapshot } from '../../src/services/core-snapshot-persistence.service';
import {
  persistPreparedEventLives,
  prepareEventLives,
} from '../../src/services/event-lives.service';
import { transformPlayerMarketSnapshots } from '../../src/transformers/player-market-snapshots';
import { buildCoreSnapshotFixture } from '../fixtures/core-snapshot.fixtures';
import { recordedEntrySummary } from '../fixtures/entry-info.fixtures';
import { rawExplainElementsFixture } from '../fixtures/event-live-explains.fixtures';
import { transformedPlayerStatsFixture } from '../fixtures/player-stats.fixtures';

import type {
  RawFPLEntryEventPicksResponse,
  RawFPLEntrySummary,
  RawFPLEntryTransfersResponse,
} from '../../src/types';

const SCHEMA_EXPORT_DATABASE_URL = process.env.SCHEMA_EXPORT_DATABASE_URL;
const persistenceTest =
  process.env.RUN_SCHEMA_DECLARATION_PARITY === '1' && SCHEMA_EXPORT_DATABASE_URL
    ? test
    : test.skip;

type RelationCount = { relation: string; rows: number };

async function clearFixtureSeason(client: postgres.Sql): Promise<void> {
  await client.begin(async (transaction) => {
    await transaction`DELETE FROM competition.tournament_battle_group_results WHERE season_id = 2026`;
    await transaction`DELETE FROM competition.tournament_points_group_results WHERE season_id = 2026`;
    await transaction`DELETE FROM competition.tournament_knockout_results WHERE season_id = 2026`;
    await transaction`DELETE FROM competition.tournament_groups WHERE season_id = 2026`;
    await transaction`DELETE FROM competition.tournament_knockouts WHERE season_id = 2026`;
    await transaction`DELETE FROM competition.tournament_entries WHERE season_id = 2026`;
    await transaction`DELETE FROM competition.tournaments WHERE season_id = 2026`;
    await transaction`DELETE FROM competition.entry_event_cup_results WHERE season_id = 2026`;
    await transaction`DELETE FROM competition.entry_event_transfers WHERE season_id = 2026`;
    await transaction`DELETE FROM competition.entry_event_picks WHERE season_id = 2026`;
    await transaction`DELETE FROM competition.entry_event_results WHERE season_id = 2026`;
    await transaction`DELETE FROM competition.league_event_results WHERE season_id = 2026`;
    await transaction`DELETE FROM competition.entry_leagues WHERE season_id = 2026`;
    await transaction`DELETE FROM competition.entry_season_histories WHERE season_id = 2026`;
    await transaction`
      DELETE FROM competition.entry_season_histories
      WHERE season_id = 2025 AND entry_id IN (70001, 70002)
    `;
    await transaction`DELETE FROM competition.entries WHERE season_id = 2026`;
    await transaction`DELETE FROM fpl.player_fixture_stats WHERE season_id = 2026`;
    await transaction`DELETE FROM fpl.player_gameweek_scoring_items WHERE season_id = 2026`;
    await transaction`DELETE FROM fpl.player_gameweek_stats WHERE season_id = 2026`;
    await transaction`DELETE FROM fpl.player_event_snapshots WHERE season_id = 2026`;
    await transaction`DELETE FROM fpl.player_market_snapshots WHERE season_id = 2026`;
    await transaction`DELETE FROM fpl.fixtures WHERE season_id = 2026`;
    await transaction`DELETE FROM fpl.phases WHERE season_id = 2026`;
    await transaction`DELETE FROM fpl.players WHERE season_id = 2026`;
    await transaction`DELETE FROM fpl.teams WHERE season_id = 2026`;
    await transaction`DELETE FROM fpl.events WHERE season_id = 2026`;
    await transaction`DELETE FROM fpl.seasons WHERE season_id IN (2025, 2026)`;
  });
  await client`REFRESH MATERIALIZED VIEW reporting.tournament_selection_stats`;
}

async function readCoreCounts(client: postgres.Sql): Promise<RelationCount[]> {
  const rows = await client<RelationCount[]>`
    SELECT 'events' AS relation, count(*)::integer AS rows
    FROM fpl.events WHERE season_id = 2026
    UNION ALL
    SELECT 'fixtures', count(*)::integer
    FROM fpl.fixtures WHERE season_id = 2026
    UNION ALL
    SELECT 'phases', count(*)::integer
    FROM fpl.phases WHERE season_id = 2026
    UNION ALL
    SELECT 'players', count(*)::integer
    FROM fpl.players WHERE season_id = 2026
    UNION ALL
    SELECT 'teams', count(*)::integer
    FROM fpl.teams WHERE season_id = 2026
    ORDER BY relation
  `;
  return rows.map((row) => ({ ...row }));
}

function buildEntrySummary(entryId: number): RawFPLEntrySummary {
  return {
    ...recordedEntrySummary,
    id: entryId,
    name: `Runtime Entry ${entryId}`,
    player_first_name: 'Runtime',
    player_last_name: String(entryId),
  };
}

function buildPicks(eventId: number): RawFPLEntryEventPicksResponse {
  return {
    active_chip: null,
    automatic_subs: [],
    entry_history: {
      event: eventId,
      points: 60,
      total_points: 60,
      rank: 100,
      overall_rank: 1_000,
      bank: 10,
      value: 1_000,
      event_transfers: 0,
      event_transfers_cost: 0,
      points_on_bench: 5,
    },
    picks: Array.from({ length: 15 }, (_, index) => ({
      element: index + 1,
      position: index + 1,
      multiplier: index === 0 ? 2 : index < 11 ? 1 : 0,
      is_captain: index === 0,
      is_vice_captain: index === 1,
    })),
  };
}

function buildTournamentPlan(entryIds: readonly number[]): TournamentStructurePlan {
  return {
    leagueId: 90_001,
    leagueType: 'classic',
    sourceLeagueName: 'Runtime Contract League',
    rosterMode: 'snapshot',
    tournamentName: 'Runtime Contract Cup',
    creator: 'Runtime Contract',
    adminEntryId: entryIds[0],
    selectedParticipants: entryIds.map((entryId) => ({
      id: String(entryId),
      team: `Runtime Entry ${entryId}`,
      manager: `Runtime ${entryId}`,
      overallRank: 1_000 + entryId,
      totalPoints: 60,
    })),
    groupMode: 'points_races',
    groupTeamNum: entryIds.length,
    groupNum: 1,
    groupStartedEventId: 1,
    groupEndedEventId: 1,
    groupRounds: 1,
    groupQualifyNum: entryIds.length,
    knockoutMode: 'single_elimination',
    knockoutTeamNum: entryIds.length,
    knockoutEventNum: 1,
    knockoutRounds: 1,
    knockoutStartedEventId: 1,
    knockoutEndedEventId: 1,
    knockoutPlayAgainstNum: 1,
  };
}

persistenceTest(
  'rolls back an incomplete core write, then persists one idempotent unified-season snapshot',
  async () => {
    if (!SCHEMA_EXPORT_DATABASE_URL) {
      throw new Error('SCHEMA_EXPORT_DATABASE_URL is required for core persistence acceptance');
    }
    if (!/localhost|127\.0\.0\.1|_test/i.test(SCHEMA_EXPORT_DATABASE_URL)) {
      throw new Error('SCHEMA_EXPORT_DATABASE_URL must point at disposable test infrastructure');
    }

    const client = postgres(SCHEMA_EXPORT_DATABASE_URL, { max: 1 });
    const db = drizzle(client, { schema });

    try {
      await clearFixtureSeason(client);
      await client`
        INSERT INTO fpl.seasons (
          season_id,
          season_code,
          display_name,
          start_year,
          end_year,
          lifecycle_state,
          is_current
        ) VALUES
          (2025, '2526', '2025/26', 2025, 2026, 'completed', false),
          (2026, '2627', '2026/27', 2026, 2027, 'preseason', true)
      `;

      const source = buildCoreSnapshotFixture();
      const snapshot = prepareCoreSnapshot(source.bootstrap, source.fixtures);
      const invalidSnapshot = {
        ...snapshot,
        players: [{ ...snapshot.players[0], teamId: 999 }, ...snapshot.players.slice(1)],
      };

      await expect(
        persistCoreSnapshot(invalidSnapshot, new Date('2026-08-09T12:00:00.000Z'), db),
      ).rejects.toThrow();
      expect(await readCoreCounts(client)).toEqual([
        { relation: 'events', rows: 0 },
        { relation: 'fixtures', rows: 0 },
        { relation: 'phases', rows: 0 },
        { relation: 'players', rows: 0 },
        { relation: 'teams', rows: 0 },
      ]);

      const first = await persistCoreSnapshot(snapshot, new Date('2026-08-09T12:01:00.000Z'), db);
      expect(first.persistence).toEqual({
        events: 38,
        teams: 20,
        players: 220,
        phases: 1,
        fixtures: 380,
      });

      const second = await persistCoreSnapshot(snapshot, new Date('2026-08-09T12:02:00.000Z'), db);
      expect(second.persistence).toEqual(first.persistence);
      expect(await readCoreCounts(client)).toEqual([
        { relation: 'events', rows: 38 },
        { relation: 'fixtures', rows: 380 },
        { relation: 'phases', rows: 1 },
        { relation: 'players', rows: 220 },
        { relation: 'teams', rows: 20 },
      ]);

      const season = { seasonId: 2026, seasonCode: '2627' } as const;
      const marketSnapshots = transformPlayerMarketSnapshots(
        {
          elements: source.bootstrap.elements.slice(0, 2),
          teams: source.bootstrap.teams,
        },
        new Date('2026-08-09T12:03:00.000Z'),
      );
      const marketRepository = createPlayerMarketSnapshotsRepository(db);
      expect(await marketRepository.upsertCompleteDay(season, 1, marketSnapshots, 2)).toMatchObject(
        { persistedCount: 2 },
      );
      expect(await marketRepository.upsertCompleteDay(season, 1, marketSnapshots, 2)).toMatchObject(
        { persistedCount: 2 },
      );

      const playerStats = transformedPlayerStatsFixture.slice(0, 2).map((stat, index) => ({
        ...stat,
        eventId: 1,
        elementId: index + 1,
      }));
      const playerStatsRepository = createPlayerStatsRepository(db);
      expect(await playerStatsRepository.upsertBatch(season, playerStats)).toEqual({ count: 2 });
      expect(await playerStatsRepository.upsertBatch(season, playerStats)).toEqual({ count: 2 });

      const [playerSnapshotCounts] = await client<
        Array<{ market_rows: number; event_rows: number; value_change_rows: number }>
      >`
        SELECT
          (SELECT count(*)::integer FROM fpl.player_market_snapshots
            WHERE season_id = 2026) AS market_rows,
          (SELECT count(*)::integer FROM fpl.player_event_snapshots
            WHERE season_id = 2026 AND event_id = 1) AS event_rows,
          (SELECT count(*)::integer FROM reporting.player_value_changes
            WHERE season_id = 2026) AS value_change_rows
      `;
      expect({ ...playerSnapshotCounts }).toEqual({
        market_rows: 2,
        event_rows: 2,
        value_change_rows: 2,
      });

      const basePreparedLive = prepareEventLives(1, rawExplainElementsFixture);
      const fixtureEvidence = rawExplainElementsFixture.map((element, index) => {
        const player = snapshot.players.find((candidate) => candidate.id === element.id);
        if (!player) throw new Error(`Missing fixture player ${element.id}`);
        const fixture = snapshot.fixtures.find(
          (candidate) =>
            candidate.event === 1 &&
            (candidate.teamH === player.teamId || candidate.teamA === player.teamId),
        );
        if (!fixture) throw new Error(`Missing event-one fixture for player ${element.id}`);
        return {
          eventId: 1,
          fixtureId: fixture.id,
          elementId: element.id,
          minutes: element.stats.minutes,
          starts: index === 0 ? 1 : 0,
          goals: element.stats.goals_scored,
          assists: element.stats.assists,
          ownGoals: element.stats.own_goals,
          yellowCards: element.stats.yellow_cards,
          redCards: element.stats.red_cards,
        };
      });
      const preparedLive = { ...basePreparedLive, fixtureEvidence };
      const invalidLive = {
        ...preparedLive,
        explains: preparedLive.explains.map((explain, index) =>
          index === 0 ? { ...explain, elementId: 999 } : explain,
        ),
      };
      await expect(
        db.transaction((transaction) =>
          persistPreparedEventLives(season, invalidLive, transaction),
        ),
      ).rejects.toThrow();
      const invalidFixtureLive = {
        ...preparedLive,
        fixtureEvidence: preparedLive.fixtureEvidence.map((evidence, index) =>
          index === 0 ? { ...evidence, fixtureId: 999_999 } : evidence,
        ),
      };
      await expect(
        db.transaction((transaction) =>
          persistPreparedEventLives(season, invalidFixtureLive, transaction),
        ),
      ).rejects.toMatchObject({ code: 'FIXTURE_EVIDENCE_UPSERT_ERROR' });

      const [rolledBackLive] = await client<
        Array<{ gameweek_rows: number; scoring_rows: number; fixture_rows: number }>
      >`
        SELECT
          (SELECT count(*)::integer FROM fpl.player_gameweek_stats
            WHERE season_id = 2026 AND event_id = 1) AS gameweek_rows,
          (SELECT count(*)::integer FROM fpl.player_gameweek_scoring_items
            WHERE season_id = 2026 AND event_id = 1) AS scoring_rows,
          (SELECT count(*)::integer FROM fpl.player_fixture_stats
            WHERE season_id = 2026 AND event_id = 1) AS fixture_rows
      `;
      expect({ ...rolledBackLive }).toEqual({
        gameweek_rows: 0,
        scoring_rows: 0,
        fixture_rows: 0,
      });

      await db.transaction((transaction) =>
        persistPreparedEventLives(season, preparedLive, transaction),
      );
      await db.transaction((transaction) =>
        persistPreparedEventLives(season, preparedLive, transaction),
      );
      const [persistedLive] = await client<
        Array<{
          gameweek_rows: number;
          scoring_rows: number;
          fixture_rows: number;
          summary_rows: number;
          summary_points: number;
        }>
      >`
        SELECT
          (SELECT count(*)::integer FROM fpl.player_gameweek_stats
            WHERE season_id = 2026 AND event_id = 1) AS gameweek_rows,
          (SELECT count(*)::integer FROM fpl.player_gameweek_scoring_items
            WHERE season_id = 2026 AND event_id = 1) AS scoring_rows,
          (SELECT count(*)::integer FROM fpl.player_fixture_stats
            WHERE season_id = 2026 AND event_id = 1) AS fixture_rows,
          (SELECT count(*)::integer FROM reporting.player_season_summaries
            WHERE season_id = 2026 AND element_id IN (101, 102)) AS summary_rows,
          (SELECT sum(total_points)::integer FROM reporting.player_season_summaries
            WHERE season_id = 2026 AND element_id IN (101, 102)) AS summary_points
      `;
      expect({ ...persistedLive }).toEqual({
        gameweek_rows: 2,
        scoring_rows: 8,
        fixture_rows: 2,
        summary_rows: 2,
        summary_points: 11,
      });

      const entryIds = [70_001, 70_002] as const;
      const entryRepository = createEntryInfoRepository(db);
      for (const entryId of entryIds) {
        await entryRepository.upsertFromSummary(season, buildEntrySummary(entryId), 1, 1);
      }
      const renamed = await entryRepository.upsertFromSummary(
        season,
        { ...buildEntrySummary(entryIds[0]), name: 'Renamed Runtime Entry' },
        1,
        1,
      );
      expect(renamed.usedEntryNames).toEqual([
        `Runtime Entry ${entryIds[0]}`,
        'Renamed Runtime Entry',
      ]);

      const picks = buildPicks(1);
      const eventPoints = {
        elements: picks.picks.map((pick) => ({
          id: pick.element,
          stats: { total_points: pick.element === 1 ? 10 : 2 },
        })),
      };
      const noTransfers: RawFPLEntryTransfersResponse = [];
      for (const [index, entryId] of entryIds.entries()) {
        await db.transaction(async (transaction) => {
          await createEntryEventPicksRepository(transaction).upsertFromPicks(
            season,
            entryId,
            1,
            picks,
            new Date(`2026-08-09T12:1${index}:00.000Z`),
          );
          await createEntryEventResultsRepository(transaction).upsertFromPicksAndLive(
            season,
            entryId,
            1,
            picks,
            eventPoints,
            new Date(`2026-08-09T12:2${index}:00.000Z`),
          );
        });
        expect(
          await createEntryEventTransfersRepository(db).replaceForEvent(
            season,
            entryId,
            1,
            noTransfers,
            undefined,
            {
              syncMode: 'all',
              checkpointThroughEventId: 1,
              sourceCheckedAt: new Date(`2026-08-09T12:3${index}:00.000Z`),
            },
          ),
        ).toBe(true);
      }

      const historyRepository = createEntryHistoryInfoRepository(db);
      await historyRepository.upsertFromHistory(season, entryIds[0], {
        current: [],
        chips: [],
        past: [{ season_name: '2025/26', total_points: 2_500, rank: 1_234 }],
      });
      await historyRepository.upsertFromHistory(season, entryIds[0], {
        current: [],
        chips: [],
        past: [{ season_name: '2025/26', total_points: 2_501, rank: 1_000 }],
      });

      const leagueRepository = createEntryLeagueInfoRepository(db);
      await leagueRepository.upsertFromLeagues(season, entryIds[0], {
        classic: [
          {
            id: 90_001,
            name: 'Runtime Contract League',
            entry_rank: 1,
            entry_last_rank: 2,
            start_event: 1,
          },
        ],
        h2h: [],
      });
      await leagueRepository.upsertFromLeagues(season, entryIds[0], {
        classic: [
          {
            id: 90_001,
            name: 'Runtime Contract League',
            entry_rank: 1,
            entry_last_rank: 1,
            start_event: 1,
          },
        ],
        h2h: [],
      });

      const cupRepository = createEntryEventCupResultsRepository(db);
      const cupResults = [
        {
          entryId: entryIds[0],
          eventId: 1,
          opponentEntryId: entryIds[1],
          opponentName: `Runtime Entry ${entryIds[1]}`,
          result: 'win' as const,
          entryPoints: 60,
          opponentPoints: 55,
          entryName: 'Renamed Runtime Entry',
          playerName: `Runtime ${entryIds[0]}`,
          againstEntryName: `Runtime Entry ${entryIds[1]}`,
          againstPlayerName: `Runtime ${entryIds[1]}`,
          eventPoints: 60,
          againstEntryId: entryIds[1],
          againstEventPoints: 55,
        },
        {
          entryId: entryIds[1],
          eventId: 1,
          opponentEntryId: entryIds[0],
          opponentName: 'Renamed Runtime Entry',
          result: 'loss' as const,
          entryPoints: 55,
          opponentPoints: 60,
          entryName: `Runtime Entry ${entryIds[1]}`,
          playerName: `Runtime ${entryIds[1]}`,
          againstEntryName: 'Renamed Runtime Entry',
          againstPlayerName: `Runtime ${entryIds[0]}`,
          eventPoints: 55,
          againstEntryId: entryIds[0],
          againstEventPoints: 60,
        },
      ];
      expect(await cupRepository.replaceBatch(season, cupResults)).toBe(2);
      expect(await cupRepository.replaceBatch(season, cupResults)).toBe(2);

      const leagueResultRepository = createLeagueEventResultsRepository(db);
      const leagueResult = {
        leagueId: 90_001,
        leagueType: 'classic' as const,
        entryId: entryIds[0],
        eventId: 1,
        eventPoints: 60,
        eventTransfers: 0,
        eventTransfersCost: 0,
        eventNetPoints: 60,
        overallPoints: 60,
        overallRank: 1_000,
        entryName: 'Renamed Runtime Entry',
        playerName: `Runtime ${entryIds[0]}`,
        sourceCheckedAt: new Date('2026-08-09T12:50:00.000Z'),
      };
      expect(await leagueResultRepository.upsertBatch(season, [leagueResult])).toBe(1);
      expect(
        await leagueResultRepository.upsertBatch(season, [
          {
            ...leagueResult,
            eventPoints: 1,
            eventNetPoints: 1,
            sourceCheckedAt: new Date('2026-08-09T12:40:00.000Z'),
          },
        ]),
      ).toBe(1);

      const [entryFactCounts] = await client<
        Array<{
          historical_rows: number;
          historical_points: number;
          league_rows: number;
          cup_rows: number;
          league_result_rows: number;
          league_event_points: number;
        }>
      >`
        SELECT
          (SELECT count(*)::integer FROM competition.entry_season_histories
            WHERE season_id = 2025 AND entry_id = ${entryIds[0]}) AS historical_rows,
          (SELECT total_points::integer FROM competition.entry_season_histories
            WHERE season_id = 2025 AND entry_id = ${entryIds[0]}) AS historical_points,
          (SELECT count(*)::integer FROM competition.entry_leagues
            WHERE season_id = 2026 AND entry_id = ${entryIds[0]}) AS league_rows,
          (SELECT count(*)::integer FROM competition.entry_event_cup_results
            WHERE season_id = 2026 AND event_id = 1) AS cup_rows,
          (SELECT count(*)::integer FROM competition.league_event_results
            WHERE season_id = 2026 AND event_id = 1) AS league_result_rows,
          (SELECT event_points::integer FROM competition.league_event_results
            WHERE season_id = 2026 AND event_id = 1
              AND entry_id = ${entryIds[0]}) AS league_event_points
      `;
      expect({ ...entryFactCounts }).toEqual({
        historical_rows: 1,
        historical_points: 2_501,
        league_rows: 1,
        cup_rows: 2,
        league_result_rows: 1,
        league_event_points: 60,
      });

      const tournamentRepository = createTournamentInfoRepository(db);
      const plan = buildTournamentPlan(entryIds);
      const tournament = await tournamentRepository.createTournamentWithEntries(season, plan);
      expect(tournament).toMatchObject({
        seasonId: 2026,
        name: 'Runtime Contract Cup',
        totalTeamNum: 2,
      });
      await expect(tournamentRepository.createTournamentWithEntries(season, plan)).rejects.toThrow(
        'Tournament name already exists',
      );

      const battleTournament = await tournamentRepository.createTournamentWithEntries(season, {
        ...plan,
        leagueId: 90_002,
        sourceLeagueName: 'Runtime Battle League',
        tournamentName: 'Runtime Contract Battle',
        groupMode: 'battle_races',
        groupQualifyNum: null,
        knockoutMode: 'no_knockout',
        knockoutTeamNum: null,
        knockoutEventNum: null,
        knockoutRounds: null,
        knockoutStartedEventId: null,
        knockoutEndedEventId: null,
        knockoutPlayAgainstNum: null,
      });

      const tournamentGroupRepository = createTournamentGroupRepository(db);
      const pointGroups = entryIds.map((entryId, index) => ({
        tournamentId: tournament.id,
        groupId: 1,
        groupName: 'Runtime Group A',
        groupIndex: index + 1,
        entryId,
        startedEventId: 1,
        endedEventId: 1,
        groupPoints: 3 - index,
        groupRank: index + 1,
        played: 1,
        won: index === 0 ? 1 : 0,
        drawn: 0,
        lost: index === 0 ? 0 : 1,
        totalPoints: 60 - index * 5,
        totalTransfersCost: 0,
        totalNetPoints: 60 - index * 5,
        qualified: 1,
        overallRank: 1_000 + index,
      }));
      const battleGroups = pointGroups.map((group) => ({
        ...group,
        tournamentId: battleTournament.id,
        groupName: 'Runtime Battle Group A',
      }));
      expect(await tournamentGroupRepository.upsertBatch(season, pointGroups)).toBe(2);
      expect(await tournamentGroupRepository.upsertBatch(season, pointGroups)).toBe(2);
      expect(await tournamentGroupRepository.upsertBatch(season, battleGroups)).toBe(2);

      const pointsRepository = createTournamentPointsGroupResultsRepository(db);
      const pointResults = entryIds.map((entryId, index) => ({
        tournamentId: tournament.id,
        groupId: 1,
        eventId: 1,
        entryId,
        eventGroupRank: index + 1,
        eventPoints: 60 - index * 5,
        eventCost: 0,
        eventNetPoints: 60 - index * 5,
        eventRank: 100 + index,
        cumulativeTransfers: 0,
        cumulativeCosts: 0,
        cumulativeBenchPoints: 5,
        cumulativeAutoSubPoints: 0,
      }));
      expect(await pointsRepository.upsertBatch(season, pointResults)).toBe(2);
      expect(await pointsRepository.upsertBatch(season, pointResults)).toBe(2);

      const battleRepository = createTournamentBattleGroupResultsRepository(db);
      const battleResults = [
        {
          tournamentId: battleTournament.id,
          groupId: 1,
          eventId: 1,
          homeIndex: 1,
          homeEntryId: entryIds[0],
          homeNetPoints: 60,
          homeRank: 1,
          homeMatchPoints: 3,
          awayIndex: 2,
          awayEntryId: entryIds[1],
          awayNetPoints: 55,
          awayRank: 2,
          awayMatchPoints: 0,
        },
      ];
      expect(await battleRepository.upsertBatch(season, battleResults)).toBe(1);
      expect(await battleRepository.upsertBatch(season, battleResults)).toBe(1);

      const knockoutsRepository = createTournamentKnockoutsRepository(db);
      const knockouts = [
        {
          tournamentId: tournament.id,
          round: 1,
          startedEventId: 1,
          endedEventId: 1,
          matchId: 1,
          nextMatchId: null,
          homeEntryId: entryIds[0],
          homeNetPoints: 60,
          homeGoalsScored: 1,
          homeGoalsConceded: 0,
          homeWins: 1,
          awayEntryId: entryIds[1],
          awayNetPoints: 55,
          awayGoalsScored: 0,
          awayGoalsConceded: 1,
          awayWins: 0,
          roundWinner: entryIds[0],
        },
      ];
      expect(await knockoutsRepository.upsertBatch(season, knockouts)).toBe(1);
      expect(await knockoutsRepository.upsertBatch(season, knockouts)).toBe(1);

      const knockoutResultsRepository = createTournamentKnockoutResultsRepository(db);
      const knockoutResults = [
        {
          tournamentId: tournament.id,
          eventId: 1,
          matchId: 1,
          playAgainstId: 1,
          homeEntryId: entryIds[0],
          homeNetPoints: 60,
          homeGoalsScored: 1,
          homeGoalsConceded: 0,
          awayEntryId: entryIds[1],
          awayNetPoints: 55,
          awayGoalsScored: 0,
          awayGoalsConceded: 1,
          matchWinner: entryIds[0],
        },
      ];
      expect(await knockoutResultsRepository.upsertBatch(season, knockoutResults)).toBe(1);
      expect(await knockoutResultsRepository.upsertBatch(season, knockoutResults)).toBe(1);

      const [tournamentFactCounts] = await client<
        Array<{
          groups: number;
          points: number;
          battles: number;
          knockouts: number;
          knockout_results: number;
        }>
      >`
        SELECT
          (SELECT count(*)::integer FROM competition.tournament_groups
            WHERE season_id = 2026) AS groups,
          (SELECT count(*)::integer FROM competition.tournament_points_group_results
            WHERE season_id = 2026) AS points,
          (SELECT count(*)::integer FROM competition.tournament_battle_group_results
            WHERE season_id = 2026) AS battles,
          (SELECT count(*)::integer FROM competition.tournament_knockouts
            WHERE season_id = 2026) AS knockouts,
          (SELECT count(*)::integer FROM competition.tournament_knockout_results
            WHERE season_id = 2026) AS knockout_results
      `;
      expect({ ...tournamentFactCounts }).toEqual({
        groups: 4,
        points: 2,
        battles: 1,
        knockouts: 1,
        knockout_results: 1,
      });

      await client`REFRESH MATERIALIZED VIEW reporting.tournament_selection_stats`;
      const [selection] = await client<
        Array<{
          elements: number;
          total_selected: number;
          total_captains: number;
          total_vice_captains: number;
          minimum_percentage: string;
          maximum_percentage: string;
        }>
      >`
        SELECT
          count(*)::integer AS elements,
          sum(selected_count)::integer AS total_selected,
          sum(captain_count)::integer AS total_captains,
          sum(vice_captain_count)::integer AS total_vice_captains,
          min(selection_percentage)::text AS minimum_percentage,
          max(selection_percentage)::text AS maximum_percentage
        FROM reporting.tournament_selection_stats
        WHERE tournament_id = ${tournament.id}
          AND season_id = 2026
          AND event_id = 1
      `;
      expect({ ...selection }).toEqual({
        elements: 15,
        total_selected: 30,
        total_captains: 2,
        total_vice_captains: 2,
        minimum_percentage: '100.0000',
        maximum_percentage: '100.0000',
      });
    } finally {
      await clearFixtureSeason(client);
      await client.end();
    }
  },
  30_000,
);
