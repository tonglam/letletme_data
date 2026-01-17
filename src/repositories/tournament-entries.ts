import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { tournamentEntries } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export const createTournamentEntryRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    findEntryIdsByTournamentId: async (tournamentId: number): Promise<number[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select({ entryId: tournamentEntries.entryId })
          .from(tournamentEntries)
          .where(eq(tournamentEntries.tournamentId, tournamentId));
        const entryIds = rows.map((row) => row.entryId);
        logInfo('Retrieved tournament entry ids', { tournamentId, count: entryIds.length });
        return entryIds;
      } catch (error) {
        logError('Failed to retrieve tournament entry ids', error, { tournamentId });
        throw new DatabaseError(
          'Failed to retrieve tournament entry ids',
          'TOURNAMENT_ENTRY_FIND_ERROR',
          error as Error,
        );
      }
    },
  };
};

export const tournamentEntryRepository = createTournamentEntryRepository();
