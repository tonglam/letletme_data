import { inArray, sql } from 'drizzle-orm';

import {
  eventFixtures,
  type DbEventFixture,
  type DbEventFixtureInsert,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Fixture as DomainFixture } from '../types';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

// Map DbEventFixture to domain Fixture
function mapDbFixtureToDomain(dbFixture: DbEventFixture): DomainFixture {
  return {
    id: dbFixture.id,
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
    stats: dbFixture.stats,
    teamHDifficulty: dbFixture.teamHDifficulty,
    teamADifficulty: dbFixture.teamADifficulty,
    pulseId: dbFixture.pulseId,
    createdAt: dbFixture.createdAt,
    updatedAt: dbFixture.updatedAt,
  };
}

export const createFixtureRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    findEventIdsByFixtureIds: async (ids: number[]): Promise<Map<number, number | null>> => {
      try {
        if (ids.length === 0) {
          return new Map();
        }

        const db = await getDbInstance();
        const result = await db
          .select({ id: eventFixtures.id, eventId: eventFixtures.eventId })
          .from(eventFixtures)
          .where(inArray(eventFixtures.id, ids));

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

    upsertBatch: async (domainFixtures: DomainFixture[]): Promise<DomainFixture[]> => {
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
            id: fixture.id,
            code: fixture.code,
            eventId: fixture.event,
            finished: fixture.finished,
            finishedProvisional: fixture.finishedProvisional,
            kickoffTime: fixture.kickoffTime,
            minutes: fixture.minutes,
            provisionalStartTime: fixture.provisionalStartTime,
            started: fixture.started,
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
            .insert(eventFixtures)
            .values(newFixtures)
            .onConflictDoUpdate({
              target: eventFixtures.id,
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
        logError('Failed to batch upsert fixtures', error, { count: domainFixtures.length });
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
