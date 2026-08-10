import { and, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';

import {
  fixturesInFpl,
  eventsInFpl,
  type DbEventFixture,
  type DbEventFixtureInsert,
} from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { Fixture as DomainFixture, FixtureStat } from '../types';

// Map DbEventFixture to domain Fixture
function mapDbFixtureToDomain(dbFixture: DbEventFixture): DomainFixture {
  if (dbFixture.teamAId === null || dbFixture.teamHId === null) {
    throw new DatabaseError(
      `Fixture ${dbFixture.fixtureId} is missing a team`,
      'FIXTURE_TEAM_MISSING',
    );
  }
  return {
    id: dbFixture.fixtureId,
    code: dbFixture.code,
    event: dbFixture.eventId,
    finished: dbFixture.finished,
    finishedProvisional: dbFixture.finishedProvisional,
    kickoffTime: dbFixture.kickoffTime,
    minutes: dbFixture.minutes,
    provisionalStartTime: dbFixture.provisionalStartTime,
    started: dbFixture.started,
    teamA: dbFixture.teamAId,
    teamAScore: dbFixture.teamAScore,
    teamH: dbFixture.teamHId,
    teamHScore: dbFixture.teamHScore,
    stats: dbFixture.stats as FixtureStat[],
    teamHDifficulty: dbFixture.teamHDifficulty,
    teamADifficulty: dbFixture.teamADifficulty,
    pulseId: dbFixture.pulseId,
    createdAt: dbFixture.createdAt,
    updatedAt: dbFixture.updatedAt,
  };
}

export const createFixtureRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    deleteNotInIds: async (season: FplSeasonRef, ids: number[]): Promise<number> => {
      if (ids.length === 0) {
        throw new DatabaseError(
          'Refusing to delete fixtures without an authoritative identifier set',
          'FIXTURE_DELETE_SCOPE_EMPTY',
        );
      }
      try {
        const db = await getDbInstance();
        const deleted = await db
          .delete(fixturesInFpl)
          .where(
            and(
              eq(fixturesInFpl.seasonId, season.seasonId),
              notInArray(fixturesInFpl.fixtureId, [...new Set(ids)]),
            ),
          )
          .returning({ id: fixturesInFpl.fixtureId });
        return deleted.length;
      } catch (error) {
        logError('Failed to delete stale fixtures', error, { retainedCount: ids.length });
        throw new DatabaseError(
          'Failed to delete stale fixtures',
          'DELETE_STALE_FIXTURES_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findByEvent: async (season: FplSeasonRef, eventId: number): Promise<DomainFixture[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(fixturesInFpl)
          .where(
            and(eq(fixturesInFpl.seasonId, season.seasonId), eq(fixturesInFpl.eventId, eventId)),
          );
        return rows.map(mapDbFixtureToDomain);
      } catch (error) {
        logError('Failed to find fixtures by event', error, { eventId });
        throw new DatabaseError(
          'Failed to retrieve fixtures by event',
          'FIND_BY_EVENT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findAll: async (season: FplSeasonRef): Promise<DomainFixture[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(fixturesInFpl)
          .where(eq(fixturesInFpl.seasonId, season.seasonId))
          .orderBy(fixturesInFpl.fixtureId);
        return rows.map(mapDbFixtureToDomain);
      } catch (error) {
        logError('Failed to find all fixtures', error);
        throw new DatabaseError(
          'Failed to retrieve all fixtures',
          'FIND_ALL_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findByIds: async (season: FplSeasonRef, ids: readonly number[]): Promise<DomainFixture[]> => {
      try {
        const uniqueIds = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
        if (uniqueIds.length === 0) return [];
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(fixturesInFpl)
          .where(
            and(
              eq(fixturesInFpl.seasonId, season.seasonId),
              inArray(fixturesInFpl.fixtureId, uniqueIds),
            ),
          )
          .orderBy(fixturesInFpl.fixtureId);
        return rows.map(mapDbFixtureToDomain);
      } catch (error) {
        logError('Failed to find fixtures by ids', error, { count: ids.length });
        throw new DatabaseError(
          'Failed to retrieve fixtures by ids',
          'FIND_BY_IDS_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findEventIdsByFixtureIds: async (
      season: FplSeasonRef,
      ids: number[],
    ): Promise<Map<number, number | null>> => {
      try {
        if (ids.length === 0) {
          return new Map();
        }

        const db = await getDbInstance();
        const result = await db
          .select({ id: fixturesInFpl.fixtureId, eventId: fixturesInFpl.eventId })
          .from(fixturesInFpl)
          .where(
            and(eq(fixturesInFpl.seasonId, season.seasonId), inArray(fixturesInFpl.fixtureId, ids)),
          );

        return new Map(result.map((row) => [row.id, row.eventId]));
      } catch (error) {
        logError('Failed to find fixture event ids', error, { count: ids.length });
        throw new DatabaseError(
          'Failed to retrieve fixture event ids',
          'FIND_EVENT_IDS_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findLocationsByFixtureIds: async (
      season: FplSeasonRef,
      ids: number[],
    ): Promise<Map<number, { eventId: number | null; teamAId: number; teamHId: number }>> => {
      try {
        if (ids.length === 0) return new Map();
        const db = await getDbInstance();
        const rows = await db
          .select({
            id: fixturesInFpl.fixtureId,
            eventId: fixturesInFpl.eventId,
            teamAId: fixturesInFpl.teamAId,
            teamHId: fixturesInFpl.teamHId,
          })
          .from(fixturesInFpl)
          .where(
            and(eq(fixturesInFpl.seasonId, season.seasonId), inArray(fixturesInFpl.fixtureId, ids)),
          );
        return new Map(
          rows.map((row) => {
            if (row.teamAId === null || row.teamHId === null) {
              throw new DatabaseError(
                `Fixture ${row.id} is missing a team`,
                'FIXTURE_TEAM_MISSING',
              );
            }
            return [row.id, { eventId: row.eventId, teamAId: row.teamAId, teamHId: row.teamHId }];
          }),
        );
      } catch (error) {
        logError('Failed to find fixture locations', error, { count: ids.length });
        throw new DatabaseError(
          'Failed to retrieve fixture locations',
          'FIND_FIXTURE_LOCATIONS_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    markUnscheduled: async (season: FplSeasonRef, ids: number[]): Promise<number> => {
      try {
        const uniqueIds = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
        if (uniqueIds.length === 0) return 0;

        const db = await getDbInstance();
        const result = await db
          .update(fixturesInFpl)
          .set({ eventId: null, updatedAt: new Date() })
          .where(
            and(
              eq(fixturesInFpl.seasonId, season.seasonId),
              inArray(fixturesInFpl.fixtureId, uniqueIds),
            ),
          )
          .returning({ id: fixturesInFpl.fixtureId });
        logInfo('Marked fixtures as unscheduled', { count: result.length });
        return result.length;
      } catch (error) {
        logError('Failed to mark fixtures as unscheduled', error, { count: ids.length });
        throw new DatabaseError(
          'Failed to mark fixtures as unscheduled',
          'MARK_UNSCHEDULED_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    markAbsentUnscheduled: async (
      season: FplSeasonRef,
      acceptedIds: readonly number[],
      preserveOwnedCheckedAtOrAfter?: Date,
      acceptedCodes: readonly number[] = [],
    ): Promise<number> => {
      try {
        const uniqueIds = [...new Set(acceptedIds.filter((id) => Number.isInteger(id) && id > 0))];
        if (uniqueIds.length === 0) return 0;
        const uniqueCodes = [
          ...new Set(acceptedCodes.filter((code) => Number.isInteger(code) && code > 0)),
        ];
        const preserveOwnedCheckedAtOrAfterIso = preserveOwnedCheckedAtOrAfter?.toISOString();

        const db = await getDbInstance();
        const ownershipFence = preserveOwnedCheckedAtOrAfterIso
          ? sql`NOT EXISTS (
              SELECT 1
              FROM ${eventsInFpl}
              WHERE ${eventsInFpl.seasonId} = ${season.seasonId}
                AND ${eventsInFpl.eventId} = ${fixturesInFpl.eventId}
                AND ${eventsInFpl.liveSnapshotCheckedAt} >= ${preserveOwnedCheckedAtOrAfterIso}::timestamptz
            )`
          : undefined;
        let retiredCodeConflicts = 0;
        if (uniqueCodes.length > 0) {
          const removed = await db
            .delete(fixturesInFpl)
            .where(
              and(
                notInArray(fixturesInFpl.fixtureId, uniqueIds),
                eq(fixturesInFpl.seasonId, season.seasonId),
                inArray(fixturesInFpl.code, uniqueCodes),
                ownershipFence,
              ),
            )
            .returning({ id: fixturesInFpl.fixtureId });
          retiredCodeConflicts = removed.length;
        }
        const result = await db
          .update(fixturesInFpl)
          .set({ eventId: null, updatedAt: new Date() })
          .where(
            and(
              isNotNull(fixturesInFpl.eventId),
              eq(fixturesInFpl.seasonId, season.seasonId),
              notInArray(fixturesInFpl.fixtureId, uniqueIds),
              ownershipFence,
            ),
          )
          .returning({ id: fixturesInFpl.fixtureId });
        const count = retiredCodeConflicts + result.length;
        logInfo('Retired fixtures absent from the complete snapshot', { count });
        return count;
      } catch (error) {
        logError('Failed to retire fixtures absent from the complete snapshot', error, {
          acceptedCount: acceptedIds.length,
        });
        throw new DatabaseError(
          'Failed to retire fixtures absent from the complete snapshot',
          'MARK_ABSENT_UNSCHEDULED_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    upsertBatch: async (
      season: FplSeasonRef,
      domainFixtures: DomainFixture[],
    ): Promise<DomainFixture[]> => {
      try {
        if (domainFixtures.length === 0) {
          return [];
        }
        const batchSize = 500;
        const db = await getDbInstance();
        const mappedFixtures: DomainFixture[] = [];

        for (let index = 0; index < domainFixtures.length; index += batchSize) {
          const batch = domainFixtures.slice(index, index + batchSize);
          const newFixtures: DbEventFixtureInsert[] = batch.map((fixture) => ({
            seasonId: season.seasonId,
            fixtureId: fixture.id,
            code: fixture.code,
            eventId: fixture.event,
            finished: fixture.finished,
            finishedProvisional: fixture.finishedProvisional,
            kickoffTime: fixture.kickoffTime,
            minutes: fixture.minutes,
            provisionalStartTime: fixture.provisionalStartTime,
            started: fixture.started ?? false,
            teamAId: fixture.teamA,
            teamAScore: fixture.teamAScore,
            teamHId: fixture.teamH,
            teamHScore: fixture.teamHScore,
            stats: fixture.stats,
            teamHDifficulty: fixture.teamHDifficulty,
            teamADifficulty: fixture.teamADifficulty,
            pulseId: fixture.pulseId,
            updatedAt: new Date(),
          }));

          const result = await db
            .insert(fixturesInFpl)
            .values(newFixtures)
            .onConflictDoUpdate({
              target: [fixturesInFpl.seasonId, fixturesInFpl.fixtureId],
              set: {
                code: sql`excluded.code`,
                eventId: sql`excluded.event_id`,
                finished: sql`excluded.finished`,
                finishedProvisional: sql`excluded.finished_provisional`,
                kickoffTime: sql`excluded.kickoff_time`,
                minutes: sql`excluded.minutes`,
                provisionalStartTime: sql`excluded.provisional_start_time`,
                started: sql`excluded.started`,
                teamAId: sql`excluded.team_a_id`,
                teamAScore: sql`excluded.team_a_score`,
                teamHId: sql`excluded.team_h_id`,
                teamHScore: sql`excluded.team_h_score`,
                stats: sql`excluded.stats`,
                teamHDifficulty: sql`excluded.team_h_difficulty`,
                teamADifficulty: sql`excluded.team_a_difficulty`,
                pulseId: sql`excluded.pulse_id`,
                updatedAt: new Date(),
              },
            })
            .returning();

          mappedFixtures.push(...result.map(mapDbFixtureToDomain));
        }

        logInfo('Batch upserted fixtures', {
          count: mappedFixtures.length,
          batches: Math.ceil(domainFixtures.length / batchSize),
        });
        return mappedFixtures;
      } catch (error) {
        const cause =
          error instanceof Error &&
          'cause' in error &&
          error.cause &&
          typeof error.cause === 'object'
            ? (error.cause as {
                message?: string;
                code?: string;
                detail?: string;
                constraint?: string;
              })
            : undefined;

        logError('Failed to batch upsert fixtures', error, {
          count: domainFixtures.length,
          causeMessage: cause?.message,
          causeCode: cause?.code,
          causeDetail: cause?.detail,
          causeConstraint: cause?.constraint,
        });
        throw new DatabaseError(
          'Failed to batch upsert fixtures',
          'BATCH_UPSERT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

// Export singleton instance
export const fixtureRepository = createFixtureRepository();
