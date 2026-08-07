import { and, eq, inArray, sql } from 'drizzle-orm';

import { eventFixtures, fplPlayerFixtureStats, players, teams } from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type {
  FplPlayerFixtureEvidence,
  FplPlayerFixtureStat,
} from '../domain/fpl-player-fixture-stats';
import { contentHash } from '../utils/content-hash';
import { logInfo, logWarn } from '../utils/logger';

async function getDatabase(dbInstance?: DbOrTransaction): Promise<DbOrTransaction> {
  return dbInstance ?? (await getDb());
}

export const createFplPlayerFixtureStatsRepository = (dbInstance?: DbOrTransaction) => ({
  async upsertEvidence(season: string, evidence: FplPlayerFixtureEvidence[]): Promise<number> {
    if (evidence.length === 0) return 0;
    const db = await getDatabase(dbInstance);
    const eventIds = new Set(evidence.map((row) => row.eventId));
    if (eventIds.size !== 1) {
      throw new Error('FPL fixture evidence reconcile requires exactly one event');
    }
    const eventId = evidence[0].eventId;
    const existing = await db
      .select({
        id: fplPlayerFixtureStats.id,
        fixtureId: fplPlayerFixtureStats.fixtureId,
        elementId: fplPlayerFixtureStats.elementId,
        playerCode: fplPlayerFixtureStats.playerCode,
        teamId: fplPlayerFixtureStats.teamId,
        teamCode: fplPlayerFixtureStats.teamCode,
        elementType: fplPlayerFixtureStats.elementType,
      })
      .from(fplPlayerFixtureStats)
      .where(
        and(eq(fplPlayerFixtureStats.season, season), eq(fplPlayerFixtureStats.eventId, eventId)),
      );
    const elementIds = [...new Set(evidence.map((row) => row.elementId))];
    const fixtureIds = [
      ...new Set([
        ...evidence.map((row) => row.fixtureId),
        ...existing.map((row) => row.fixtureId),
      ]),
    ];
    const [playerRows, fixtureRows] = await Promise.all([
      db
        .select({
          elementId: players.id,
          playerCode: players.code,
          elementType: players.type,
          teamId: players.teamId,
          teamCode: teams.code,
        })
        .from(players)
        .innerJoin(teams, eq(players.teamId, teams.id))
        .where(inArray(players.id, elementIds)),
      db
        .select({
          fixtureId: eventFixtures.id,
          fixtureCode: eventFixtures.code,
          eventId: eventFixtures.eventId,
          finished: eventFixtures.finished,
          homeTeamId: eventFixtures.teamHId,
          awayTeamId: eventFixtures.teamAId,
        })
        .from(eventFixtures)
        .where(inArray(eventFixtures.id, fixtureIds)),
    ]);
    const playersById = new Map(playerRows.map((row) => [row.elementId, row]));
    const fixturesById = new Map(fixtureRows.map((row) => [row.fixtureId, row]));
    const existingTeams = new Map(
      existing.map((row) => [`${row.fixtureId}:${row.playerCode}`, row]),
    );
    const existingByElement = new Map(
      existing.map((row) => [`${row.fixtureId}:${row.elementId}`, row]),
    );
    const skipped: string[] = [];
    const rows: FplPlayerFixtureStat[] = [];
    for (const raw of evidence) {
      const player = playersById.get(raw.elementId);
      const fixture = fixturesById.get(raw.fixtureId);
      const priorByElement = existingByElement.get(`${raw.fixtureId}:${raw.elementId}`);
      if (
        (!player && !priorByElement) ||
        !fixture ||
        (fixture.eventId !== null && fixture.eventId !== raw.eventId)
      ) {
        skipped.push(`${raw.fixtureId}:${raw.elementId}:missing-reference`);
        continue;
      }
      const currentTeamIsParticipant =
        player !== undefined &&
        (player.teamId === fixture.homeTeamId || player.teamId === fixture.awayTeamId);
      const playerCode = priorByElement?.playerCode ?? player!.playerCode;
      const prior = priorByElement ?? existingTeams.get(`${raw.fixtureId}:${playerCode}`);
      if ((!player || !currentTeamIsParticipant) && !prior) {
        skipped.push(`${raw.fixtureId}:${raw.elementId}:historical-team-unknown`);
        continue;
      }
      const preservePriorIdentity = priorByElement !== undefined || !currentTeamIsParticipant;
      const base = {
        ...raw,
        season,
        fixtureCode: fixture.fixtureCode,
        playerCode,
        teamId: preservePriorIdentity ? prior!.teamId : player!.teamId,
        teamCode: preservePriorIdentity ? prior!.teamCode : player!.teamCode,
        elementType: priorByElement?.elementType ?? player?.elementType ?? prior!.elementType,
      };
      rows.push({ ...base, sourceHash: contentHash(base) });
    }
    const incomingFixtureIds = new Set(rows.map((row) => row.fixtureId));
    const missingFinishedFixtures = new Set(
      existing
        .filter(
          (row) =>
            fixturesById.get(row.fixtureId)?.finished === true &&
            !incomingFixtureIds.has(row.fixtureId),
        )
        .map((row) => row.fixtureId),
    );
    for (const fixtureId of missingFinishedFixtures) {
      skipped.push(`${fixtureId}:*:empty-finished-fixture`);
    }
    if (skipped.length > 0) {
      logWarn('Skipped unresolved FPL player fixture evidence', {
        season,
        count: skipped.length,
        examples: skipped.slice(0, 10),
      });
    }
    const rowIdentities = new Set(rows.map((row) => `${row.fixtureId}:${row.playerCode}`));
    if (rowIdentities.size !== rows.length) {
      throw new Error(`Duplicate normalized FPL fixture evidence for event ${eventId}`);
    }
    const result =
      rows.length === 0
        ? []
        : await db
            .insert(fplPlayerFixtureStats)
            .values(rows)
            .onConflictDoUpdate({
              target: [
                fplPlayerFixtureStats.season,
                fplPlayerFixtureStats.fixtureId,
                fplPlayerFixtureStats.playerCode,
              ],
              set: {
                eventId: sql`excluded.event_id`,
                fixtureCode: sql`excluded.fixture_code`,
                elementId: sql`excluded.element_id`,
                teamId: sql`excluded.team_id`,
                teamCode: sql`excluded.team_code`,
                elementType: sql`excluded.element_type`,
                minutes: sql`excluded.minutes`,
                starts: sql`excluded.starts`,
                goals: sql`excluded.goals`,
                assists: sql`excluded.assists`,
                ownGoals: sql`excluded.own_goals`,
                yellowCards: sql`excluded.yellow_cards`,
                redCards: sql`excluded.red_cards`,
                sourceHash: sql`excluded.source_hash`,
                updatedAt: sql`NOW()`,
              },
              setWhere: sql`${fplPlayerFixtureStats.sourceHash} IS DISTINCT FROM excluded.source_hash`,
            })
            .returning({ id: fplPlayerFixtureStats.id });
    const staleIds =
      skipped.length > 0
        ? []
        : existing
            .filter(
              (row) =>
                fixturesById.get(row.fixtureId)?.finished === true &&
                !rowIdentities.has(`${row.fixtureId}:${row.playerCode}`),
            )
            .map((row) => row.id);
    if (staleIds.length > 0) {
      await db.delete(fplPlayerFixtureStats).where(inArray(fplPlayerFixtureStats.id, staleIds));
    }
    logInfo('FPL player fixture evidence reconciled', {
      season,
      eventId,
      upserted: result.length,
      deleted: staleIds.length,
    });
    return result.length + staleIds.length;
  },
});

export const fplPlayerFixtureStatsRepository = createFplPlayerFixtureStatsRepository();
