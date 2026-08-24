import { and, eq, inArray, or, sql } from 'drizzle-orm';

import {
  fixturesInFpl,
  playerFixtureStatsInFpl,
  playersInFpl,
  teamsInFpl,
  type DbPlayerFixtureStatInsert,
} from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type {
  FplPlayerFixtureEvidence,
  FplPlayerFixtureStat,
} from '../domain/fpl-player-fixture-stats';
import type { FplSeasonRef } from '../domain/fpl-season';
import { contentHash } from '../utils/content-hash';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo, logWarn } from '../utils/logger';

export const createFplPlayerFixtureStatsRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  return {
    upsertEvidence: async (
      season: FplSeasonRef,
      evidence: readonly FplPlayerFixtureEvidence[],
    ): Promise<number> => {
      if (evidence.length === 0) return 0;

      const eventIds = new Set(evidence.map((row) => row.eventId));
      if (eventIds.size !== 1) {
        throw new DatabaseError(
          'FPL fixture evidence reconcile requires exactly one event',
          'FIXTURE_EVIDENCE_EVENT_SCOPE_ERROR',
        );
      }

      const eventId = evidence[0].eventId;
      try {
        const db = await getDbInstance();
        const existing = await db
          .select({
            fixtureId: playerFixtureStatsInFpl.fixtureId,
            elementId: playerFixtureStatsInFpl.elementId,
            playerCode: playerFixtureStatsInFpl.playerCode,
            teamId: playerFixtureStatsInFpl.teamId,
            teamCode: playerFixtureStatsInFpl.teamCode,
            elementType: playerFixtureStatsInFpl.elementType,
          })
          .from(playerFixtureStatsInFpl)
          .where(
            and(
              eq(playerFixtureStatsInFpl.seasonId, season.seasonId),
              eq(playerFixtureStatsInFpl.eventId, eventId),
            ),
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
              elementId: playersInFpl.elementId,
              playerCode: playersInFpl.code,
              elementType: playersInFpl.elementType,
              teamId: playersInFpl.teamId,
              teamCode: teamsInFpl.code,
            })
            .from(playersInFpl)
            .innerJoin(
              teamsInFpl,
              and(
                eq(playersInFpl.seasonId, teamsInFpl.seasonId),
                eq(playersInFpl.teamId, teamsInFpl.teamId),
              ),
            )
            .where(
              and(
                eq(playersInFpl.seasonId, season.seasonId),
                inArray(playersInFpl.elementId, elementIds),
              ),
            ),
          db
            .select({
              fixtureId: fixturesInFpl.fixtureId,
              fixtureCode: fixturesInFpl.code,
              eventId: fixturesInFpl.eventId,
              finished: fixturesInFpl.finished,
              homeTeamId: fixturesInFpl.teamHId,
              awayTeamId: fixturesInFpl.teamAId,
            })
            .from(fixturesInFpl)
            .where(
              and(
                eq(fixturesInFpl.seasonId, season.seasonId),
                inArray(fixturesInFpl.fixtureId, fixtureIds),
              ),
            ),
        ]);

        const playersById = new Map(playerRows.map((row) => [row.elementId, row]));
        const fixturesById = new Map(fixtureRows.map((row) => [row.fixtureId, row]));
        const existingByElement = new Map(
          existing.map((row) => [`${row.fixtureId}:${row.elementId}`, row]),
        );
        const unresolvedIncoming: string[] = [];
        const normalized: FplPlayerFixtureStat[] = [];

        for (const raw of evidence) {
          const player = playersById.get(raw.elementId);
          const fixture = fixturesById.get(raw.fixtureId);
          const prior = existingByElement.get(`${raw.fixtureId}:${raw.elementId}`);
          if (
            (!player && !prior) ||
            !fixture ||
            (fixture.eventId !== null && fixture.eventId !== raw.eventId)
          ) {
            unresolvedIncoming.push(`${raw.fixtureId}:${raw.elementId}:missing-reference`);
            continue;
          }

          const currentTeamIsParticipant =
            player !== undefined &&
            (player.teamId === fixture.homeTeamId || player.teamId === fixture.awayTeamId);
          if ((!player || !currentTeamIsParticipant) && !prior) {
            unresolvedIncoming.push(`${raw.fixtureId}:${raw.elementId}:historical-team-unknown`);
            continue;
          }

          const preservePriorIdentity = prior !== undefined || !currentTeamIsParticipant;
          const base = {
            ...raw,
            seasonId: season.seasonId,
            fixtureCode: fixture.fixtureCode,
            playerCode: prior?.playerCode ?? player!.playerCode,
            teamId: preservePriorIdentity ? prior!.teamId : player!.teamId,
            teamCode: preservePriorIdentity ? prior!.teamCode : player!.teamCode,
            elementType: prior?.elementType ?? player!.elementType,
          };
          normalized.push({ ...base, sourceHash: contentHash(base) });
        }

        if (unresolvedIncoming.length > 0) {
          throw new Error(
            `Unresolved FPL fixture evidence for event ${eventId}: ${unresolvedIncoming
              .slice(0, 10)
              .join(',')}`,
          );
        }

        const incomingIdentities = new Set(
          normalized.map((row) => `${row.fixtureId}:${row.elementId}`),
        );
        if (incomingIdentities.size !== normalized.length) {
          throw new Error(`Duplicate normalized FPL fixture evidence for event ${eventId}`);
        }

        const incomingFixtureIds = new Set(normalized.map((row) => row.fixtureId));
        const deletionBlocks: string[] = [];
        for (const row of existing) {
          if (
            fixturesById.get(row.fixtureId)?.finished === true &&
            !incomingFixtureIds.has(row.fixtureId)
          ) {
            deletionBlocks.push(`${row.fixtureId}:*:empty-finished-fixture`);
          }
        }
        if (deletionBlocks.length > 0) {
          logWarn('Preserved prior fixture evidence because the finished fixture is absent', {
            season: season.seasonCode,
            eventId,
            count: deletionBlocks.length,
            examples: deletionBlocks.slice(0, 10),
          });
        }

        const rows: DbPlayerFixtureStatInsert[] = normalized;
        const changed =
          rows.length === 0
            ? []
            : await db
                .insert(playerFixtureStatsInFpl)
                .values(rows)
                .onConflictDoUpdate({
                  target: [
                    playerFixtureStatsInFpl.seasonId,
                    playerFixtureStatsInFpl.fixtureId,
                    playerFixtureStatsInFpl.elementId,
                  ],
                  set: {
                    eventId: sql`excluded.event_id`,
                    fixtureCode: sql`excluded.fixture_code`,
                    playerCode: sql`excluded.player_code`,
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
                  setWhere: sql`${playerFixtureStatsInFpl.sourceHash} IS DISTINCT FROM excluded.source_hash`,
                })
                .returning({ sourceFixtureStatId: playerFixtureStatsInFpl.sourceFixtureStatId });

        const stale =
          deletionBlocks.length > 0
            ? []
            : existing.filter(
                (row) =>
                  fixturesById.get(row.fixtureId)?.finished === true &&
                  !incomingIdentities.has(`${row.fixtureId}:${row.elementId}`),
              );
        let deletedCount = 0;
        if (stale.length > 0) {
          const staleFixtureIds = [...new Set(stale.map((row) => row.fixtureId))];
          const deleted = await db
            .delete(playerFixtureStatsInFpl)
            .where(
              and(
                eq(playerFixtureStatsInFpl.seasonId, season.seasonId),
                eq(playerFixtureStatsInFpl.eventId, eventId),
                or(
                  ...stale.map((row) =>
                    and(
                      eq(playerFixtureStatsInFpl.fixtureId, row.fixtureId),
                      eq(playerFixtureStatsInFpl.elementId, row.elementId),
                    ),
                  ),
                ),
              ),
            )
            .returning({ elementId: playerFixtureStatsInFpl.elementId });
          deletedCount = deleted.length;
          if (deletedCount > 0) {
            // A deletion has no surviving player_fixture_stats.updated_at row
            // to advance the Player State repair selector.  Touch the owning
            // fixture in the same transaction as a durable deletion tombstone;
            // fixture.updated_at is already part of that selector's FPL source
            // watermark and needs no extra table or migration.
            await db
              .update(fixturesInFpl)
              .set({ updatedAt: sql`clock_timestamp()` })
              .where(
                and(
                  eq(fixturesInFpl.seasonId, season.seasonId),
                  inArray(fixturesInFpl.fixtureId, staleFixtureIds),
                ),
              );
          }
        }

        logInfo('FPL player fixture evidence reconciled', {
          season: season.seasonCode,
          eventId,
          changed: changed.length,
          deleted: deletedCount,
        });
        return changed.length + deletedCount;
      } catch (error) {
        logError('Failed to reconcile FPL player fixture evidence', error, {
          season: season.seasonCode,
          eventId,
          count: evidence.length,
        });
        throw new DatabaseError(
          'Failed to reconcile FPL player fixture evidence',
          'FIXTURE_EVIDENCE_UPSERT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

export const fplPlayerFixtureStatsRepository = createFplPlayerFixtureStatsRepository();
