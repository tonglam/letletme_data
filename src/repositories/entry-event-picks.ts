import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import {
  entryEventPickHeadsInCompetition,
  entryEventPicksInCompetition,
  playersInFpl,
} from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import { toNullableDbChip } from '../domain/chips';
import { isCompleteEntryPicks, isEntryPicksPayloadForEvent } from '../domain/entry-picks';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { RawFPLEntryEventPicksResponse } from '../types';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import { contentHash } from '../utils/content-hash';

export type EventLiveManagerPickRow = {
  entryId: number;
  position: number;
  elementId: number;
  multiplier: number;
  isCaptain: boolean;
  isViceCaptain: boolean;
  transfers: number | null;
  transfersCost: number | null;
  sourceUpdatedAt: Date;
  elementType: number;
  /** Event-scoped team identity; null means the scorer must fail closed. */
  teamId: number | null;
  activeChip: string | null;
};

export type EntryEventPicksPublicationMetadata = {
  readonly publicationId?: string;
  readonly generation?: number;
  readonly picksBaseRevision?: string;
  readonly contentUpdatedAt?: Date | string;
  /** Durable completion time for a Redis-first V2 checkpoint. */
  readonly checkpointedAt?: Date | string;
};

export type EntryEventPickHeadMetadata = {
  readonly publicationId: string;
  readonly generation: number;
  readonly picksBaseRevision: string;
  readonly contentSha256: string;
  readonly rowCount: number;
  readonly sourceCheckedAt: Date;
  readonly contentUpdatedAt: Date;
  readonly checkpointedAt: Date;
  readonly state: string;
};

function normalizedPickContent(picks: RawFPLEntryEventPicksResponse) {
  return {
    picks: picks.picks
      .map((pick) => ({
        element: pick.element,
        position: pick.position,
        multiplier: pick.multiplier,
        isCaptain: pick.is_captain,
        isViceCaptain: pick.is_vice_captain,
      }))
      .sort((left, right) => left.position - right.position),
    chip: picks.active_chip ?? null,
    transferCount: picks.entry_history.event_transfers,
    transferCost: picks.entry_history.event_transfers_cost,
  };
}

function pickContentHash(picks: RawFPLEntryEventPicksResponse): string {
  return contentHash(normalizedPickContent(picks));
}

async function upsertEntryEventPickHead(
  db: DbOrTransaction,
  season: FplSeasonRef,
  entryId: number,
  eventId: number,
  picks: RawFPLEntryEventPicksResponse,
  syncedAt: Date,
  publication: EntryEventPicksPublicationMetadata | undefined,
  contentUpdatedAt: Date,
): Promise<void> {
  const contentSha256 = pickContentHash(picks);
  const checkpointedAt = publication?.checkpointedAt
    ? publication.checkpointedAt instanceof Date
      ? publication.checkpointedAt
      : new Date(publication.checkpointedAt)
    : syncedAt;
  if (!Number.isFinite(checkpointedAt.getTime())) {
    throw new Error('A valid picks checkpoint timestamp is required');
  }
  const [existingHead] = await db
    .select({
      publicationId: entryEventPickHeadsInCompetition.publicationId,
      generation: entryEventPickHeadsInCompetition.generation,
      picksBaseRevision: entryEventPickHeadsInCompetition.picksBaseRevision,
      contentSha256: entryEventPickHeadsInCompetition.contentSha256,
      rowCount: entryEventPickHeadsInCompetition.rowCount,
      sourceCheckedAt: entryEventPickHeadsInCompetition.sourceCheckedAt,
      contentUpdatedAt: entryEventPickHeadsInCompetition.contentUpdatedAt,
      checkpointedAt: entryEventPickHeadsInCompetition.checkpointedAt,
      state: entryEventPickHeadsInCompetition.state,
    })
    .from(entryEventPickHeadsInCompetition)
    .where(
      and(
        eq(entryEventPickHeadsInCompetition.seasonId, season.seasonId),
        eq(entryEventPickHeadsInCompetition.entryId, entryId),
        eq(entryEventPickHeadsInCompetition.eventId, eventId),
      ),
    )
    .limit(1);
  if (
    existingHead &&
    publication?.generation !== undefined &&
    publication.generation < existingHead.generation
  ) {
    throw new Error('A stale V2 entry picks publication cannot replace the durable head');
  }
  if (
    existingHead &&
    publication?.generation === existingHead.generation &&
    publication.publicationId !== undefined &&
    publication.publicationId !== existingHead.publicationId
  ) {
    throw new Error('A conflicting V2 entry picks publication cannot replace the durable head');
  }
  const fallbackPublicationId = contentHash({
    season: season.seasonCode,
    entryId,
    eventId,
    contentSha256,
  });
  const effectivePublicationId =
    publication?.publicationId ?? existingHead?.publicationId ?? fallbackPublicationId;
  const effectiveGeneration = publication?.generation ?? existingHead?.generation ?? 1;
  const effectivePicksBaseRevision =
    publication?.picksBaseRevision ?? existingHead?.picksBaseRevision ?? contentSha256;
  await db
    .insert(entryEventPickHeadsInCompetition)
    .values({
      seasonId: season.seasonId,
      entryId,
      eventId,
      publicationId: effectivePublicationId,
      generation: effectiveGeneration,
      picksBaseRevision: effectivePicksBaseRevision,
      contentSha256,
      rowCount: 15,
      sourceCheckedAt: syncedAt,
      contentUpdatedAt,
      checkpointedAt,
      state: 'COMPLETE',
    })
    .onConflictDoUpdate({
      target: [
        entryEventPickHeadsInCompetition.seasonId,
        entryEventPickHeadsInCompetition.entryId,
        entryEventPickHeadsInCompetition.eventId,
      ],
      set: {
        publicationId: effectivePublicationId,
        generation: effectiveGeneration,
        picksBaseRevision: effectivePicksBaseRevision,
        contentSha256,
        rowCount: 15,
        sourceCheckedAt: syncedAt,
        contentUpdatedAt,
        checkpointedAt,
        state: 'COMPLETE',
      },
    });
}

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
    publication?: EntryEventPicksPublicationMetadata,
  ): Promise<boolean> => {
    const existing = await db
      .select({
        position: entryEventPicksInCompetition.position,
        elementId: entryEventPicksInCompetition.elementId,
        eventTeamId: entryEventPicksInCompetition.eventTeamId,
        multiplier: entryEventPicksInCompetition.multiplier,
        isCaptain: entryEventPicksInCompetition.isCaptain,
        isViceCaptain: entryEventPicksInCompetition.isViceCaptain,
        transfers: entryEventPicksInCompetition.transfers,
        activeChip: entryEventPicksInCompetition.activeChip,
        transfersCost: entryEventPicksInCompetition.transfersCost,
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

    const candidateContent = normalizedPickContent(picks);
    const candidateByPosition = new Map(
      candidateContent.picks.map((pick) => [pick.position, pick] as const),
    );
    const existingContentIsComplete =
      existing.length === 15 &&
      existing.every((row) => {
        const candidate = candidateByPosition.get(row.position);
        return (
          candidate !== undefined &&
          candidate.element === row.elementId &&
          candidate.multiplier === row.multiplier &&
          candidate.isCaptain === row.isCaptain &&
          candidate.isViceCaptain === row.isViceCaptain
        );
      });
    const existingChip = existing.find((row) => row.position === 1)?.activeChip ?? null;
    const existingTransfers = existing.find((row) => row.position === 1)?.transfers ?? null;
    const existingTransferCost = existing.find((row) => row.position === 1)?.transfersCost ?? null;
    const sameContent =
      existingContentIsComplete &&
      existingChip === candidateContent.chip &&
      existingTransfers === candidateContent.transferCount &&
      existingTransferCost === candidateContent.transferCost;

    // A source heartbeat must not rewrite the 15 rows or move their content
    // timestamp.  It may still repair a missing V2 head left by an interrupted
    // Redis-first publication, so the head is checkpointed below without a
    // delete/insert cycle.
    if (sameContent) {
      const [existingHead] = await db
        .select({
          publicationId: entryEventPickHeadsInCompetition.publicationId,
          picksBaseRevision: entryEventPickHeadsInCompetition.picksBaseRevision,
          contentUpdatedAt: entryEventPickHeadsInCompetition.contentUpdatedAt,
        })
        .from(entryEventPickHeadsInCompetition)
        .where(
          and(
            eq(entryEventPickHeadsInCompetition.seasonId, season.seasonId),
            eq(entryEventPickHeadsInCompetition.entryId, entryId),
            eq(entryEventPickHeadsInCompetition.eventId, eventId),
          ),
        )
        .limit(1);
      const requestedContentUpdatedAt = publication?.contentUpdatedAt
        ? publication.contentUpdatedAt instanceof Date
          ? publication.contentUpdatedAt
          : new Date(publication.contentUpdatedAt)
        : (existingHead?.contentUpdatedAt ?? syncedAt);
      if (!Number.isFinite(requestedContentUpdatedAt.getTime())) {
        throw new Error('A valid picks content timestamp is required');
      }
      await upsertEntryEventPickHead(
        db,
        season,
        entryId,
        eventId,
        picks,
        syncedAt,
        publication,
        requestedContentUpdatedAt,
      );
      return false;
    }

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
    const candidatePositions = new Set(picks.picks.map((pick) => pick.position));
    const candidateElementByPosition = new Map(
      picks.picks.map((pick) => [pick.position, pick.element] as const),
    );
    const stalePositions = existing
      .filter(
        (row) =>
          !candidatePositions.has(row.position) ||
          candidateElementByPosition.get(row.position) !== row.elementId,
      )
      .map((row) => row.position);
    if (stalePositions.length > 0) {
      await db
        .delete(entryEventPicksInCompetition)
        .where(
          and(
            eq(entryEventPicksInCompetition.seasonId, season.seasonId),
            eq(entryEventPicksInCompetition.entryId, entryId),
            eq(entryEventPicksInCompetition.eventId, eventId),
            inArray(entryEventPicksInCompetition.position, stalePositions),
          ),
        );
    }

    const rows = picks.picks.map((pick) => ({
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
    }));
    await db
      .insert(entryEventPicksInCompetition)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          entryEventPicksInCompetition.seasonId,
          entryEventPicksInCompetition.entryId,
          entryEventPicksInCompetition.eventId,
          entryEventPicksInCompetition.position,
        ],
        set: {
          elementId: sql`excluded.element_id`,
          eventTeamId: sql`excluded.event_team_id`,
          multiplier: sql`excluded.multiplier`,
          isCaptain: sql`excluded.is_captain`,
          isViceCaptain: sql`excluded.is_vice_captain`,
          activeChip: sql`excluded.active_chip`,
          transfers: sql`excluded.transfers`,
          transfersCost: sql`excluded.transfers_cost`,
          sourceCreatedAt: sql`excluded.source_created_at`,
          sourceUpdatedAt: sql`excluded.source_updated_at`,
        },
      });

    const contentUpdatedAt = publication?.contentUpdatedAt
      ? publication.contentUpdatedAt instanceof Date
        ? publication.contentUpdatedAt
        : new Date(publication.contentUpdatedAt)
      : syncedAt;
    if (!Number.isFinite(contentUpdatedAt.getTime())) {
      throw new Error('A valid picks content timestamp is required');
    }
    await upsertEntryEventPickHead(
      db,
      season,
      entryId,
      eventId,
      picks,
      syncedAt,
      publication,
      contentUpdatedAt,
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
                transfers: entryEventPicksInCompetition.transfers,
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

    findHead: async (
      season: FplSeasonRef,
      entryId: number,
      eventId: number,
    ): Promise<EntryEventPickHeadMetadata | null> => {
      try {
        const db = await getDbInstance();
        const [row] = await db
          .select({
            publicationId: entryEventPickHeadsInCompetition.publicationId,
            generation: entryEventPickHeadsInCompetition.generation,
            picksBaseRevision: entryEventPickHeadsInCompetition.picksBaseRevision,
            contentSha256: entryEventPickHeadsInCompetition.contentSha256,
            rowCount: entryEventPickHeadsInCompetition.rowCount,
            sourceCheckedAt: entryEventPickHeadsInCompetition.sourceCheckedAt,
            contentUpdatedAt: entryEventPickHeadsInCompetition.contentUpdatedAt,
            checkpointedAt: entryEventPickHeadsInCompetition.checkpointedAt,
            state: entryEventPickHeadsInCompetition.state,
          })
          .from(entryEventPickHeadsInCompetition)
          .where(
            and(
              eq(entryEventPickHeadsInCompetition.seasonId, season.seasonId),
              eq(entryEventPickHeadsInCompetition.entryId, entryId),
              eq(entryEventPickHeadsInCompetition.eventId, eventId),
            ),
          )
          .limit(1);
        return row ?? null;
      } catch (error) {
        logError('Failed to retrieve entry event picks head', error, {
          season: season.seasonCode,
          entryId,
          eventId,
        });
        throw new DatabaseError(
          'Failed to retrieve entry event picks head',
          'ENTRY_EVENT_PICKS_HEAD_FIND_ERROR',
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
      publication?: EntryEventPicksPublicationMetadata,
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
          ? await replaceScope(
              dbInstance,
              season,
              entryId,
              eventId,
              picks,
              exactSyncedAt,
              publication,
            )
          : await (
              await getDb()
            ).transaction((tx) =>
              replaceScope(tx, season, entryId, eventId, picks, exactSyncedAt, publication),
            );
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
