import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';

import {
  eventFixtures,
  events,
  fplPlayerFixtureStats,
  players as fplPlayers,
  providerEntityLinks,
  teams as fplTeams,
  understatMatches,
  understatPlayerMatchStats,
  understatPlayerSeasons,
  understatPlayerTeamSeasons,
  understatPlayers,
  understatSeasons,
  understatSyncItems,
  understatSyncRuns,
  understatTeamMatchStats,
  understatTeams,
  understatTeamSeasons,
  understatTeamStatSplits,
} from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import type {
  UnderstatMatch,
  UnderstatPlayer,
  UnderstatPlayerSeason,
  UnderstatTeam,
  UnderstatTeamMatchStat,
  UnderstatTeamSeason,
  UnderstatTeamStatSplit,
} from '../../src/domain/understat';
import {
  createUnderstatPlayerRepository,
  createUnderstatReferenceRepository,
  createUnderstatTeamRepository,
} from '../../src/repositories/understat';
import { persistUnderstatTeamDiscovery } from '../../src/repositories/understat-discovery';
import { createFplPlayerFixtureStatsRepository } from '../../src/repositories/fpl-player-fixture-stats';
import { understatSyncRepository } from '../../src/repositories/understat-sync';
import { providerIdentityRepository } from '../../src/repositories/provider-identity';
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
const league = `TEST_${baseId}`;
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

afterAll(async () => {
  const db = await getDb();
  await db.delete(fplPlayerFixtureStats).where(eq(fplPlayerFixtureStats.fixtureId, fplFixtureId));
  await db.delete(eventFixtures).where(eq(eventFixtures.id, fplFixtureId));
  await db.delete(fplPlayers).where(inArray(fplPlayers.id, fplPlayerIds));
  await db.delete(fplTeams).where(inArray(fplTeams.id, fplTeamIds));
  await db.delete(events).where(eq(events.id, fplEventId));
  if (providerLinkIds.length > 0) {
    await db.delete(providerEntityLinks).where(inArray(providerEntityLinks.id, providerLinkIds));
  }
  if (runIds.length > 0) {
    await db.delete(understatSyncItems).where(inArray(understatSyncItems.runId, runIds));
    await db.delete(understatSyncRuns).where(inArray(understatSyncRuns.runId, runIds));
  }
  await db.delete(understatPlayerMatchStats).where(eq(understatPlayerMatchStats.matchId, matchId));
  await db.delete(understatPlayerTeamSeasons).where(eq(understatPlayerTeamSeasons.season, season));
  await db.delete(understatPlayerSeasons).where(eq(understatPlayerSeasons.season, season));
  await db.delete(understatPlayers).where(inArray(understatPlayers.id, [...teamIds, playerId]));
  await db.delete(understatTeamStatSplits).where(eq(understatTeamStatSplits.season, season));
  await db.delete(understatTeamSeasons).where(eq(understatTeamSeasons.season, season));
  await db.delete(understatTeamMatchStats).where(eq(understatTeamMatchStats.matchId, matchId));
  await db.delete(understatMatches).where(eq(understatMatches.id, matchId));
  await db.delete(understatTeams).where(inArray(understatTeams.id, teamIds));
  await db.delete(understatSeasons).where(eq(understatSeasons.season, season));
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
      expect(
        await understatSyncRepository.completeItem(runId, 'league', league, 'hash', false),
      ).toBe(true);
    }
    const latest = await understatSyncRepository.findLatestRuns(season);
    expect(latest.team?.runId).not.toBe(latest.player?.runId);
    expect(latest.team?.status).toBe('ready_to_publish');
    expect(latest.player?.status).toBe('ready_to_publish');
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
      ruleVersion: 'test-v1',
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
      ruleVersion: 'test-v1',
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
      ruleVersion: 'test-v1',
      season: '2829',
    });

    expect(latest.firstSeenSeason).toBe('2627');
    expect(latest.lastSeenSeason).toBe('2829');
  });

  test('reconciles only stale evidence from a completed FPL fixture', async () => {
    const db = await getDb();
    await db.insert(events).values({ id: fplEventId, name: 'Integration Event' });
    await db.insert(fplTeams).values(
      fplTeamIds.map((id, index) => ({
        id,
        code: id + 100,
        name: `FPL Integration Team ${index}`,
        shortName: `FI${index}`,
        pulseId: id + 200,
      })),
    );
    await db.insert(fplPlayers).values(
      fplPlayerIds.map((id, index) => ({
        id,
        code: id + 300,
        type: 3,
        teamId: fplTeamIds[0],
        webName: `FPL Integration Player ${index}`,
      })),
    );
    await db.insert(eventFixtures).values({
      id: fplFixtureId,
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

    expect(await repository.upsertEvidence(season, evidence)).toBe(2);
    expect(await repository.upsertEvidence(season, [evidence[0]])).toBe(1);
    expect(await repository.upsertEvidence(season, [])).toBe(0);
    const rows = await db
      .select()
      .from(fplPlayerFixtureStats)
      .where(
        and(
          eq(fplPlayerFixtureStats.season, season),
          eq(fplPlayerFixtureStats.fixtureId, fplFixtureId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].elementId).toBe(fplPlayerIds[0]);
  });
});
