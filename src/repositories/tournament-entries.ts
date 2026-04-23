import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { tournamentEntries } from '../db/schemas/index.schema';
import { getDb, getDbClient } from '../db/singleton';
import type { EntrySeed, QualifiedEntry } from '../domain/tournament';
import { MAX_RANK } from '../domain/tournament';
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

    findEntrySeedsByTournamentId: async (tournamentId: number): Promise<EntrySeed[]> => {
      try {
        const client = await getDbClient();
        const rows = await client<EntrySeed[]>`
          select
            te.entry_id as "entryId",
            ei.overall_rank as "overallRank"
          from tournament_entries te
          left join entry_infos ei on ei.id = te.entry_id
          where te.tournament_id = ${tournamentId}
          order by coalesce(ei.overall_rank, ${MAX_RANK}), te.entry_id
        `;
        logInfo('Retrieved tournament entry seeds', { tournamentId, count: rows.length });
        return rows;
      } catch (error) {
        logError('Failed to retrieve tournament entry seeds', error, { tournamentId });
        throw new DatabaseError(
          'Failed to retrieve tournament entry seeds',
          'TOURNAMENT_ENTRY_SEEDS_FIND_ERROR',
          error as Error,
        );
      }
    },

    findQualifiedEntriesByTournamentId: async (tournamentId: number): Promise<QualifiedEntry[]> => {
      try {
        const client = await getDbClient();
        const rows = await client<QualifiedEntry[]>`
          select
            tg.entry_id as "entryId",
            tg.group_id as "groupId",
            tg.group_rank as "groupRank",
            tg.overall_rank as "overallRank"
          from tournament_groups tg
          where tg.tournament_id = ${tournamentId}
            and coalesce(tg.qualified, 0) = 1
          order by
            coalesce(tg.group_rank, ${MAX_RANK}),
            tg.group_id,
            coalesce(tg.overall_rank, ${MAX_RANK}),
            tg.entry_id
        `;
        logInfo('Retrieved qualified tournament entries', { tournamentId, count: rows.length });
        return rows;
      } catch (error) {
        logError('Failed to retrieve qualified tournament entries', error, { tournamentId });
        throw new DatabaseError(
          'Failed to retrieve qualified tournament entries',
          'TOURNAMENT_ENTRY_QUALIFIED_FIND_ERROR',
          error as Error,
        );
      }
    },
  };
};

export const tournamentEntryRepository = createTournamentEntryRepository();
