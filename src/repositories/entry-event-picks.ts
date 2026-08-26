import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { entryEventPicksInCompetition, playersInFpl } from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import { toNullableDbChip } from '../domain/chips';
import { isCompleteEntryPicks, isEntryPicksPayloadForEvent } from '../domain/entry-picks';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { RawFPLEntryEventPicksResponse } from '../types';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

export type EventLiveManagerPickRow = {
  entryId: number;
  position: number;
  elementId: number;
  multiplier: number;
  isCaptain: boolean;
  isViceCaptain: boolean;
  transfersCost: number | null;
  sourceUpdatedAt: Date;
  elementType: number;
  /** Event-scoped team identity; null means the scorer must fail closed. */
  teamId: number | null;
  activeChip: string | null;
};

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export const createEntryEventPicksRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  const findCompleteEntryIds = async (
    db: DbOrTransaction,
    season: FplSeasonRef,
    eventId: number,
    entryIds?: number[],
  ): Promise<number[]> => {
    const predicate = and(
      eq(entryEventPicksInCompetition.seasonId, season.seasonId),
      eq(entryEventPicksInCompetition.eventId, eventId),
      entryIds && entryIds.length > 0
        ? inArray(entryEventPicksInCompetition.entryId, entryIds)
        : undefined,
    );
    const rows = await db
      .select({ entryId: entryEventPicksInCompetition.entryId })
      .from(entryEventPicksInCompetition)
      .where(predicate)
      .groupBy(entryEventPicksInCompetition.entryId).having(sql`
        count(*) = 15
        AND min(${entryEventPicksInCompetition.position}) = 1
        AND max(${entryEventPicksInCompetition.position}) = 15
        AND count(*) FILTER (WHERE ${entryEventPicksInCompetition.isCaptain}) = 1
        AND count(*) FILTER (WHERE ${entryEventPicksInCompetition.isViceCaptain}) = 1
      `);
    return rows.map((row) => row.entryId);
  };

  const replaceScope = async (
    db: DbOrTransaction,
    season: FplSeasonRef,
    entryId: number,
    eventId: number,
    picks: RawFPLEntryEventPicksResponse,
    syncedAt: Date,
  ): Promise<boolean> => {
    const existing = await db
      .select({
        elementId: entryEventPicksInCompetition.elementId,
        eventTeamId: entryEventPicksInCompetition.eventTeamId,
        sourceCreatedAt: entryEventPicksInCompetition.sourceCreatedAt,
        sourceUpdatedAt: entryEventPicksInCompetition.sourceUpdatedAt,
      })
      .from(entryEventPicksInCompetition)
      .where(
        and(
          eq(entryEventPicksInCompetition.seasonId, season.seasonId),
          eq(entryEventPicksInCompetition.entryId, entryId),
          eq(entryEventPicksInCompetition.eventId, eventId),
        ),
      )
      .for('update');

    const newestStoredAt = existing.reduce<Date | null>(
      (latest, row) =>
        latest === null || row.sourceUpdatedAt > latest ? row.sourceUpdatedAt : latest,
      null,
    );
    if (newestStoredAt !== null && newestStoredAt >= syncedAt) {
      return false;
    }

    const sourceCreatedAt = existing.reduce<Date>(
      (earliest, row) => (row.sourceCreatedAt < earliest ? row.sourceCreatedAt : earliest),
      syncedAt,
    );
    // Preserve a null event-scoped team as an explicit unknown. Falling back
    // to the mutable current players.team_id on a retry could silently move a
    // historical pick to a post-deadline club after a transfer.
    const previouslyCapturedTeamByElement = new Map(
      existing.map((row) => [row.elementId, row.eventTeamId] as const),
    );
    await db
      .delete(entryEventPicksInCompetition)
      .where(
        and(
          eq(entryEventPicksInCompetition.seasonId, season.seasonId),
          eq(entryEventPicksInCompetition.entryId, entryId),
          eq(entryEventPicksInCompetition.eventId, eventId),
        ),
      );

    const activeChip = toNullableDbChip(picks.active_chip);
    const playerTeams = await db
      .select({
        elementId: playersInFpl.elementId,
        teamId: playersInFpl.teamId,
      })
      .from(playersInFpl)
      .where(
        and(
          eq(playersInFpl.seasonId, season.seasonId),
          inArray(
            playersInFpl.elementId,
            picks.picks.map((pick) => pick.element),
          ),
        ),
      );
    const teamByElement = new Map(playerTeams.map((row) => [row.elementId, row.teamId]));
    await db.insert(entryEventPicksInCompetition).values(
      picks.picks.map((pick) => ({
        seasonId: season.seasonId,
        entryId,
        eventId,
        position: pick.position,
        elementId: pick.element,
        // Capture the deadline-time observation. A missing player row stays
        // NULL and is never replaced with a later mutable players.team_id.
        eventTeamId: previouslyCapturedTeamByElement.has(pick.element)
          ? (previouslyCapturedTeamByElement.get(pick.element) ?? null)
          : (teamByElement.get(pick.element) ?? null),
        multiplier: pick.multiplier,
        isCaptain: pick.is_captain,
        isViceCaptain: pick.is_vice_captain,
        activeChip: pick.position === 1 ? activeChip : null,
        transfers: pick.position === 1 ? picks.entry_history.event_transfers : null,
        transfersCost: pick.position === 1 ? picks.entry_history.event_transfers_cost : null,
        sourceCreatedAt,
        sourceUpdatedAt: syncedAt,
      })),
    );
    return true;
  };

  return {
    findScoringPicksByEventAndEntryIds: async (
      season: FplSeasonRef,
      eventId: number,
      entryIds: readonly number[],
    ): Promise<EventLiveManagerPickRow[]> => {
      if (entryIds.length === 0) return [];
      try {
        const db = await getDbInstance();
        const rows: EventLiveManagerPickRow[] = [];
        for (const chunk of chunkArray(Array.from(new Set(entryIds)), 1000)) {
          rows.push(
            ...(await db
              .select({
                entryId: entryEventPicksInCompetition.entryId,
                position: entryEventPicksInCompetition.position,
                elementId: entryEventPicksInCompetition.elementId,
                multiplier: entryEventPicksInCompetition.multiplier,
                isCaptain: entryEventPicksInCompetition.isCaptain,
                isViceCaptain: entryEventPicksInCompetition.isViceCaptain,
                transfersCost: entryEventPicksInCompetition.transfersCost,
                sourceUpdatedAt: entryEventPicksInCompetition.sourceUpdatedAt,
                elementType: playersInFpl.elementType,
                teamId: sql<number | null>`COALESCE(
                  (
                    SELECT min(fixture_stat.team_id)
                    FROM fpl.player_fixture_stats fixture_stat
                    WHERE fixture_stat.season_id = ${entryEventPicksInCompetition.seasonId}
                      AND fixture_stat.event_id = ${entryEventPicksInCompetition.eventId}
                      AND fixture_stat.element_id = ${entryEventPicksInCompetition.elementId}
                    HAVING count(DISTINCT fixture_stat.team_id) = 1
                  ),
                  ${entryEventPicksInCompetition.eventTeamId}
                )`,
                activeChip: entryEventPicksInCompetition.activeChip,
              })
              .from(entryEventPicksInCompetition)
              .innerJoin(
                playersInFpl,
                and(
                  eq(playersInFpl.seasonId, entryEventPicksInCompetition.seasonId),
                  eq(playersInFpl.elementId, entryEventPicksInCompetition.elementId),
                ),
              )
              .where(
                and(
                  eq(entryEventPicksInCompetition.seasonId, season.seasonId),
                  eq(entryEventPicksInCompetition.eventId, eventId),
                  inArray(entryEventPicksInCompetition.entryId, chunk),
                ),
              )
              .orderBy(
                asc(entryEventPicksInCompetition.entryId),
                asc(entryEventPicksInCompetition.position),
              )),
          );
        }
        return rows;
      } catch (error) {
        logError('Failed to retrieve scoring picks by event and entries', error, {
          season: season.seasonCode,
          eventId,
          entries: entryIds.length,
        });
        throw new DatabaseError(
          'Failed to retrieve scoring picks by event and entries',
          'ENTRY_EVENT_PICKS_SCORING_FIND_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findEntryIdsByEvent: async (
      season: FplSeasonRef,
      eventId: number,
      entryIds?: number[],
    ): Promise<number[]> => {
      try {
        const db = await getDbInstance();
        if (!entryIds || entryIds.length === 0) {
          return await findCompleteEntryIds(db, season, eventId);
        }

        const uniqueEntryIds = Array.from(new Set(entryIds));
        const results: number[] = [];
        for (const chunk of chunkArray(uniqueEntryIds, 1000)) {
          results.push(...(await findCompleteEntryIds(db, season, eventId, chunk)));
        }
        return results;
      } catch (error) {
        logError('Failed to retrieve entry ids by event', error, {
          season: season.seasonCode,
          eventId,
        });
        throw new DatabaseError(
          'Failed to retrieve entry ids by event',
          'ENTRY_EVENT_PICKS_FIND_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    upsertFromPicks: async (
      season: FplSeasonRef,
      entryId: number,
      eventId: number,
      picks: RawFPLEntryEventPicksResponse,
      syncedAt: Date | string = new Date(),
    ): Promise<void> => {
      try {
        if (!isEntryPicksPayloadForEvent(picks, eventId)) {
          throw new Error(
            `Refusing entry picks for an unexpected event for entry ${entryId}, event ${eventId}`,
          );
        }
        if (!isCompleteEntryPicks(picks.picks)) {
          throw new Error(`Refusing incomplete entry picks for entry ${entryId}, event ${eventId}`);
        }

        const exactSyncedAt = syncedAt instanceof Date ? syncedAt : new Date(syncedAt);
        if (!Number.isFinite(exactSyncedAt.getTime())) {
          throw new Error('A valid picks source timestamp is required');
        }

        const changed = dbInstance
          ? await replaceScope(dbInstance, season, entryId, eventId, picks, exactSyncedAt)
          : await (
              await getDb()
            ).transaction((tx) => replaceScope(tx, season, entryId, eventId, picks, exactSyncedAt));
        logInfo(changed ? 'Replaced entry event picks' : 'Ignored stale entry event picks', {
          season: season.seasonCode,
          entryId,
          eventId,
        });
      } catch (error) {
        logError('Failed to upsert entry event picks', error, {
          season: season.seasonCode,
          entryId,
          eventId,
        });
        throw new DatabaseError(
          'Failed to upsert entry event picks',
          'ENTRY_EVENT_PICKS_UPSERT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

export const entryEventPicksRepository = createEntryEventPicksRepository();
