import { eq, sql } from 'drizzle-orm';

import { phasesInFpl, type DbPhase, type DbPhaseInsert } from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { Phase as DomainPhase } from '../types';

function mapDbPhaseToDomain(phase: DbPhase): DomainPhase {
  return {
    id: phase.phaseId,
    name: phase.name,
    startEvent: phase.startEvent,
    stopEvent: phase.stopEvent,
    highestScore: phase.highestScore,
  };
}

export const createPhaseRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    findAll: async (season: FplSeasonRef): Promise<DomainPhase[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(phasesInFpl)
          .where(eq(phasesInFpl.seasonId, season.seasonId))
          .orderBy(phasesInFpl.phaseId);
        return rows.map(mapDbPhaseToDomain);
      } catch (error) {
        logError('Failed to retrieve phasesInFpl', error, { season: season.seasonCode });
        throw new DatabaseError(
          'Failed to retrieve phasesInFpl',
          'FIND_ALL_PHASES_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    upsertBatch: async (season: FplSeasonRef, domainPhases: DomainPhase[]): Promise<DbPhase[]> => {
      try {
        if (domainPhases.length === 0) {
          return [];
        }

        const newPhases: DbPhaseInsert[] = domainPhases.map((phase) => ({
          seasonId: season.seasonId,
          phaseId: phase.id,
          name: phase.name,
          startEvent: phase.startEvent,
          stopEvent: phase.stopEvent,
          highestScore: phase.highestScore,
        }));

        const db = await getDbInstance();
        const result = await db
          .insert(phasesInFpl)
          .values(newPhases)
          .onConflictDoUpdate({
            target: [phasesInFpl.seasonId, phasesInFpl.phaseId],
            set: {
              name: sql`excluded.name`,
              startEvent: sql`excluded.start_event`,
              stopEvent: sql`excluded.stop_event`,
              highestScore: sql`excluded.highest_score`,
              updatedAt: sql`NOW()`,
            },
          })
          .returning();

        logInfo('Batch upserted phasesInFpl', { count: result.length, season: season.seasonCode });
        return result;
      } catch (error) {
        logError('Failed to batch upsert phasesInFpl', error, {
          count: domainPhases.length,
          season: season.seasonCode,
        });
        throw new DatabaseError(
          'Failed to batch upsert phasesInFpl',
          'BATCH_UPSERT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

// Export singleton instance
export const phaseRepository = createPhaseRepository();
