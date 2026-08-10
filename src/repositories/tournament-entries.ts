import { and, asc, eq, sql } from 'drizzle-orm';

import {
  entriesInCompetition,
  tournamentEntriesInCompetition,
  tournamentGroupsInCompetition,
} from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { EntrySeed, QualifiedEntry } from '../domain/tournament';
import { MAX_RANK } from '../domain/tournament';
import { DatabaseError } from '../utils/errors';
import { logError } from '../utils/logger';

export const createTournamentEntryRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  return {
    findEntryIdsByTournamentId: async (
      season: FplSeasonRef,
      tournamentId: number,
    ): Promise<number[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select({ entryId: tournamentEntriesInCompetition.entryId })
          .from(tournamentEntriesInCompetition)
          .where(
            and(
              eq(tournamentEntriesInCompetition.seasonId, season.seasonId),
              eq(tournamentEntriesInCompetition.tournamentId, tournamentId),
            ),
          );
        return rows.map((row) => row.entryId);
      } catch (error) {
        logError('Failed to retrieve tournament entry ids', error, {
          season: season.seasonCode,
          tournamentId,
        });
        throw new DatabaseError(
          'Failed to retrieve tournament entry ids',
          'TOURNAMENT_ENTRY_FIND_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findEntrySeedsByTournamentId: async (
      season: FplSeasonRef,
      tournamentId: number,
    ): Promise<EntrySeed[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select({
            entryId: tournamentEntriesInCompetition.entryId,
            overallRank: entriesInCompetition.overallRank,
          })
          .from(tournamentEntriesInCompetition)
          .leftJoin(
            entriesInCompetition,
            and(
              eq(entriesInCompetition.seasonId, tournamentEntriesInCompetition.seasonId),
              eq(entriesInCompetition.entryId, tournamentEntriesInCompetition.entryId),
            ),
          )
          .where(
            and(
              eq(tournamentEntriesInCompetition.seasonId, season.seasonId),
              eq(tournamentEntriesInCompetition.tournamentId, tournamentId),
            ),
          )
          .orderBy(
            asc(sql`COALESCE(${entriesInCompetition.overallRank}, ${MAX_RANK})`),
            asc(tournamentEntriesInCompetition.entryId),
          );
        return rows;
      } catch (error) {
        logError('Failed to retrieve tournament entry seeds', error, {
          season: season.seasonCode,
          tournamentId,
        });
        throw new DatabaseError(
          'Failed to retrieve tournament entry seeds',
          'TOURNAMENT_ENTRY_SEEDS_FIND_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findQualifiedEntriesByTournamentId: async (
      season: FplSeasonRef,
      tournamentId: number,
    ): Promise<QualifiedEntry[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select({
            entryId: tournamentGroupsInCompetition.entryId,
            groupId: tournamentGroupsInCompetition.groupId,
            groupRank: tournamentGroupsInCompetition.groupRank,
            overallRank: tournamentGroupsInCompetition.overallRank,
          })
          .from(tournamentGroupsInCompetition)
          .where(
            and(
              eq(tournamentGroupsInCompetition.seasonId, season.seasonId),
              eq(tournamentGroupsInCompetition.tournamentId, tournamentId),
              eq(tournamentGroupsInCompetition.qualified, 1),
            ),
          )
          .orderBy(
            asc(sql`COALESCE(${tournamentGroupsInCompetition.groupRank}, ${MAX_RANK})`),
            asc(tournamentGroupsInCompetition.groupId),
            asc(sql`COALESCE(${tournamentGroupsInCompetition.overallRank}, ${MAX_RANK})`),
            asc(tournamentGroupsInCompetition.entryId),
          );
        return rows;
      } catch (error) {
        logError('Failed to retrieve qualified tournament entries', error, {
          season: season.seasonCode,
          tournamentId,
        });
        throw new DatabaseError(
          'Failed to retrieve qualified tournament entries',
          'TOURNAMENT_ENTRY_QUALIFIED_FIND_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

export const tournamentEntryRepository = createTournamentEntryRepository();
