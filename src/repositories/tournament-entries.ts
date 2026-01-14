import { eq } from 'drizzle-orm';

import { tournamentEntries } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

export class TournamentEntryRepository {
  async findEntryIdsByTournamentId(tournamentId: number): Promise<number[]> {
    try {
      const db = await getDb();
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
  }
}

export const tournamentEntryRepository = new TournamentEntryRepository();
