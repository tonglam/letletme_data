import { eq } from 'drizzle-orm';

import { seasonsInFpl } from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import { explicitSeasonRef, type FplSeasonRef } from '../domain/fpl-season';
import { advanceSeasonLifecycleState } from '../domain/season-lifecycle';
import { DatabaseError } from '../utils/errors';
import { logError } from '../utils/logger';

import type { Event } from '../types';

export interface FplSeasonRecord extends FplSeasonRef {
  readonly displayName: string;
  readonly lifecycleState: string;
  readonly isCurrent: boolean;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
}

function mapSeason(row: typeof seasonsInFpl.$inferSelect): FplSeasonRecord {
  return {
    seasonId: row.seasonId,
    seasonCode: row.seasonCode,
    displayName: row.displayName,
    lifecycleState: row.lifecycleState,
    isCurrent: row.isCurrent,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
  };
}

export const createSeasonRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  const findByCode = async (seasonCode: string): Promise<FplSeasonRecord | null> => {
    const expected = explicitSeasonRef(seasonCode);

    try {
      const db = await getDbInstance();
      const rows = await db
        .select()
        .from(seasonsInFpl)
        .where(eq(seasonsInFpl.seasonId, expected.seasonId))
        .limit(1);
      const row = rows[0];
      if (!row || row.seasonCode !== expected.seasonCode) {
        return null;
      }
      return mapSeason(row);
    } catch (error) {
      logError('Failed to retrieve FPL season by code', error, { seasonCode });
      throw new DatabaseError(
        'Failed to retrieve FPL season by code',
        'FIND_SEASON_BY_CODE_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  };

  const findById = async (seasonId: number): Promise<FplSeasonRecord | null> => {
    try {
      const db = await getDbInstance();
      const rows = await db
        .select()
        .from(seasonsInFpl)
        .where(eq(seasonsInFpl.seasonId, seasonId))
        .limit(1);
      return rows[0] ? mapSeason(rows[0]) : null;
    } catch (error) {
      logError('Failed to retrieve FPL season by id', error, { seasonId });
      throw new DatabaseError(
        'Failed to retrieve FPL season by id',
        'FIND_SEASON_BY_ID_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  };

  return {
    findByCode,
    findById,

    advanceLifecycle: async (
      season: FplSeasonRef,
      events: ReadonlyArray<Pick<Event, 'id' | 'finished' | 'dataChecked' | 'isCurrent'>>,
    ): Promise<FplSeasonRecord> => {
      const db = await getDbInstance();
      const rows = await db
        .select()
        .from(seasonsInFpl)
        .where(eq(seasonsInFpl.seasonId, season.seasonId))
        .limit(1);
      const current = rows[0];
      if (!current) {
        throw new DatabaseError(
          `FPL season ${season.seasonCode} does not exist`,
          'FPL_SEASON_NOT_FOUND',
        );
      }
      const nextState = advanceSeasonLifecycleState(current.lifecycleState, events);
      if (nextState !== current.lifecycleState) {
        await db
          .update(seasonsInFpl)
          .set({ lifecycleState: nextState, updatedAt: new Date() })
          .where(eq(seasonsInFpl.seasonId, season.seasonId));
      }
      return mapSeason({ ...current, lifecycleState: nextState });
    },

    requireByCode: async (seasonCode: string): Promise<FplSeasonRecord> => {
      const season = await findByCode(seasonCode);
      if (!season) {
        throw new DatabaseError(`FPL season ${seasonCode} does not exist`, 'FPL_SEASON_NOT_FOUND');
      }
      return season;
    },

    findCurrent: async (): Promise<FplSeasonRecord> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(seasonsInFpl)
          .where(eq(seasonsInFpl.isCurrent, true))
          .limit(2);
        if (rows.length !== 1) {
          throw new Error(`Expected exactly one current FPL season, found ${rows.length}`);
        }
        return mapSeason(rows[0]);
      } catch (error) {
        logError('Failed to retrieve current FPL season', error);
        throw new DatabaseError(
          'Failed to retrieve current FPL season',
          'FIND_CURRENT_SEASON_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

export const seasonRepository = createSeasonRepository();
