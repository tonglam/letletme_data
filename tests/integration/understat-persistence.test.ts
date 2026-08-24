import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  fixturesInFpl as eventFixtures,
  eventsInFpl as events,
  playerFixtureStatsInFpl as fplPlayerFixtureStats,
  playersInFpl as fplPlayers,
  entityLinksInBridge as providerEntityLinks,
  seasonsInFpl as fplSeasons,
  teamsInFpl as fplTeams,
  matchesInUnderstat as understatMatches,
  playerMatchStatsInUnderstat as understatPlayerMatchStats,
  playerSeasonsInUnderstat as understatPlayerSeasons,
  playerTeamSeasonsInUnderstat as understatPlayerTeamSeasons,
  playersInUnderstat as understatPlayers,
  seasonsInUnderstat as understatSeasons,
  syncItemsInOps as understatSyncItems,
  syncRunsInOps as understatSyncRuns,
  teamMatchStatsInUnderstat as understatTeamMatchStats,
  teamsInUnderstat as understatTeams,
  teamSeasonsInUnderstat as understatTeamSeasons,
  teamStatSplitsInUnderstat as understatTeamStatSplits,
} from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import type {
  UnderstatMatch,
  UnderstatPlayer,
  UnderstatPlayerSeason,
  UnderstatPlayerTeamSeason,
  UnderstatTeam,
  UnderstatTeamMatchStat,
  UnderstatTeamSeason,
  UnderstatTeamStatSplit,
} from '../../src/domain/understat';
import { UNDERSTAT_SPLIT_DIMENSIONS } from '../../src/domain/understat';
import {
  createUnderstatPlayerRepository,
  createUnderstatReferenceRepository,
  createUnderstatTeamRepository,
} from '../../src/repositories/understat';
import { persistUnderstatTeamDiscovery } from '../../src/repositories/understat-discovery';
import { createFplPlayerFixtureStatsRepository } from '../../src/repositories/fpl-player-fixture-stats';
import { understatSyncRepository } from '../../src/repositories/understat-sync';
import { providerIdentityRepository } from '../../src/repositories/provider-identity';
import {
  closeUnderstatPlayerQueue,
  getUnderstatPlayerQueue,
} from '../../src/queues/understat-player.queue';
import {
  closeUnderstatTeamQueue,
  getUnderstatTeamQueue,
} from '../../src/queues/understat-team.queue';
import { finalizeUnderstatPlayerRun } from '../../src/services/understat-player.service';
import { getUnderstatStatus } from '../../src/services/understat-status.service';
import { reconcileUnderstatOrphanedRuns } from '../../src/services/understat-recovery.service';
import { finalizeUnderstatTeamRun } from '../../src/services/understat-team.service';
import {
  stageUnderstatPlayerLeague,
  stageUnderstatPlayerTeamDetail,
  stageUnderstatTeamDetail,
  stageUnderstatTeamLeague,
  understatStagingHash,
} from '../../src/services/understat-staging';
import { contentHash } from '../../src/utils/content-hash';

const baseId = 900_000_000 + Math.floor(Math.random() * 1_000_000);
const teamIds = [baseId, baseId + 1];
const matchId = baseId + 2;
const playerId = baseId + 3;
const fplEventId = baseId + 10;
const fplTeamIds = [baseId + 11, baseId + 12];
const fplPlayerIds = [baseId + 13, baseId + 14];
const fplFixtureId = baseId + 15;
const season = '9899';
const seasonRef = { seasonId: 2098, seasonCode: season } as const;
const league = `TEST_${baseId}`;
const completeSeason = '9798';
const completeTeamIds = Array.from({ length: 20 }, (_, index) => baseId + 1_000 + index);
const completeMatchIds = Array.from({ length: 380 }, (_, index) => baseId + 2_000 + index);
const completePlayerIds = Array.from({ length: 20 }, (_, index) => baseId + 3_000 + index);
const extraCompletePlayerId = baseId + 4_000;
const runIds: string[] = [];
const providerLinkIds: string[] = [];
const now = new Date('2098-08-08T12:00:00.000Z');

function teams(): UnderstatTeam[] {
  return teamIds.map((id, index) => {
    const source = {
      id,
      title: `Integration Team ${index}`,
      shortTitle: `IT${index}`,
      firstSeenSeason: season,
      lastSeenSeason: season,
    };
    return { ...source, sourceHash: contentHash(source) };
  });
}

function match(): UnderstatMatch {
  const source = {
    id: matchId,
    season,
    homeTeamId: teamIds[0],
    awayTeamId: teamIds[1],
    kickoffAt: now,
    isResult: true,
    homeGoals: 1,
    awayGoals: 0,
    homeXg: 1.2,
    awayXg: 0.5,
    forecastHomeWin: 0.6,
    forecastDraw: 0.25,
    forecastAwayWin: 0.15,
  };
  return {
    ...source,
    sourceHash: contentHash(source),
    sourceCheckedAt: now,
    lastSeenAt: now,
  };
}

function matchStats(): UnderstatTeamMatchStat[] {
  return teamIds.map((teamId, index) => {
    const source = {
      matchId,
      teamId,
      side: index === 0 ? ('h' as const) : ('a' as const),
      xg: index === 0 ? 1.2 : 0.5,
      xga: index === 0 ? 0.5 : 1.2,
      npxg: index === 0 ? 1.2 : 0.5,
      npxga: index === 0 ? 0.5 : 1.2,
      npxgd: index === 0 ? 0.7 : -0.7,
      ppdaAtt: 10,
      ppdaDef: 5,
      ppdaAllowedAtt: 12,
      ppdaAllowedDef: 6,
      deep: index === 0 ? 5 : 2,
      deepAllowed: index === 0 ? 2 : 5,
      scored: index === 0 ? 1 : 0,
      missed: index === 0 ? 0 : 1,
      xpoints: index === 0 ? 2.1 : 0.6,
      result: index === 0 ? ('w' as const) : ('l' as const),
      points: index === 0 ? 3 : 0,
      wins: index === 0 ? 1 : 0,
      draws: 0,
      losses: index === 0 ? 0 : 1,
    };
    return { ...source, sourceHash: contentHash(source) };
  });
}

function teamSeasons(stats: UnderstatTeamMatchStat[]): UnderstatTeamSeason[] {
  return stats.map((stat) => {
    const source = {
      season,
      teamId: stat.teamId,
      sourceTitle: `Integration Team ${stat.teamId}`,
      sourceShortTitle: null,
      games: 1,
      wins: stat.wins,
      draws: stat.draws,
      losses: stat.losses,
      goalsFor: stat.scored,
      goalsAgainst: stat.missed,
      points: stat.points,
      xg: stat.xg,
      xga: stat.xga,
      npxg: stat.npxg,
      npxga: stat.npxga,
      npxgd: stat.npxgd,
      xpoints: stat.xpoints,
      deep: stat.deep,
      deepAllowed: stat.deepAllowed,
      ppdaAtt: stat.ppdaAtt,
      ppdaDef: stat.ppdaDef,
      ppdaAllowedAtt: stat.ppdaAllowedAtt,
      ppdaAllowedDef: stat.ppdaAllowedDef,
    };
    return { ...source, sourceHash: contentHash(source), lastSyncedAt: now };
  });
}

function split(xgFor: number): UnderstatTeamStatSplit {
  const source = {
    season,
    teamId: teamIds[0],
    dimension: 'result' as const,
    splitKey: 'w',
    label: 'Win',
    timeMinutes: 90,
    shotsFor: 10,
    goalsFor: 1,
    xgFor,
    shotsAgainst: 5,
    goalsAgainst: 0,
    xgAgainst: 0.5,
  };
  return { ...source, sourceHash: contentHash(source) };
}

function completePreseasonDiscovery() {
  const completeTeams = completeTeamIds.map((id, index) => {
    const source = {
      id,
      title: `Complete Team ${index + 1}`,
      shortTitle: `C${String(index + 1).padStart(2, '0')}`,
      firstSeenSeason: completeSeason,
      lastSeenSeason: completeSeason,
    };
    return { ...source, sourceHash: contentHash(source) };
  });
  const completeMatches = completeMatchIds.map((id, index): UnderstatMatch => {
    const source = {
      id,
      season: completeSeason,
      homeTeamId: completeTeamIds[index % completeTeamIds.length]!,
      awayTeamId: completeTeamIds[(index + 1 + Math.floor(index / 20)) % 20]!,
      kickoffAt: new Date(Date.UTC(2097, 7, 1 + Math.floor(index / 10))),
      isResult: false,
      homeGoals: null,
      awayGoals: null,
      homeXg: null,
      awayXg: null,
      forecastHomeWin: null,
      forecastDraw: null,
      forecastAwayWin: null,
    };
    return {
      ...source,
      sourceHash: contentHash(source),
      sourceCheckedAt: now,
      lastSeenAt: now,
    };
  });
  return {
    season: {
      season: completeSeason,
      sourceYear: 2097,
      league: 'EPL',
      state: 'planned' as const,
      firstSeenAt: now,
      lastSeenAt: now,
    },
    teams: completeTeams,
    matches: completeMatches,
    teamMatchStats: [],
    teamSeasons: completeTeams.map((team) => {
      const source = {
        season: completeSeason,
        teamId: team.id,
        sourceTitle: team.title,
        sourceShortTitle: team.shortTitle,
        games: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        points: 0,
        xg: 0,
        xga: 0,
        npxg: 0,
        npxga: 0,
        npxgd: 0,
        xpoints: 0,
        deep: 0,
        deepAllowed: 0,
        ppdaAtt: 0,
        ppdaDef: 0,
        ppdaAllowedAtt: 0,
        ppdaAllowedDef: 0,
      };
      return { ...source, sourceHash: contentHash(source), lastSyncedAt: now };
    }),
  };
}

function completeTeamSplits(teamId: number): UnderstatTeamStatSplit[] {
  return completeTeamSplitsFor(completeSeason, teamId);
}

function completeTeamSplitsFor(seasonCode: string, teamId: number): UnderstatTeamStatSplit[] {
  return UNDERSTAT_SPLIT_DIMENSIONS.map((dimension) => {
    const source = {
      season: seasonCode,
      teamId,
      dimension,
      splitKey: 'all',
      label: 'All',
      timeMinutes: 0,
      shotsFor: 0,
      goalsFor: 0,
      xgFor: 0,
      shotsAgainst: 0,
      goalsAgainst: 0,
      xgAgainst: 0,
    };
    return { ...source, sourceHash: contentHash(source) };
  });
}

function zeroPlayerStats() {
  return {
    games: 0,
    time: 0,
    goals: 0,
    npg: 0,
    assists: 0,
    shots: 0,
    keyPasses: 0,
    yellowCards: 0,
    redCards: 0,
    xg: 0,
    npxg: 0,
    xa: 0,
    xgChain: 0,
    xgBuildup: 0,
    position: 'NA',
  };
}

function completePlayerDiscovery() {
  const reference = completePreseasonDiscovery();
  const players = completePlayerIds.map((id, index) => {
    const source = {
      id,
      name: `Complete Player ${index + 1}`,
      favoritePosition: null,
      firstSeenSeason: completeSeason,
      lastSeenSeason: completeSeason,
    };
    return { ...source, sourceHash: contentHash(source) };
  });
  return {
    season: reference.season,
    teams: reference.teams,
    matches: reference.matches,
    players,
    playerSeasons: players.map((player, index) => {
      const source = {
        season: completeSeason,
        playerId: player.id,
        sourceName: player.name,
        sourceTeamTitle: reference.teams[index]!.title,
        ...zeroPlayerStats(),
      };
      return { ...source, sourceHash: contentHash(source) };
    }),
  };
}

function completePlayerMembership(index: number): UnderstatPlayerTeamSeason {
  const source = {
    season: completeSeason,
    playerId: completePlayerIds[index]!,
    teamId: completeTeamIds[index]!,
    ...zeroPlayerStats(),
  };
  return { ...source, sourceHash: contentHash(source) };
}

afterAll(async () => {
  const db = await getDb();
  await db
    .delete(fplPlayerFixtureStats)
    .where(
      and(
        eq(fplPlayerFixtureStats.seasonId, seasonRef.seasonId),
        eq(fplPlayerFixtureStats.fixtureId, fplFixtureId),
      ),
    );
  await db
    .delete(eventFixtures)
    .where(
      and(
        eq(eventFixtures.seasonId, seasonRef.seasonId),
        eq(eventFixtures.fixtureId, fplFixtureId),
      ),
    );
  await db
    .delete(fplPlayers)
    .where(
      and(eq(fplPlayers.seasonId, seasonRef.seasonId), inArray(fplPlayers.elementId, fplPlayerIds)),
    );
  await db
    .delete(fplTeams)
    .where(and(eq(fplTeams.seasonId, seasonRef.seasonId), inArray(fplTeams.teamId, fplTeamIds)));
  await db
    .delete(events)
    .where(and(eq(events.seasonId, seasonRef.seasonId), eq(events.eventId, fplEventId)));
  if (providerLinkIds.length > 0) {
    await db
      .delete(providerEntityLinks)
      .where(inArray(providerEntityLinks.linkId, providerLinkIds));
  }
  if (runIds.length > 0) {
    await db.delete(understatSyncItems).where(inArray(understatSyncItems.runId, runIds));
    await db.delete(understatSyncRuns).where(inArray(understatSyncRuns.runId, runIds));
  }
  await db
    .delete(understatPlayerMatchStats)
    .where(inArray(understatPlayerMatchStats.matchId, completeMatchIds));
  await db
    .delete(understatPlayerTeamSeasons)
    .where(eq(understatPlayerTeamSeasons.seasonCode, completeSeason));
  await db
    .delete(understatPlayerSeasons)
    .where(eq(understatPlayerSeasons.seasonCode, completeSeason));
  await db
    .delete(understatPlayers)
    .where(inArray(understatPlayers.playerId, [...completePlayerIds, extraCompletePlayerId]));
  await db
    .delete(understatTeamStatSplits)
    .where(eq(understatTeamStatSplits.seasonCode, completeSeason));
  await db.delete(understatTeamSeasons).where(eq(understatTeamSeasons.seasonCode, completeSeason));
  await db
    .delete(understatTeamMatchStats)
    .where(inArray(understatTeamMatchStats.matchId, completeMatchIds));
  await db.delete(understatMatches).where(eq(understatMatches.seasonCode, completeSeason));
  await db.delete(understatTeams).where(inArray(understatTeams.teamId, completeTeamIds));
  await db.delete(understatSeasons).where(eq(understatSeasons.seasonCode, completeSeason));
  await db.delete(understatPlayerMatchStats).where(eq(understatPlayerMatchStats.matchId, matchId));
  await db
    .delete(understatPlayerTeamSeasons)
    .where(eq(understatPlayerTeamSeasons.seasonCode, season));
  await db.delete(understatPlayerSeasons).where(eq(understatPlayerSeasons.seasonCode, season));
  await db
    .delete(understatPlayers)
    .where(inArray(understatPlayers.playerId, [...teamIds, playerId]));
  await db.delete(understatTeamStatSplits).where(eq(understatTeamStatSplits.seasonCode, season));
  await db.delete(understatTeamSeasons).where(eq(understatTeamSeasons.seasonCode, season));
  await db.delete(understatTeamMatchStats).where(eq(understatTeamMatchStats.matchId, matchId));
  await db.delete(understatMatches).where(eq(understatMatches.matchId, matchId));
  await db.delete(understatTeams).where(inArray(understatTeams.teamId, teamIds));
  await db.delete(understatSeasons).where(eq(understatSeasons.seasonCode, season));
  await db.delete(fplSeasons).where(eq(fplSeasons.seasonId, seasonRef.seasonId));
  await closeUnderstatPlayerQueue();
  await closeUnderstatTeamQueue();
});

describe('Understat persistence', () => {
  test('persists a fresh discovery graph in FK order and skips unchanged rows', async () => {
    const db = await getDb();
    const seasonRecord = {
      season,
      sourceYear: 2098,
      league,
      state: 'complete' as const,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    const stats = matchStats();
    const discovery = {
      season: seasonRecord,
      teams: teams(),
      matches: [match()],
      teamMatchStats: stats,
      teamSeasons: teamSeasons(stats),
    };

    expect(await db.transaction((tx) => persistUnderstatTeamDiscovery(tx, discovery))).toBe(true);
    expect(await db.transaction((tx) => persistUnderstatTeamDiscovery(tx, discovery))).toBe(false);
  });

  test('stamps Understat source writes after a transaction waits', async () => {
    const db = await getDb();
    await db.transaction(async (tx) => {
      const references = createUnderstatReferenceRepository(tx);
      await references.upsertSeason({
        season,
        sourceYear: 2098,
        league,
        state: 'complete',
        firstSeenAt: now,
        lastSeenAt: now,
      });
      await references.upsertTeams(teams());
      await references.upsertMatches([match()]);
      const [started] = await tx.execute<{ startedAt: Date }>(sql`
        SELECT transaction_timestamp() AS "startedAt"
      `);
      await tx.execute(sql`SELECT pg_sleep(0.05)`);
      const refreshed = {
        ...match(),
        sourceCheckedAt: new Date(now.getTime() + 1_000),
        lastSeenAt: new Date(now.getTime() + 1_000),
      };
      await references.upsertMatches([refreshed]);
      const [row] = await tx
        .select({ updatedAt: understatMatches.updatedAt })
        .from(understatMatches)
        .where(eq(understatMatches.matchId, matchId));
      expect(row?.updatedAt.getTime()).toBeGreaterThan(started?.startedAt.getTime() ?? 0);
    });
  });

  test('persists shared discovery before team detail resources settle', async () => {
    const runId = randomUUID();
    runIds.push(runId);
    const stats = matchStats();
    const originalTeams = teams();
    const changedTeamSource = {
      id: originalTeams[0]!.id,
      title: 'This title must persist',
      shortTitle: originalTeams[0]!.shortTitle,
      firstSeenSeason: season,
      lastSeenSeason: season,
    };
    const staged = stageUnderstatTeamLeague(season, {
      season: {
        season,
        sourceYear: 2098,
        league,
        state: 'complete',
        firstSeenAt: now,
        lastSeenAt: now,
      },
      teams: [
        { ...changedTeamSource, sourceHash: contentHash(changedTeamSource) },
        originalTeams[1]!,
      ],
      matches: [match()],
      teamMatchStats: stats,
      teamSeasons: teamSeasons(stats),
    });

    await understatSyncRepository.createRun({
      runId,
      lane: 'team',
      season,
      mode: 'full',
      trigger: 'manual',
    });
    await understatSyncRepository.addItems(runId, [{ resourceType: 'league', resourceId: 'EPL' }]);
    await understatSyncRepository.completeItem(
      runId,
      'league',
      'EPL',
      understatStagingHash(staged),
      staged,
    );

    await finalizeUnderstatTeamRun({
      runId,
      season,
      mode: 'full',
      trigger: 'manual',
    });

    const db = await getDb();
    const [persistedTeam] = await db
      .select({ title: understatTeams.title })
      .from(understatTeams)
      .where(eq(understatTeams.teamId, originalTeams[0]!.id))
      .limit(1);
    const run = await understatSyncRepository.findRun(runId);
    expect(persistedTeam?.title).toBe('This title must persist');
    expect(run?.status).toBe('completed');
    expect(run?.dataChanged).toBe(true);
    expect(run?.metadata).toEqual({
      finalized: true,
      storage: 'postgresql',
      partial: false,
      incompleteTeams: [],
      counts: { teams: 2, matches: 1, teamMatchStats: 2, teamSplits: 0 },
    });
  });

  test('commits a complete team without waiting for another team', async () => {
    const runId = randomUUID();
    runIds.push(runId);
    const discovery = {
      season: {
        season,
        sourceYear: 2098,
        league,
        state: 'active' as const,
        firstSeenAt: now,
        lastSeenAt: now,
      },
      teams: teams(),
      matches: [match()],
      teamMatchStats: matchStats(),
      teamSeasons: teamSeasons(matchStats()),
    };
    const leaguePayload = stageUnderstatTeamLeague(season, discovery);
    const completeTeamPayload = stageUnderstatTeamDetail(
      season,
      teamIds[0]!,
      completeTeamSplitsFor(season, teamIds[0]!),
    );
    await understatSyncRepository.createRun({
      runId,
      lane: 'team',
      season,
      mode: 'incremental',
      trigger: 'manual',
    });
    await understatSyncRepository.addItems(runId, [
      { resourceType: 'league', resourceId: league },
      ...teamIds.map((teamId) => ({
        resourceType: 'team-detail',
        resourceId: String(teamId),
      })),
    ]);
    await understatSyncRepository.completeItem(
      runId,
      'league',
      league,
      understatStagingHash(leaguePayload),
      leaguePayload,
    );
    await understatSyncRepository.completeItem(
      runId,
      'team-detail',
      String(teamIds[0]),
      understatStagingHash(completeTeamPayload),
      completeTeamPayload,
    );
    await understatSyncRepository.skipItem(
      runId,
      'team-detail',
      String(teamIds[1]),
      'team split dimensions missing: result',
    );

    await finalizeUnderstatTeamRun({
      runId,
      season,
      mode: 'incremental',
      trigger: 'manual',
    });

    const db = await getDb();
    const snapshot = await createUnderstatTeamRepository(db).readSnapshot(season);
    const run = await understatSyncRepository.findRun(runId);
    expect(snapshot.splits.filter((row) => row.teamId === teamIds[0])).toHaveLength(
      UNDERSTAT_SPLIT_DIMENSIONS.length,
    );
    expect(snapshot.splits.some((row) => row.teamId === teamIds[1])).toBe(false);
    expect(run?.status).toBe('completed');
    expect(run?.metadata).toMatchObject({
      finalized: true,
      storage: 'postgresql',
      partial: true,
      skippedItems: 1,
      incompleteTeams: [],
      counts: { teams: 2, matches: 1, teamMatchStats: 2, teamSplits: 7 },
    });
  });

  test('finalizes staged team resources with per-run completeness metadata', async () => {
    const runId = randomUUID();
    runIds.push(runId);
    const discovery = completePreseasonDiscovery();
    const leaguePayload = stageUnderstatTeamLeague(completeSeason, discovery);

    await understatSyncRepository.createRun({
      runId,
      lane: 'team',
      season: completeSeason,
      mode: 'full',
      trigger: 'manual',
    });
    await understatSyncRepository.addItems(runId, [
      { resourceType: 'league', resourceId: 'EPL' },
      ...completeTeamIds.map((teamId) => ({
        resourceType: 'team-detail',
        resourceId: String(teamId),
      })),
    ]);
    await understatSyncRepository.completeItem(
      runId,
      'league',
      'EPL',
      understatStagingHash(leaguePayload),
      leaguePayload,
    );
    for (const teamId of completeTeamIds) {
      const detail = stageUnderstatTeamDetail(completeSeason, teamId, completeTeamSplits(teamId));
      await understatSyncRepository.completeItem(
        runId,
        'team-detail',
        String(teamId),
        understatStagingHash(detail),
        detail,
      );
    }

    const db = await getDb();
    const factsBeforeFinalize = await db
      .select({ season: understatSeasons.seasonCode })
      .from(understatSeasons)
      .where(eq(understatSeasons.seasonCode, completeSeason));
    expect(factsBeforeFinalize).toHaveLength(0);

    await finalizeUnderstatTeamRun({
      runId,
      season: completeSeason,
      mode: 'full',
      trigger: 'manual',
    });

    const snapshot = await createUnderstatTeamRepository(db).readSnapshot(completeSeason);
    const run = await understatSyncRepository.findRun(runId);
    expect(snapshot.teams).toHaveLength(20);
    expect(snapshot.matches).toHaveLength(380);
    expect(snapshot.splits).toHaveLength(20 * UNDERSTAT_SPLIT_DIMENSIONS.length);
    expect(run?.status).toBe('completed');
    expect(run?.metadata).toEqual({
      finalized: true,
      storage: 'postgresql',
      partial: false,
      incompleteTeams: [],
      counts: { teams: 20, matches: 380, teamMatchStats: 0, teamSplits: 140 },
    });
  });

  test('finalizes complete staged player resources', async () => {
    const runId = randomUUID();
    runIds.push(runId);
    const discovery = completePlayerDiscovery();
    const leaguePayload = stageUnderstatPlayerLeague(completeSeason, discovery);

    await understatSyncRepository.createRun({
      runId,
      lane: 'player',
      season: completeSeason,
      mode: 'full',
      trigger: 'manual',
    });
    await understatSyncRepository.addItems(runId, [
      { resourceType: 'league', resourceId: 'EPL' },
      ...completeTeamIds.map((teamId) => ({
        resourceType: 'team-participants',
        resourceId: String(teamId),
      })),
    ]);
    await understatSyncRepository.completeItem(
      runId,
      'league',
      'EPL',
      understatStagingHash(leaguePayload),
      leaguePayload,
    );
    for (const [index, teamId] of completeTeamIds.entries()) {
      const player = discovery.players[index]!;
      const detail = stageUnderstatPlayerTeamDetail(
        completeSeason,
        teamId,
        [player],
        [completePlayerMembership(index)],
      );
      await understatSyncRepository.completeItem(
        runId,
        'team-participants',
        String(teamId),
        understatStagingHash(detail),
        detail,
      );
    }

    const db = await getDb();
    const factsBeforeFinalize = await db
      .select({ playerId: understatPlayerSeasons.playerId })
      .from(understatPlayerSeasons)
      .where(eq(understatPlayerSeasons.seasonCode, completeSeason));
    expect(factsBeforeFinalize).toHaveLength(0);

    await finalizeUnderstatPlayerRun({
      runId,
      season: completeSeason,
      mode: 'full',
      trigger: 'manual',
    });

    const snapshot = await createUnderstatPlayerRepository(db).readSnapshot(completeSeason);
    const run = await understatSyncRepository.findRun(runId);
    expect(snapshot.players).toHaveLength(20);
    expect(snapshot.memberships).toHaveLength(20);
    expect(snapshot.matchStats).toHaveLength(0);
    expect(run?.status).toBe('completed');
    expect(run?.metadata).toEqual({
      finalized: true,
      storage: 'postgresql',
      partial: false,
      incompleteTeams: [],
      incompleteMatches: [],
      counts: { players: 20, memberships: 20, playerMatchStats: 0 },
    });
  });

  test('persists player discovery even when participant resources are not available yet', async () => {
    const runId = randomUUID();
    runIds.push(runId);
    const complete = completePlayerDiscovery();
    const originalPlayer = complete.players[0]!;
    const changedSource = {
      id: originalPlayer.id,
      name: 'This player name must persist',
      favoritePosition: originalPlayer.favoritePosition,
      firstSeenSeason: completeSeason,
      lastSeenSeason: completeSeason,
    };
    const changedPlayer = { ...changedSource, sourceHash: contentHash(changedSource) };
    const changedSeasonSource = {
      ...complete.playerSeasons[0]!,
      sourceName: changedPlayer.name,
    };
    const extraPlayerSource = {
      id: extraCompletePlayerId,
      name: 'Unlinked staged player',
      favoritePosition: null,
      firstSeenSeason: completeSeason,
      lastSeenSeason: completeSeason,
    };
    const extraPlayer = {
      ...extraPlayerSource,
      sourceHash: contentHash(extraPlayerSource),
    };
    const extraSeasonSource = {
      season: completeSeason,
      playerId: extraPlayer.id,
      sourceName: extraPlayer.name,
      sourceTeamTitle: 'Unknown staged team',
      ...zeroPlayerStats(),
    };
    const discovery = {
      ...complete,
      players: [changedPlayer, ...complete.players.slice(1), extraPlayer],
      playerSeasons: [
        { ...changedSeasonSource, sourceHash: contentHash(changedSeasonSource) },
        ...complete.playerSeasons.slice(1),
        { ...extraSeasonSource, sourceHash: contentHash(extraSeasonSource) },
      ],
    };
    const staged = stageUnderstatPlayerLeague(completeSeason, discovery);

    await understatSyncRepository.createRun({
      runId,
      lane: 'player',
      season: completeSeason,
      mode: 'full',
      trigger: 'manual',
    });
    await understatSyncRepository.addItems(runId, [{ resourceType: 'league', resourceId: 'EPL' }]);
    await understatSyncRepository.completeItem(
      runId,
      'league',
      'EPL',
      understatStagingHash(staged),
      staged,
    );

    await finalizeUnderstatPlayerRun({
      runId,
      season: completeSeason,
      mode: 'full',
      trigger: 'manual',
    });

    const db = await getDb();
    const snapshot = await createUnderstatPlayerRepository(db).readSnapshot(completeSeason);
    const run = await understatSyncRepository.findRun(runId);
    expect(snapshot.players).toHaveLength(21);
    expect(snapshot.players.find((row) => row.player.id === originalPlayer.id)?.player.name).toBe(
      'This player name must persist',
    );
    expect(snapshot.players.some((row) => row.player.id === extraPlayer.id)).toBe(true);
    expect(run?.status).toBe('completed');
    expect(run?.dataChanged).toBe(true);
    expect(run?.metadata).toEqual({
      finalized: true,
      storage: 'postgresql',
      partial: false,
      incompleteTeams: [],
      incompleteMatches: [],
      counts: { players: 21, memberships: 20, playerMatchStats: 0 },
    });

    const status = await getUnderstatStatus(completeSeason);
    expect(status.storage).toBe('postgresql');
    expect(status.dataCache).toBe('disabled');
    expect(status.resources.teams.count).toBe(20);
    expect(status.resources.matches.count).toBe(380);
    expect(status.resources.players.count).toBe(21);
    expect(status.resources.teamParticipants.count).toBe(20);
    expect(status.lanes.team.latestRun?.status).toBe('completed');
    expect(status.lanes.player.latestRun?.status).toBe('completed');
    expect(status.lanes.team.latestRun?.updatedAt).toBeInstanceOf(Date);
    expect(status.lanes.team.stale).toBe(false);
    expect(status.lanes.team.recovery).toMatchObject({ state: 'none' });
  });

  test('rolls back a failed scoped split replacement', async () => {
    const db = await getDb();
    await db.transaction((tx) =>
      createUnderstatTeamRepository(tx).replaceSplits(season, teamIds[0], [split(1.2)]),
    );
    await expect(
      db.transaction(async (tx) => {
        await createUnderstatTeamRepository(tx).replaceSplits(season, teamIds[0], [split(9.9)]);
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');
    const snapshot = await createUnderstatTeamRepository(db).readSnapshot(season);
    expect(snapshot.splits.find((row) => row.teamId === teamIds[0])?.xgFor).toBe(1.2);
    await expect(
      db.transaction((tx) =>
        createUnderstatTeamRepository(tx).replaceSplits(season, teamIds[0], []),
      ),
    ).rejects.toThrow('Refusing to clear non-empty Understat team splits');
  });

  test('reconciles player summaries without rewriting unchanged rows or accepting empty loss', async () => {
    const db = await getDb();
    const references = createUnderstatReferenceRepository(db);
    const playersRepository = createUnderstatPlayerRepository(db);
    await references.ensureSeason({
      season,
      sourceYear: 2098,
      league,
      state: 'active',
      firstSeenAt: now,
      lastSeenAt: now,
    });
    const playerSource = {
      id: playerId,
      name: 'Integration Player',
      favoritePosition: null,
      firstSeenSeason: season,
      lastSeenSeason: season,
    };
    const player: UnderstatPlayer = {
      ...playerSource,
      sourceHash: contentHash(playerSource),
    };
    await playersRepository.upsertPlayers([player]);
    const seasonSource = {
      season,
      playerId,
      sourceName: 'Integration Player',
      sourceTeamTitle: 'Integration Team 0',
      games: 1,
      time: 90,
      goals: 1,
      npg: 1,
      assists: 0,
      shots: 2,
      keyPasses: 1,
      yellowCards: 0,
      redCards: 0,
      xg: 0.8,
      npxg: 0.8,
      xa: 0.1,
      xgChain: 0.9,
      xgBuildup: 0.2,
      position: 'FW',
    };
    const summary: UnderstatPlayerSeason = {
      ...seasonSource,
      sourceHash: contentHash(seasonSource),
    };
    expect(await playersRepository.replacePlayerSeasons(season, [summary])).toBe(true);
    expect(await playersRepository.replacePlayerSeasons(season, [summary])).toBe(false);
    await expect(playersRepository.replacePlayerSeasons(season, [])).rejects.toThrow(
      'Refusing to clear non-empty Understat player season',
    );
  });

  test('tracks team and player lanes independently', async () => {
    for (const lane of ['team', 'player'] as const) {
      const runId = randomUUID();
      runIds.push(runId);
      await understatSyncRepository.createRun({
        runId,
        lane,
        season,
        mode: 'incremental',
        trigger: 'manual',
      });
      await understatSyncRepository.addItems(runId, [
        { resourceType: 'league', resourceId: league },
      ]);
      const staged = { test: true, lane };
      expect(
        await understatSyncRepository.completeItem(
          runId,
          'league',
          league,
          contentHash(staged),
          staged,
        ),
      ).toBe(true);
    }
    const latest = await understatSyncRepository.findLatestRuns(season);
    expect(latest.team?.runId).not.toBe(latest.player?.runId);
    expect(latest.team?.status).toBe('ready_to_publish');
    expect(latest.player?.status).toBe('ready_to_publish');
  });

  test('keeps the complete Understat run identity immutable across retries', async () => {
    const runId = randomUUID();
    runIds.push(runId);
    const identity = {
      runId,
      lane: 'team' as const,
      season,
      mode: 'incremental' as const,
      trigger: 'manual' as const,
    };

    expect(await understatSyncRepository.createRun(identity)).toMatchObject(identity);
    expect(await understatSyncRepository.createRun(identity)).toMatchObject(identity);
    await expect(understatSyncRepository.createRun({ ...identity, mode: 'full' })).rejects.toThrow(
      `Understat sync run identity conflict: ${runId}`,
    );
    await expect(
      understatSyncRepository.createRun({ ...identity, trigger: 'api' }),
    ).rejects.toThrow(`Understat sync run identity conflict: ${runId}`);
  });

  test('does not reopen terminal runs or overwrite settled items on delayed replay', async () => {
    const runId = randomUUID();
    runIds.push(runId);
    await understatSyncRepository.createRun({
      runId,
      lane: 'team',
      season,
      mode: 'incremental',
      trigger: 'manual',
    });
    await understatSyncRepository.addItems(runId, [{ resourceType: 'league', resourceId: league }]);
    const originalPayload = { attempt: 1, value: 'accepted' };
    expect(
      await understatSyncRepository.completeItem(
        runId,
        'league',
        league,
        contentHash(originalPayload),
        originalPayload,
      ),
    ).toBe(true);
    await understatSyncRepository.markRunCompleted(runId, { finalized: true }, true);

    await understatSyncRepository.markItemRunning(runId, 'league', league);
    await understatSyncRepository.failItem(runId, 'league', league, 'late failure');
    expect(
      await understatSyncRepository.addItems(runId, [
        { resourceType: 'team-detail', resourceId: String(teamIds[0]) },
      ]),
    ).toBe(1);
    await understatSyncRepository.markRunFailed(runId, 'late run failure');
    await understatSyncRepository.markRunSkipped(runId, 'late skip');
    const delayedPayload = { attempt: 1, value: 'late' };
    expect(
      await understatSyncRepository.completeItem(
        runId,
        'league',
        league,
        contentHash(delayedPayload),
        delayedPayload,
      ),
    ).toBe(false);

    const [run, item] = await Promise.all([
      understatSyncRepository.findRun(runId),
      understatSyncRepository.findItem(runId, 'league', league),
    ]);
    expect(run?.status).toBe('completed');
    expect(run?.errorSummary).toBeNull();
    expect(item).toMatchObject({
      status: 'completed',
      sourceHash: contentHash(originalPayload),
      normalizedPayload: originalPayload,
    });
    expect(await understatSyncRepository.findItems(runId)).toHaveLength(1);
  });

  test('does not terminate a failed run until every item has settled', async () => {
    const runId = randomUUID();
    runIds.push(runId);
    await understatSyncRepository.createRun({
      runId,
      lane: 'team',
      season,
      mode: 'full',
      trigger: 'manual',
    });
    await understatSyncRepository.addItems(runId, [
      { resourceType: 'team-detail', resourceId: String(teamIds[0]) },
      { resourceType: 'team-detail', resourceId: String(teamIds[1]) },
    ]);

    await understatSyncRepository.failItem(
      runId,
      'team-detail',
      String(teamIds[0]),
      'first resource failed',
    );
    const inProgress = await understatSyncRepository.findRun(runId);
    expect(inProgress?.status).toBe('running');
    expect(inProgress?.failedItems).toBe(1);
    expect(inProgress?.completedAt).toBeNull();
    expect(inProgress?.errorSummary).toBe('first resource failed');
    expect(await understatSyncRepository.markRunFailedIfSettled(runId, 'premature retry')).toBe(
      false,
    );
    expect((await understatSyncRepository.findRun(runId))?.status).toBe('running');

    const staged = { test: true, teamId: teamIds[1] };
    expect(
      await understatSyncRepository.completeItem(
        runId,
        'team-detail',
        String(teamIds[1]),
        contentHash(staged),
        staged,
      ),
    ).toBe(false);
    const settled = await understatSyncRepository.findRun(runId);
    expect(settled?.status).toBe('failed');
    expect(settled?.failedItems).toBe(1);
    expect(settled?.completedItems).toBe(1);
    expect(settled?.skippedItems).toBe(0);
    expect(settled?.completedAt).not.toBeNull();
  });

  test('reconciles an orphaned run only when both Understat queues are empty', async () => {
    const teamQueue = getUnderstatTeamQueue();
    const playerQueue = getUnderstatPlayerQueue();
    await teamQueue.drain(true);
    await playerQueue.drain(true);

    const runId = randomUUID();
    const obligationId = randomUUID();
    runIds.push(runId);
    await understatSyncRepository.createRun({
      runId,
      lane: 'team',
      season,
      mode: 'incremental',
      trigger: 'cron',
      obligationId,
      obligationGeneration: 1,
    });
    await understatSyncRepository.addItems(runId, [
      { resourceType: 'team-detail', resourceId: String(teamIds[0]) },
    ]);
    await understatSyncRepository.markItemRunning(runId, 'team-detail', String(teamIds[0]));
    const db = await getDb();
    await db
      .update(understatSyncRuns)
      .set({ updatedAt: new Date(Date.now() - 31 * 60_000) })
      .where(eq(understatSyncRuns.runId, runId));

    const queued = await teamQueue.add(
      'understat-team-discover',
      { runId: randomUUID(), season, mode: 'incremental', trigger: 'cron' },
      { jobId: `understat-orphan-queue-${runId}` },
    );
    const deferred = await reconcileUnderstatOrphanedRuns(new Date());
    expect(deferred.skippedBecauseQueueBusy).toBe(true);
    expect((await understatSyncRepository.findRun(runId))?.status).toBe('running');
    await queued.remove();

    const recovered = await reconcileUnderstatOrphanedRuns(new Date());
    expect(recovered.recovered).toBe(1);
    const [run, item] = await Promise.all([
      understatSyncRepository.findRun(runId),
      understatSyncRepository.findItem(runId, 'team-detail', String(teamIds[0])),
    ]);
    expect(run?.status).toBe('failed');
    expect(run?.metadata).toMatchObject({ obligationId, obligationGeneration: 1 });
    expect(run?.metadata.recovery).toMatchObject({ state: 'orphaned', failedItems: 1 });
    expect(item?.status).toBe('failed');
  });

  test('keeps provider-link season bounds monotonic during historical backfills', async () => {
    const identity = `${baseId}`;
    const initial = await providerIdentityRepository.upsertEntityLink({
      entityType: 'player',
      leftProvider: 'understat',
      leftEntityId: identity,
      rightProvider: 'fpl',
      rightEntityId: identity,
      status: 'pending',
      method: 'integration-test',
      ruleId: 'test-rule',
      season: '2728',
    });
    providerLinkIds.push(initial.id);
    await providerIdentityRepository.upsertEntityLink({
      entityType: 'player',
      leftProvider: 'understat',
      leftEntityId: identity,
      rightProvider: 'fpl',
      rightEntityId: identity,
      status: 'pending',
      method: 'integration-test',
      ruleId: 'test-rule',
      season: '2627',
    });
    const latest = await providerIdentityRepository.upsertEntityLink({
      entityType: 'player',
      leftProvider: 'understat',
      leftEntityId: identity,
      rightProvider: 'fpl',
      rightEntityId: identity,
      status: 'pending',
      method: 'integration-test',
      ruleId: 'test-rule',
      season: '2829',
    });

    expect(latest.firstSeenSeason).toBe('2627');
    expect(latest.lastSeenSeason).toBe('2829');
  });

  test('does not advance an unchanged provider-link revision on repeated candidate writes', async () => {
    const identity = `${baseId + 100}`;
    const initial = await providerIdentityRepository.upsertEntityLink({
      entityType: 'player',
      leftProvider: 'understat',
      leftEntityId: identity,
      rightProvider: 'fpl',
      rightEntityId: identity,
      status: 'pending',
      method: 'integration-test',
      ruleId: 'test-rule',
      season,
      evidence: { candidateCount: 1 },
    });
    providerLinkIds.push(initial.id);
    const db = await getDb();
    const before = new Date('2098-08-08T12:00:00.000Z');
    await db
      .update(providerEntityLinks)
      .set({ updatedAt: before })
      .where(eq(providerEntityLinks.linkId, initial.id));

    await providerIdentityRepository.upsertEntityLink({
      entityType: 'player',
      leftProvider: 'understat',
      leftEntityId: identity,
      rightProvider: 'fpl',
      rightEntityId: identity,
      status: 'pending',
      method: 'integration-test',
      ruleId: 'test-rule',
      season,
      evidence: { candidateCount: 1 },
    });

    const [row] = await db
      .select({ updatedAt: providerEntityLinks.updatedAt })
      .from(providerEntityLinks)
      .where(eq(providerEntityLinks.linkId, initial.id));
    expect(row?.updatedAt).toEqual(before);
  });

  test('does not churn candidate revisions across seasons but tracks review transitions', async () => {
    const identity = `${baseId + 200}`;
    const initial = await providerIdentityRepository.upsertEntityLink({
      entityType: 'player',
      leftProvider: 'understat',
      leftEntityId: identity,
      rightProvider: 'fpl',
      rightEntityId: identity,
      status: 'pending',
      method: 'integration-test',
      ruleId: 'test-rule',
      season: '2728',
      evidence: { candidateCount: 1 },
    });
    providerLinkIds.push(initial.id);
    const db = await getDb();
    const before = new Date('2000-08-08T12:00:00.000Z');
    await db
      .update(providerEntityLinks)
      .set({ updatedAt: before })
      .where(eq(providerEntityLinks.linkId, initial.id));

    await providerIdentityRepository.upsertEntityLink({
      entityType: 'player',
      leftProvider: 'understat',
      leftEntityId: identity,
      rightProvider: 'fpl',
      rightEntityId: identity,
      status: 'pending',
      method: 'integration-test',
      ruleId: 'test-rule',
      season: '2829',
      evidence: { candidateCount: 2, observedMatches: 3 },
    });

    const [candidate] = await db
      .select({ updatedAt: providerEntityLinks.updatedAt })
      .from(providerEntityLinks)
      .where(eq(providerEntityLinks.linkId, initial.id));
    expect(candidate?.updatedAt).toEqual(before);

    await providerIdentityRepository.upsertEntityLink({
      entityType: 'player',
      leftProvider: 'understat',
      leftEntityId: identity,
      rightProvider: 'fpl',
      rightEntityId: identity,
      status: 'ambiguous',
      method: 'integration-test',
      ruleId: 'test-rule',
      season: '2829',
      evidence: { candidateCount: 2, observedMatches: 3 },
    });
    const [statusChanged] = await db
      .select({ updatedAt: providerEntityLinks.updatedAt })
      .from(providerEntityLinks)
      .where(eq(providerEntityLinks.linkId, initial.id));
    expect(statusChanged?.updatedAt.getTime()).toBeGreaterThan(before.getTime());

    const reviewed = await providerIdentityRepository.updateEntityStatus(initial.id, 'pending');
    expect(reviewed?.status).toBe('pending');
    const [reviewedRow] = await db
      .select({ updatedAt: providerEntityLinks.updatedAt })
      .from(providerEntityLinks)
      .where(eq(providerEntityLinks.linkId, initial.id));
    expect(reviewedRow?.updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });

  test('reconciles only stale evidence from a completed FPL fixture', async () => {
    const db = await getDb();
    await db.insert(fplSeasons).values({
      seasonId: seasonRef.seasonId,
      seasonCode: seasonRef.seasonCode,
      displayName: '2098/99',
      startYear: 2098,
      endYear: 2099,
      lifecycleState: 'completed',
      isCurrent: false,
    });
    await db
      .insert(events)
      .values({ seasonId: seasonRef.seasonId, eventId: fplEventId, name: 'Integration Event' });
    await db.insert(fplTeams).values(
      fplTeamIds.map((teamId, index) => ({
        seasonId: seasonRef.seasonId,
        teamId,
        code: teamId + 100,
        name: `FPL Integration Team ${index}`,
        shortName: `FI${index}`,
        pulseId: teamId + 200,
      })),
    );
    await db.insert(fplPlayers).values(
      fplPlayerIds.map((elementId, index) => ({
        seasonId: seasonRef.seasonId,
        elementId,
        code: elementId + 300,
        elementType: 3,
        teamId: fplTeamIds[0],
        webName: `FPL Integration Player ${index}`,
      })),
    );
    await db.insert(eventFixtures).values({
      seasonId: seasonRef.seasonId,
      fixtureId: fplFixtureId,
      code: fplFixtureId + 400,
      eventId: fplEventId,
      finished: true,
      teamHId: fplTeamIds[0],
      teamAId: fplTeamIds[1],
      pulseId: fplFixtureId + 500,
    });
    const repository = createFplPlayerFixtureStatsRepository(db);
    const evidence = fplPlayerIds.map((elementId, index) => ({
      eventId: fplEventId,
      fixtureId: fplFixtureId,
      elementId,
      minutes: index === 0 ? 90 : 10,
      starts: index === 0 ? 1 : 0,
      goals: 0,
      assists: 0,
      ownGoals: 0,
      yellowCards: 0,
      redCards: 0,
    }));

    expect(await repository.upsertEvidence(seasonRef, evidence)).toBe(2);
    const [fixtureBeforeDeletion] = await db
      .select({ updatedAt: eventFixtures.updatedAt })
      .from(eventFixtures)
      .where(
        and(
          eq(eventFixtures.seasonId, seasonRef.seasonId),
          eq(eventFixtures.fixtureId, fplFixtureId),
        ),
      );
    if (!fixtureBeforeDeletion) throw new Error('Fixture row missing before evidence deletion');
    await Bun.sleep(10);
    expect(await repository.upsertEvidence(seasonRef, [evidence[0]])).toBe(1);
    expect(await repository.upsertEvidence(seasonRef, [])).toBe(0);
    const rows = await db
      .select()
      .from(fplPlayerFixtureStats)
      .where(
        and(
          eq(fplPlayerFixtureStats.seasonId, seasonRef.seasonId),
          eq(fplPlayerFixtureStats.fixtureId, fplFixtureId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].elementId).toBe(fplPlayerIds[0]);
    const [fixtureAfterDeletion] = await db
      .select({ updatedAt: eventFixtures.updatedAt })
      .from(eventFixtures)
      .where(
        and(
          eq(eventFixtures.seasonId, seasonRef.seasonId),
          eq(eventFixtures.fixtureId, fplFixtureId),
        ),
      );
    if (!fixtureAfterDeletion) throw new Error('Fixture row missing after evidence deletion');
    expect(fixtureAfterDeletion.updatedAt.getTime()).toBeGreaterThan(
      fixtureBeforeDeletion.updatedAt.getTime(),
    );
  });
});
