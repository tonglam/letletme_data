import { eq, or, sql } from 'drizzle-orm';

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

export class FixtureRepository {
  private db?: DatabaseInstance;

  constructor(dbInstance?: DatabaseInstance) {
    this.db = dbInstance;
  }

  private async getDbInstance() {
    return this.db || (await getDb());
  }

  async findAll(): Promise<DomainFixture[]> {
    try {
      const db = await this.getDbInstance();
      const result = await db.select().from(eventFixtures);
      const domainFixtures = result.map(mapDbFixtureToDomain);
      logInfo('Retrieved all fixtures', { count: domainFixtures.length });
      return domainFixtures;
    } catch (error) {
      logError('Failed to find all fixtures', error);
      throw new DatabaseError(
        'Failed to retrieve fixtures',
        'FIND_ALL_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findById(id: number): Promise<DomainFixture | null> {
    try {
      const db = await this.getDbInstance();
      const result = await db.select().from(eventFixtures).where(eq(eventFixtures.id, id));
      const dbFixture = result[0] || null;

      if (dbFixture) {
        logInfo('Retrieved fixture by id', { id });
        return mapDbFixtureToDomain(dbFixture);
      } else {
        logInfo('Fixture not found', { id });
        return null;
      }
    } catch (error) {
      logError('Failed to find fixture by id', error, { id });
      throw new DatabaseError(
        `Failed to retrieve fixture with id: ${id}`,
        'FIND_BY_ID_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findByEvent(eventId: number): Promise<DomainFixture[]> {
    try {
      const db = await this.getDbInstance();
      const result = await db
        .select()
        .from(eventFixtures)
        .where(eq(eventFixtures.eventId, eventId));

      const domainFixtures = result.map(mapDbFixtureToDomain);
      logInfo('Retrieved fixtures by event', { eventId, count: domainFixtures.length });
      return domainFixtures;
    } catch (error) {
      logError('Failed to find fixtures by event', error, { eventId });
      throw new DatabaseError(
        `Failed to retrieve fixtures for event: ${eventId}`,
        'FIND_BY_EVENT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findByTeam(teamId: number): Promise<DomainFixture[]> {
    try {
      const db = await this.getDbInstance();
      const result = await db
        .select()
        .from(eventFixtures)
        .where(or(eq(eventFixtures.teamAId, teamId), eq(eventFixtures.teamHId, teamId)));

      const domainFixtures = result.map(mapDbFixtureToDomain);
      logInfo('Retrieved fixtures by team', { teamId, count: domainFixtures.length });
      return domainFixtures;
    } catch (error) {
      logError('Failed to find fixtures by team', error, { teamId });
      throw new DatabaseError(
        `Failed to retrieve fixtures for team: ${teamId}`,
        'FIND_BY_TEAM_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async upsert(fixture: DomainFixture): Promise<DomainFixture> {
    try {
      const newFixture: DbEventFixtureInsert = {
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
      };

      const db = await this.getDbInstance();
      const result = await db
        .insert(eventFixtures)
        .values(newFixture)
        .onConflictDoUpdate({
          target: eventFixtures.id,
          set: {
            ...newFixture,
            updatedAt: new Date(),
          },
        })
        .returning();

      const upsertedFixture = mapDbFixtureToDomain(result[0]);
      logInfo('Upserted fixture', { id: upsertedFixture.id });
      return upsertedFixture;
    } catch (error) {
      logError('Failed to upsert fixture', error, { id: fixture.id });
      throw new DatabaseError(
        `Failed to upsert fixture with id: ${fixture.id}`,
        'UPSERT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async upsertBatch(domainFixtures: DomainFixture[]): Promise<DomainFixture[]> {
    try {
      if (domainFixtures.length === 0) {
        return [];
      }

      const newFixtures: DbEventFixtureInsert[] = domainFixtures.map((fixture) => ({
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

      const db = await this.getDbInstance();
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

      const mappedFixtures = result.map(mapDbFixtureToDomain);
      logInfo('Batch upserted fixtures', { count: mappedFixtures.length });
      return mappedFixtures;
    } catch (error) {
      logError('Failed to batch upsert fixtures', error, { count: domainFixtures.length });
      throw new DatabaseError(
        'Failed to batch upsert fixtures',
        'BATCH_UPSERT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async deleteAll(): Promise<void> {
    try {
      const db = await this.getDbInstance();
      await db.delete(eventFixtures);
      logInfo('Deleted all fixtures');
    } catch (error) {
      logError('Failed to delete all fixtures', error);
      throw new DatabaseError(
        'Failed to delete all fixtures',
        'DELETE_ALL_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }
}

// Export singleton instance
export const fixtureRepository = new FixtureRepository();
