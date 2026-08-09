import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { fplSeasonArchiveItems, fplSeasonArchives } from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type {
  FplSeasonArchive,
  FplSeasonArchiveItem,
  FplSeasonDataLocation,
} from '../domain/fpl-history';
import { findCoreSnapshotAuthority } from './core-snapshot-authority';

async function getDatabase(dbInstance?: DbOrTransaction): Promise<DbOrTransaction> {
  return dbInstance ?? (await getDb());
}

function mapArchive(row: typeof fplSeasonArchives.$inferSelect): FplSeasonArchive {
  return {
    season: row.season,
    status: row.status,
    reason: row.reason,
    sourceCoreRevision: row.sourceCoreRevision,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    errorSummary: row.errorSummary,
  };
}

function mapItem(row: typeof fplSeasonArchiveItems.$inferSelect): FplSeasonArchiveItem {
  return {
    season: row.season,
    sourceTable: row.sourceTable,
    archiveTable: row.archiveTable,
    rowCount: row.rowCount,
    canonicalChecksum: row.canonicalChecksum,
    verifiedAt: row.verifiedAt,
  };
}

export interface FplArchiveEligibility {
  eligible: boolean;
  eventCount: number;
  fixtureCount: number;
  eventIdsComplete: boolean;
  fixtureEventIdsComplete: boolean;
  fixturesFinished: boolean;
  finalizedEventCount: number;
  reason: string | null;
}

export interface FplArchiveEligibilityFacts {
  eventCount: number;
  minEventId: number | null;
  maxEventId: number | null;
  distinctEventIds: number;
  finalizedEventCount: number;
  fixtureCount: number;
  finishedCount: number;
  fixtureEventCount: number;
  invalidEventCount: number;
}

export function evaluateFplArchiveEligibility(
  facts: FplArchiveEligibilityFacts,
): FplArchiveEligibility {
  const eventIdsComplete =
    facts.eventCount === 38 &&
    facts.distinctEventIds === 38 &&
    facts.minEventId === 1 &&
    facts.maxEventId === 38;
  const fixtureEventIdsComplete = facts.invalidEventCount === 0;
  const fixturesFinished = facts.fixtureCount === 380 && facts.finishedCount === facts.fixtureCount;
  const reasons = [
    facts.eventCount === 38 ? null : `events=${facts.eventCount}/38`,
    eventIdsComplete ? null : 'event IDs are not exactly 1..38',
    facts.fixtureCount === 380 ? null : `fixtures=${facts.fixtureCount}/380`,
    fixtureEventIdsComplete ? null : 'fixture event IDs contain null or out-of-range values',
    fixturesFinished ? null : 'not all 380 fixtures are finished',
    facts.finalizedEventCount === 38 ? null : `finalized events=${facts.finalizedEventCount}/38`,
  ].filter((value): value is string => value !== null);
  return {
    eligible: reasons.length === 0,
    eventCount: facts.eventCount,
    fixtureCount: facts.fixtureCount,
    eventIdsComplete,
    fixtureEventIdsComplete,
    fixturesFinished,
    finalizedEventCount: facts.finalizedEventCount,
    reason: reasons.length === 0 ? null : reasons.join('; '),
  };
}

export const createFplHistoryRepository = (dbInstance?: DbOrTransaction) => ({
  async findArchive(season: string): Promise<FplSeasonArchive | null> {
    const db = await getDatabase(dbInstance);
    const [row] = await db
      .select()
      .from(fplSeasonArchives)
      .where(eq(fplSeasonArchives.season, season))
      .limit(1);
    return row ? mapArchive(row) : null;
  },

  async findItems(season: string): Promise<FplSeasonArchiveItem[]> {
    const db = await getDatabase(dbInstance);
    const rows = await db
      .select()
      .from(fplSeasonArchiveItems)
      .where(eq(fplSeasonArchiveItems.season, season))
      .orderBy(asc(fplSeasonArchiveItems.sourceTable));
    return rows.map(mapItem);
  },

  async markPending(season: string): Promise<FplSeasonArchive> {
    const db = await getDatabase(dbInstance);
    await db
      .insert(fplSeasonArchives)
      .values({ season, status: 'pending' })
      .onConflictDoUpdate({
        target: fplSeasonArchives.season,
        set: {
          status: 'pending',
          reason: null,
          errorSummary: null,
          updatedAt: new Date(),
        },
        setWhere: inArray(fplSeasonArchives.status, ['pending', 'failed']),
      });
    const archive = await this.findArchive(season);
    if (!archive) throw new Error(`Failed to prepare FPL archive ${season}`);
    return archive;
  },

  async markFailed(season: string, error: string): Promise<void> {
    const db = await getDatabase(dbInstance);
    await db
      .update(fplSeasonArchives)
      .set({
        status: 'failed',
        errorSummary: error,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(fplSeasonArchives.season, season),
          inArray(fplSeasonArchives.status, ['pending', 'building', 'failed']),
        ),
      );
  },

  async checkEligibility(): Promise<FplArchiveEligibility> {
    const db = await getDatabase(dbInstance);
    const eventRows = await db.execute<{
      eventCount: number;
      minEventId: number | null;
      maxEventId: number | null;
      distinctEventIds: number;
      finalizedEventCount: number;
    }>(sql`
      SELECT
        count(*)::int AS "eventCount",
        min(id)::int AS "minEventId",
        max(id)::int AS "maxEventId",
        count(DISTINCT id)::int AS "distinctEventIds",
        count(*) FILTER (WHERE live_snapshot_finalized_at IS NOT NULL)::int
          AS "finalizedEventCount"
      FROM public.events
    `);
    const fixtureRows = await db.execute<{
      fixtureCount: number;
      finishedCount: number;
      fixtureEventCount: number;
      invalidEventCount: number;
    }>(sql`
      SELECT
        count(*)::int AS "fixtureCount",
        count(*) FILTER (WHERE finished = true)::int AS "finishedCount",
        count(DISTINCT event_id)::int AS "fixtureEventCount",
        count(*) FILTER (WHERE event_id IS NULL OR event_id NOT BETWEEN 1 AND 38)::int
          AS "invalidEventCount"
      FROM public.event_fixtures
    `);
    const event = eventRows[0];
    const fixture = fixtureRows[0];
    return evaluateFplArchiveEligibility({
      eventCount: Number(event?.eventCount ?? 0),
      minEventId: event?.minEventId === null ? null : Number(event?.minEventId ?? 0),
      maxEventId: event?.maxEventId === null ? null : Number(event?.maxEventId ?? 0),
      distinctEventIds: Number(event?.distinctEventIds ?? 0),
      finalizedEventCount: Number(event?.finalizedEventCount ?? 0),
      fixtureCount: Number(fixture?.fixtureCount ?? 0),
      finishedCount: Number(fixture?.finishedCount ?? 0),
      fixtureEventCount: Number(fixture?.fixtureEventCount ?? 0),
      invalidEventCount: Number(fixture?.invalidEventCount ?? 0),
    });
  },
});

export async function resolveFplSeasonDataLocation(
  season: string,
  dbInstance?: DbOrTransaction,
): Promise<FplSeasonDataLocation> {
  const db = await getDatabase(dbInstance);
  const authority = await findCoreSnapshotAuthority(db);
  if (authority?.season === season) return { kind: 'current', season };

  const archive = await createFplHistoryRepository(db).findArchive(season);
  if (archive?.status === 'sealed') return { kind: 'archive', season };
  return {
    kind: 'unavailable',
    season,
    reason:
      archive?.reason ??
      archive?.errorSummary ??
      (archive ? `FPL season archive is ${archive.status}` : 'FPL season was not archived'),
  };
}

export const fplHistoryRepository = createFplHistoryRepository();
