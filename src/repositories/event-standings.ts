import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { eventStandings, type DbEventStandingInsert } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export class EventStandingsRepository {
  private db?: DatabaseInstance;

  constructor(dbInstance?: DatabaseInstance) {
    this.db = dbInstance;
  }

  private async getDbInstance() {
    return this.db || (await getDb());
  }

  async replaceAll(standings: DbEventStandingInsert[]): Promise<number> {
    try {
      const db = await this.getDbInstance();
      await db.delete(eventStandings);

      if (standings.length === 0) {
        logInfo('No event standings to insert');
        return 0;
      }

      await db.insert(eventStandings).values(standings);
      logInfo('Inserted event standings', { count: standings.length });
      return standings.length;
    } catch (error) {
      logError('Failed to replace event standings', error, { count: standings.length });
      throw new DatabaseError(
        'Failed to replace event standings',
        'EVENT_STANDINGS_REPLACE_ERROR',
        error as Error,
      );
    }
  }
}

export const eventStandingsRepository = new EventStandingsRepository();
