import { sql } from 'drizzle-orm';

import { phases, type DbPhase, type DbPhaseInsert } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Phase as DomainPhase } from '../types';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export const createPhaseRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    upsertBatch: async (domainPhases: DomainPhase[]): Promise<DbPhase[]> => {
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
        }));

        const db = await getDbInstance();
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
    },
  };
};

// Export singleton instance
export const phaseRepository = createPhaseRepository();
