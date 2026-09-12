import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { and, eq, inArray } from 'drizzle-orm';
import postgres from 'postgres';

import {
  entityAliasesInBridge,
  entityLinksInBridge as providerEntityLinks,
  fixturesInFpl,
  eventsInFpl,
  matchesInUnderstat,
  playerFixtureStatsInFpl,
  playerMatchStatsInUnderstat,
  playerSeasonsInUnderstat,
  playersInFpl,
  playersInUnderstat,
  seasonsInFpl,
  seasonsInUnderstat,
  teamsInFpl,
  teamsInUnderstat,
  matchLinksInBridge as providerMatchLinks,
} from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import { providerIdentityRepository } from '../../src/repositories/provider-identity';
import {
  reconcileProviderPlayers,
  restoreQuarantinedProviderPlayers,
  inspectQuarantinedProviderPlayers,
} from '../../src/services/provider-matcher.service';
import { contentHash } from '../../src/utils/content-hash';

const baseId = 930_000_000 + Math.floor(Math.random() * 1_000_000);
const seasonId = 2080;
const season = '8081';
const understatTeamIds = [baseId + 1, baseId + 2];
const fplTeamIds = [baseId + 3, baseId + 4];
const fplTeamCodes = [baseId + 5, baseId + 6];
const eventIds = [baseId + 7, baseId + 8];
const understatMatchIds = [baseId + 9, baseId + 10];
const fplFixtureIds = [baseId + 11, baseId + 12];
const fplFixtureCodes = [baseId + 13, baseId + 14];
const understatPlayerIds = Array.from({ length: 22 }, (_, index) => baseId + 100 + index);
const targetUnderstatPlayerId = understatPlayerIds[0]!;
const seasonOnlyUnderstatPlayerId = baseId + 500;
const targetFplElementId = baseId + 200;
const targetFplCode = baseId + 201;
const seasonOnlyFplElementId = baseId + 202;
const seasonOnlyFplCode = baseId + 203;
const now = new Date('2100-08-08T12:00:00.000Z');
const observer = postgres(process.env.DATABASE_URL!, { max: 1 });
const entityLinkIds: string[] = [];
const matchLinkIds: string[] = [];

function hash(value: unknown): string {
  return contentHash(value);
}

async function cleanup(): Promise<void> {
  const db = await getDb();
  if (entityLinkIds.length > 0) {
    await db.delete(providerEntityLinks).where(inArray(providerEntityLinks.linkId, entityLinkIds));
    entityLinkIds.length = 0;
  }
  if (matchLinkIds.length > 0) {
    await db.delete(providerMatchLinks).where(inArray(providerMatchLinks.linkId, matchLinkIds));
    matchLinkIds.length = 0;
  }
  await db
    .delete(playerFixtureStatsInFpl)
    .where(
      and(
        eq(playerFixtureStatsInFpl.seasonId, seasonId),
        inArray(playerFixtureStatsInFpl.fixtureId, fplFixtureIds),
      ),
    );
  await db
    .delete(fixturesInFpl)
    .where(
      and(eq(fixturesInFpl.seasonId, seasonId), inArray(fixturesInFpl.fixtureId, fplFixtureIds)),
    );
  await db
    .delete(playersInFpl)
    .where(
      and(
        eq(playersInFpl.seasonId, seasonId),
        inArray(playersInFpl.elementId, [targetFplElementId, seasonOnlyFplElementId]),
      ),
    );
  await db
    .delete(teamsInFpl)
    .where(and(eq(teamsInFpl.seasonId, seasonId), inArray(teamsInFpl.teamId, fplTeamIds)));
  await db
    .delete(eventsInFpl)
    .where(and(eq(eventsInFpl.seasonId, seasonId), inArray(eventsInFpl.eventId, eventIds)));
  await db.delete(seasonsInFpl).where(eq(seasonsInFpl.seasonId, seasonId));

  await db
    .delete(playerMatchStatsInUnderstat)
    .where(inArray(playerMatchStatsInUnderstat.matchId, understatMatchIds));
  await db
    .delete(playerSeasonsInUnderstat)
    .where(
      and(
        eq(playerSeasonsInUnderstat.seasonCode, season),
        inArray(playerSeasonsInUnderstat.playerId, [
          targetUnderstatPlayerId,
          seasonOnlyUnderstatPlayerId,
        ]),
      ),
    );
  await db
    .delete(playersInUnderstat)
    .where(
      inArray(playersInUnderstat.playerId, [...understatPlayerIds, seasonOnlyUnderstatPlayerId]),
    );
  await db.delete(matchesInUnderstat).where(inArray(matchesInUnderstat.matchId, understatMatchIds));
  await db.delete(teamsInUnderstat).where(inArray(teamsInUnderstat.teamId, understatTeamIds));
  await db.delete(seasonsInUnderstat).where(eq(seasonsInUnderstat.seasonCode, season));
  await db
    .delete(entityAliasesInBridge)
    .where(
      and(
        eq(entityAliasesInBridge.entityType, 'player'),
        inArray(entityAliasesInBridge.providerEntityId, [
          String(targetUnderstatPlayerId),
          String(seasonOnlyUnderstatPlayerId),
          String(targetFplCode),
          String(seasonOnlyFplCode),
        ]),
      ),
    );
  await observer`DELETE FROM ops.mutation_scopes WHERE scope_key=${`understat:reference:${season}`}`;
}

async function seedGraph(): Promise<void> {
  const db = await getDb();
  await cleanup();

  await db.insert(seasonsInUnderstat).values({
    seasonCode: season,
    sourceYear: seasonId,
    league: 'EPL',
    state: 'complete',
    firstSeenAt: now,
    lastSeenAt: now,
  });
  await db.insert(teamsInUnderstat).values(
    understatTeamIds.map((teamId, index) => ({
      teamId,
      title: `Understat Transaction Team ${index}`,
      shortTitle: `UT${index}`,
      firstSeenSeason: season,
      lastSeenSeason: season,
      sourceHash: hash({ teamId, season }),
    })),
  );
  await db.insert(playersInUnderstat).values(
    [...understatPlayerIds, seasonOnlyUnderstatPlayerId].map((playerId, index) => ({
      playerId,
      name:
        index === 0
          ? 'Alexander Test'
          : playerId === seasonOnlyUnderstatPlayerId
            ? 'Season Only Example'
            : `Transaction Player ${index}`,
      favoritePosition: null,
      firstSeenSeason: season,
      lastSeenSeason: season,
      sourceHash: hash({ playerId, season }),
    })),
  );
  await db.insert(playerSeasonsInUnderstat).values([
    {
      seasonCode: season,
      playerId: targetUnderstatPlayerId,
      sourceName: 'Alexander Test',
      sourceTeamTitle: 'Understat Transaction Team 0',
      games: 2,
      timeMinutes: 156,
      goals: 1,
      nonPenaltyGoals: 1,
      assists: 0,
      shots: 2,
      keyPasses: 0,
      yellowCards: 1,
      redCards: 0,
      xg: 0.8,
      nonPenaltyXg: 0.8,
      xa: 0.1,
      xgChain: 0.9,
      xgBuildup: 0.2,
      position: 'FW',
      sourceHash: hash({ targetUnderstatPlayerId, season }),
    },
    {
      seasonCode: season,
      playerId: seasonOnlyUnderstatPlayerId,
      sourceName: 'Season Only Example',
      sourceTeamTitle: 'Understat Transaction Team 0',
      games: 0,
      timeMinutes: 0,
      goals: 0,
      nonPenaltyGoals: 0,
      assists: 0,
      shots: 0,
      keyPasses: 0,
      yellowCards: 0,
      redCards: 0,
      xg: 0,
      nonPenaltyXg: 0,
      xa: 0,
      xgChain: 0,
      xgBuildup: 0,
      position: 'FW',
      sourceHash: hash({ seasonOnlyUnderstatPlayerId, season }),
    },
  ]);
  await db.insert(matchesInUnderstat).values(
    understatMatchIds.map((matchId, index) => ({
      matchId,
      seasonCode: season,
      homeTeamId: understatTeamIds[0]!,
      awayTeamId: understatTeamIds[1]!,
      kickoffAt: new Date(now.getTime() + index * 86_400_000),
      isResult: true,
      homeGoals: 1,
      awayGoals: 0,
      homeXg: 1.1,
      awayXg: 0.4,
      forecastHomeWin: 0.6,
      forecastDraw: 0.2,
      forecastAwayWin: 0.2,
      sourceHash: hash({ matchId, season }),
      sourceCheckedAt: now,
      lastSeenAt: now,
    })),
  );
  await db.insert(playerMatchStatsInUnderstat).values(
    understatMatchIds.flatMap((matchId, matchIndex) =>
      understatPlayerIds.map((playerId, playerIndex) => ({
        rosterId: baseId + 1_000 + matchIndex * 100 + playerIndex,
        matchId,
        playerId,
        teamId: playerIndex < 11 ? understatTeamIds[0]! : understatTeamIds[1]!,
        playerName: playerIndex === 0 ? 'Alexander Test' : `Transaction Player ${playerIndex}`,
        side: playerIndex < 11 ? 'h' : 'a',
        position: playerIndex === 0 ? 'FW' : 'M',
        positionOrder: playerIndex,
        minutes: playerIndex === 0 ? (matchIndex === 0 ? 90 : 66) : 90,
        started: true,
        goals: playerIndex === 0 ? 1 : 0,
        ownGoals: 0,
        shots: playerIndex === 0 ? 2 : 0,
        keyPasses: 0,
        assists: 0,
        yellowCards: playerIndex === 0 ? 1 : 0,
        redCards: 0,
        xg: playerIndex === 0 ? 0.4 : 0,
        xa: 0,
        xgChain: 0,
        xgBuildup: 0,
        sourceHash: hash({ matchId, playerId }),
      })),
    ),
  );

  await db.insert(seasonsInFpl).values({
    seasonId,
    seasonCode: season,
    displayName: 'Understat mapping transaction fixture',
    startYear: seasonId,
    endYear: seasonId + 1,
    lifecycleState: 'completed',
    isCurrent: false,
  });
  await observer`
    INSERT INTO ops.mutation_scopes (scope_key, last_used_at)
    VALUES (${`understat:reference:${season}`}, clock_timestamp())
    ON CONFLICT (scope_key) DO NOTHING
  `;
  await db.insert(eventsInFpl).values(
    eventIds.map((eventId, index) => ({
      seasonId,
      eventId,
      name: `Transaction GW${index + 1}`,
      finished: true,
    })),
  );
  await db.insert(teamsInFpl).values(
    fplTeamIds.map((teamId, index) => ({
      seasonId,
      teamId,
      code: fplTeamCodes[index]!,
      name: `FPL Transaction Team ${index}`,
      shortName: `FT${index}`,
    })),
  );
  await db.insert(playersInFpl).values([
    {
      seasonId,
      elementId: targetFplElementId,
      code: targetFplCode,
      elementType: 4,
      teamId: fplTeamIds[0]!,
      firstName: 'Alexander',
      secondName: 'Test',
      webName: 'Test',
    },
    {
      seasonId,
      elementId: seasonOnlyFplElementId,
      code: seasonOnlyFplCode,
      elementType: 4,
      teamId: fplTeamIds[0]!,
      firstName: 'Season Only',
      secondName: 'Example',
      webName: 'Example',
    },
  ]);
  await db.insert(fixturesInFpl).values(
    fplFixtureIds.map((fixtureId, index) => ({
      seasonId,
      fixtureId,
      code: fplFixtureCodes[index]!,
      eventId: eventIds[index]!,
      kickoffTime: new Date(now.getTime() + index * 86_400_000),
      started: true,
      finished: true,
      minutes: 90,
      teamHId: fplTeamIds[0]!,
      teamAId: fplTeamIds[1]!,
      teamHScore: 1,
      teamAScore: 0,
      pulseId: baseId + 1_100 + index,
    })),
  );
  await db.insert(playerFixtureStatsInFpl).values(
    fplFixtureIds.map((fixtureId, index) => ({
      seasonId,
      fixtureId,
      eventId: eventIds[index]!,
      fixtureCode: fplFixtureCodes[index]!,
      elementId: targetFplElementId,
      playerCode: targetFplCode,
      teamId: fplTeamIds[0]!,
      teamCode: fplTeamCodes[0]!,
      elementType: 4,
      minutes: index === 0 ? 90 : 63,
      starts: 1,
      goals: 0,
      assists: 1,
      ownGoals: 0,
      yellowCards: 0,
      redCards: index === 0 ? 1 : 0,
      sourceHash: hash({ fixtureId, targetFplCode }),
    })),
  );

  for (const [index, understatTeamId] of understatTeamIds.entries()) {
    const link = await providerIdentityRepository.upsertEntityLink({
      entityType: 'team',
      leftProvider: 'understat',
      leftEntityId: String(understatTeamId),
      rightProvider: 'fpl',
      rightEntityId: String(fplTeamCodes[index]!),
      status: 'auto_verified',
      method: 'integration-test',
      ruleId: 'integration-test-team',
      season,
      evidence: { confirmedSeasons: [season] },
    });
    entityLinkIds.push(link.id);
  }
  for (const [index, understatMatchId] of understatMatchIds.entries()) {
    const link = await providerIdentityRepository.upsertMatchLink({
      season,
      leftProvider: 'understat',
      leftMatchId: String(understatMatchId),
      rightProvider: 'fpl',
      rightMatchId: String(fplFixtureCodes[index]!),
      status: 'auto_verified',
      method: 'integration-test',
      ruleId: 'integration-test-match',
    });
    matchLinkIds.push(link.id);
  }
  const playerLink = await providerIdentityRepository.upsertEntityLink({
    entityType: 'player',
    leftProvider: 'understat',
    leftEntityId: String(targetUnderstatPlayerId),
    rightProvider: 'fpl',
    rightEntityId: String(targetFplCode),
    status: 'auto_verified',
    method: 'integration-test',
    ruleId: 'integration-test-player',
    season,
    evidence: { confirmedSeasons: ['8999'] },
  });
  entityLinkIds.push(playerLink.id);
  const seasonOnlyPlayerLink = await providerIdentityRepository.upsertEntityLink({
    entityType: 'player',
    leftProvider: 'understat',
    leftEntityId: String(seasonOnlyUnderstatPlayerId),
    rightProvider: 'fpl',
    rightEntityId: String(seasonOnlyFplCode),
    status: 'quarantined',
    method: 'integration-test-quarantine',
    ruleId: 'integration-test-player',
    season,
    evidence: { confirmedSeasons: ['8999'] },
  });
  entityLinkIds.push(seasonOnlyPlayerLink.id);
}

beforeAll(seedGraph);
afterAll(async () => {
  await cleanup();
  await observer.end();
});

test('keeps verified identity across stat differences and applies recovery inside the scope', async () => {
  const reconciliation = await reconcileProviderPlayers(season);
  expect(reconciliation.confirmed).toBe(1);

  const db = await getDb();
  const [confirmed] = await db
    .select({ status: providerEntityLinks.status, evidence: providerEntityLinks.evidence })
    .from(providerEntityLinks)
    .where(eq(providerEntityLinks.linkId, entityLinkIds.at(-2)!));
  expect(confirmed?.status).toBe('auto_verified');
  expect((confirmed?.evidence as { confirmedSeasons?: string[] }).confirmedSeasons).toContain(
    season,
  );

  await db
    .update(providerEntityLinks)
    .set({ status: 'quarantined', firstSeenSeason: '2526', lastSeenSeason: '2526' })
    .where(inArray(providerEntityLinks.linkId, [entityLinkIds.at(-2)!, entityLinkIds.at(-1)!]));
  const report = await inspectQuarantinedProviderPlayers(season);
  const item = report.items.find((candidate) => candidate.linkId === entityLinkIds.at(-1));
  expect(item?.fplName).toBe('Season Only Example');
  expect(item?.understatName).toBe('Season Only Example');
  expect(item?.disposition).toBe('insufficient_evidence');
  expect(item?.reasonCodes).toContain('OBSERVED_MATCHES_BELOW_MINIMUM');
  const targetItem = report.items.find((candidate) => candidate.linkId === entityLinkIds.at(-2));
  expect(targetItem?.disposition).toBe('recoverable');
  expect(targetItem?.observedMatchIds).toHaveLength(2);

  const staleApproval = await restoreQuarantinedProviderPlayers(season, [
    {
      linkId: targetItem!.linkId,
      understatPlayerId: targetItem!.understatPlayerId!,
      fplPlayerCode: targetItem!.fplPlayerCode,
      evidenceHash: '0'.repeat(64),
    },
  ]);
  expect(staleApproval.applied).toEqual([]);
  expect(staleApproval.skipped).toEqual([
    { linkId: targetItem!.linkId, reason: 'APPROVAL_NO_LONGER_MATCHES_REPORT' },
  ]);

  let lockObserved = false;
  const originalUpsert = providerIdentityRepository.upsertEntityLink.bind(
    providerIdentityRepository,
  );
  const upsertSpy = spyOn(providerIdentityRepository, 'upsertEntityLink').mockImplementation(
    async (input) => {
      await expect(
        observer.begin(async (tx) => {
          await tx`
            SELECT scope_key
            FROM ops.mutation_scopes
            WHERE scope_key = ${`understat:reference:${season}`}
            FOR UPDATE NOWAIT
          `;
        }),
      ).rejects.toMatchObject({ code: '55P03' });
      lockObserved = true;
      return originalUpsert(input);
    },
  );

  let applied: Awaited<ReturnType<typeof restoreQuarantinedProviderPlayers>>;
  try {
    applied = await restoreQuarantinedProviderPlayers(season, [
      {
        linkId: targetItem!.linkId,
        understatPlayerId: targetItem!.understatPlayerId!,
        fplPlayerCode: targetItem!.fplPlayerCode,
        evidenceHash: targetItem!.evidenceHash,
      },
    ]);
  } finally {
    upsertSpy.mockRestore();
  }
  expect(lockObserved).toBe(true);
  expect(applied.applied).toEqual([targetItem!.linkId]);
  expect(applied.skipped).toEqual([]);
  const [restored] = await db
    .select({
      status: providerEntityLinks.status,
      method: providerEntityLinks.method,
      evidence: providerEntityLinks.evidence,
    })
    .from(providerEntityLinks)
    .where(eq(providerEntityLinks.linkId, targetItem!.linkId));
  expect(restored?.status).toBe('auto_verified');
  expect(restored?.method).toBe('verified-match-roster-recovery');
  expect((restored?.evidence as { confirmedSeasons?: string[] }).confirmedSeasons).toEqual([
    season,
    '8999',
  ]);
  expect(
    (restored?.evidence as { recovery?: { observedMatchIds?: number[] } }).recovery
      ?.observedMatchIds,
  ).toHaveLength(2);
  expect(
    (restored?.evidence as { recovery?: { reasonCodes?: string[] } }).recovery?.reasonCodes,
  ).toEqual(['PRIOR_IDENTITY_AND_COMPLETE_MATCH_EVIDENCE']);
  const fplMinutes = await db
    .select({ minutes: playerFixtureStatsInFpl.minutes })
    .from(playerFixtureStatsInFpl)
    .where(
      and(
        eq(playerFixtureStatsInFpl.seasonId, seasonId),
        eq(playerFixtureStatsInFpl.elementId, targetFplElementId),
      ),
    );
  const understatMinutes = await db
    .select({ minutes: playerMatchStatsInUnderstat.minutes })
    .from(playerMatchStatsInUnderstat)
    .where(eq(playerMatchStatsInUnderstat.playerId, targetUnderstatPlayerId));
  expect(fplMinutes.map((row) => row.minutes).sort((a, b) => a - b)).toEqual([63, 90]);
  expect(understatMinutes.map((row) => row.minutes).sort((a, b) => a - b)).toEqual([66, 90]);

  const repeated = await restoreQuarantinedProviderPlayers(season, [
    {
      linkId: targetItem!.linkId,
      understatPlayerId: targetItem!.understatPlayerId!,
      fplPlayerCode: targetItem!.fplPlayerCode,
      evidenceHash: targetItem!.evidenceHash,
    },
  ]);
  expect(repeated.applied).toEqual([]);
  expect(repeated.skipped).toEqual([
    { linkId: targetItem!.linkId, reason: 'NOT_CURRENTLY_QUARANTINED' },
  ]);
});
