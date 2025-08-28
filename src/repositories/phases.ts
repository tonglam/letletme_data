import { eq, sql } from 'drizzle-orm';

import { phases, type DbPhase } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Phase as DomainPhase } from '../types';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export class PhaseRepository {
  private db?: DatabaseInstance;

  constructor(dbInstance?: DatabaseInstance) {
    this.db = dbInstance;
  }

  private async getDbInstance() {
    return this.db || (await getDb());
  }

  async findAll(): Promise<DbPhase[]> {
    try {
      const db = await this.getDbInstance();
      const result = await db.select().from(phases).orderBy(phases.id);
      logInfo('Retrieved all phases', { count: result.length });
      return result;
    } catch (error) {
      logError('Failed to find all phases', error);
      throw new DatabaseError(
        'Failed to retrieve phases',
        'FIND_ALL_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findById(id: number): Promise<DbPhase | null> {
    try {
      const db = await this.getDbInstance();
      const result = await db.select().from(phases).where(eq(phases.id, id));
      const phase = result[0] || null;

      if (phase) {
        logInfo('Retrieved phase by id', { id });
      } else {
        logInfo('Phase not found', { id });
      }

      return phase;
    } catch (error) {
      logError('Failed to find phase by id', error, { id });
      throw new DatabaseError(
        `Failed to retrieve phase with id: ${id}`,
        'FIND_BY_ID_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findByGameweek(gameweek: number): Promise<DbPhase[]> {
    try {
      const db = await this.getDbInstance();
      const result = await db
        .select()
        .from(phases)
        .where(sql`${phases.startEvent} <= ${gameweek} AND ${phases.stopEvent} >= ${gameweek}`)
        .orderBy(phases.id);

      logInfo('Retrieved phases by gameweek', { gameweek, count: result.length });
      return result;
    } catch (error) {
      logError('Failed to find phases by gameweek', error, { gameweek });
      throw new DatabaseError(
        `Failed to retrieve phases for gameweek: ${gameweek}`,
        'FIND_BY_GAMEWEEK_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findOverallPhase(): Promise<DbPhase | null> {
    try {
      const db = await this.getDbInstance();
      const result = await db
        .select()
        .from(phases)
        .where(sql`LOWER(${phases.name}) = 'overall'`)
        .limit(1);

      const phase = result[0] || null;

      if (phase) {
        logInfo('Retrieved overall phase', { id: phase.id });
      } else {
        logInfo('Overall phase not found');
      }

      return phase;
    } catch (error) {
      logError('Failed to find overall phase', error);
      throw new DatabaseError(
        'Failed to retrieve overall phase',
        'FIND_OVERALL_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findMonthlyPhases(): Promise<DbPhase[]> {
    try {
      const db = await this.getDbInstance();
      const monthNames = [
        'january',
        'february',
        'march',
        'april',
        'may',
        'june',
        'july',
        'august',
        'september',
        'october',
        'november',
        'december',
      ];

      const conditions = monthNames.map((month) => sql`LOWER(${phases.name}) = ${month}`);

      const result = await db
        .select()
        .from(phases)
        .where(sql`${conditions.join(' OR ')}`)
        .orderBy(phases.startEvent);

      logInfo('Retrieved monthly phases', { count: result.length });
      return result;
    } catch (error) {
      logError('Failed to find monthly phases', error);
      throw new DatabaseError(
        'Failed to retrieve monthly phases',
        'FIND_MONTHLY_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async upsert(phase: DomainPhase): Promise<DbPhase> {
    try {
      const newPhase: DbPhaseInsert = {
        id: phase.id,
        name: phase.name,
        startEvent: phase.startEvent,
        stopEvent: phase.stopEvent,
        highestScore: phase.highestScore,
      };

      const db = await this.getDbInstance();
      const result = await db
        .insert(phases)
        .values(newPhase)
        .onConflictDoUpdate({
          target: phases.id,
          set: {
            name: sql`excluded.name`,
            startEvent: sql`excluded.start_event`,
            stopEvent: sql`excluded.stop_event`,
            highestScore: sql`excluded.highest_score`,
            updatedAt: new Date(),
          },
        })
        .returning();

      const upsertedPhase = result[0];
      logInfo('Upserted phase', { id: upsertedPhase.id });
      return upsertedPhase;
    } catch (error) {
      logError('Failed to upsert phase', error, { id: phase.id });
      throw new DatabaseError(
        `Failed to upsert phase with id: ${phase.id}`,
        'UPSERT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async upsertBatch(domainPhases: DomainPhase[]): Promise<DbPhase[]> {
    try {
      if (domainPhases.length === 0) {
        return [];
      }

      const newPhases: DbPhaseInsert[] = domainPhases.map((phase) => ({
        id: phase.id,
        name: phase.name,
        startEvent: phase.startEvent,
        stopEvent: phase.stopEvent,
        highestScore: phase.highestScore,
        updatedAt: new Date(),
      }));

      const db = await this.getDbInstance();
      const result = await db
        .insert(phases)
        .values(newPhases)
        .onConflictDoUpdate({
          target: phases.id,
          set: {
            name: sql`excluded.name`,
            startEvent: sql`excluded.start_event`,
            stopEvent: sql`excluded.stop_event`,
            highestScore: sql`excluded.highest_score`,
            updatedAt: new Date(),
          },
        })
        .returning();

      logInfo('Batch upserted phases', { count: result.length });
      return result;
    } catch (error) {
      logError('Failed to batch upsert phases', error, { count: domainPhases.length });
      throw new DatabaseError(
        'Failed to batch upsert phases',
        'BATCH_UPSERT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async deleteAll(): Promise<void> {
    try {
      const db = await this.getDbInstance();
      await db.delete(phases);
      logInfo('Deleted all phases');
    } catch (error) {
      logError('Failed to delete all phases', error);
      throw new DatabaseError(
        'Failed to delete all phases',
        'DELETE_ALL_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }
}

// Export singleton instance
export const phaseRepository = new PhaseRepository();
