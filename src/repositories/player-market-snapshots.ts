import { and, count, eq, notInArray, sql } from 'drizzle-orm';

import {
  playerMarketSnapshotsInFpl,
  type DbPlayerMarketSnapshotInsert,
} from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import {
  validateCompleteMarketSnapshotBatch,
  type PlayerMarketSnapshot,
} from '../domain/player-market-snapshots';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

function databaseDate(snapshotDate: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) return snapshotDate;
  if (!/^\d{8}$/.test(snapshotDate)) {
    throw new Error(`Invalid market snapshot date: ${snapshotDate}`);
  }
  return `${snapshotDate.slice(0, 4)}-${snapshotDate.slice(4, 6)}-${snapshotDate.slice(6)}`;
}

export type PlayerMarketDayCoverage = {
  readonly snapshotCount: number;
  readonly captureCount: number;
  readonly latestCapturedAt: Date | null;
};

export const createPlayerMarketSnapshotsRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    getDayCoverage: async (
      season: FplSeasonRef,
      snapshotDate: string,
    ): Promise<PlayerMarketDayCoverage> => {
      try {
        const db = await getDbInstance();
        const [coverage] = await db
          .select({
            snapshotCount: count(),
            captureCount: sql<number>`count(DISTINCT ${playerMarketSnapshotsInFpl.capturedAt})::integer`,
            latestCapturedAt: sql<Date | null>`max(${playerMarketSnapshotsInFpl.capturedAt})`,
          })
          .from(playerMarketSnapshotsInFpl)
          .where(
            and(
              eq(playerMarketSnapshotsInFpl.seasonId, season.seasonId),
              eq(playerMarketSnapshotsInFpl.snapshotDate, databaseDate(snapshotDate)),
            ),
          );

        return {
          snapshotCount: coverage?.snapshotCount ?? 0,
          captureCount: coverage?.captureCount ?? 0,
          latestCapturedAt: coverage?.latestCapturedAt ?? null,
        };
      } catch (error) {
        logError('Failed to read player market snapshot coverage', error, {
          season: season.seasonCode,
          snapshotDate,
        });
        throw new DatabaseError(
          'Failed to read player market snapshot coverage',
          'MARKET_SNAPSHOT_COVERAGE_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    upsertCompleteDay: async (
      season: FplSeasonRef,
      sourceEventId: number,
      snapshots: readonly PlayerMarketSnapshot[],
      expectedCount: number,
    ): Promise<{ snapshotDate: string; persistedCount: number }> => {
      try {
        validateCompleteMarketSnapshotBatch(snapshots, expectedCount);

        const snapshotDate = snapshots[0].snapshotDate;
        const rows: DbPlayerMarketSnapshotInsert[] = snapshots.map((snapshot) => ({
          seasonId: season.seasonId,
          sourceEventId,
          snapshotDate: snapshot.snapshotDate,
          capturedAt: snapshot.capturedAt,
          elementId: snapshot.elementId,
          playerCode: snapshot.playerCode,
          webName: snapshot.webName,
          firstName: snapshot.firstName,
          secondName: snapshot.secondName,
          teamId: snapshot.teamId,
          teamName: snapshot.teamName,
          teamShortName: snapshot.teamShortName,
          elementType: snapshot.elementType,
          position: snapshot.position,
          price: snapshot.price,
          selectedByPercent: String(snapshot.selectedByPercent),
          transfersIn: snapshot.transfersIn,
          transfersOut: snapshot.transfersOut,
          transfersInEvent: snapshot.transfersInEvent,
          transfersOutEvent: snapshot.transfersOutEvent,
          status: snapshot.status,
          news: snapshot.news,
          newsAdded: snapshot.newsAdded,
          chanceOfPlayingThisRound: snapshot.chanceOfPlayingThisRound,
          chanceOfPlayingNextRound: snapshot.chanceOfPlayingNextRound,
        }));

        const persist = async (db: DbOrTransaction) => {
          const persisted = await db
            .insert(playerMarketSnapshotsInFpl)
            .values(rows)
            .onConflictDoUpdate({
              target: [
                playerMarketSnapshotsInFpl.seasonId,
                playerMarketSnapshotsInFpl.snapshotDate,
                playerMarketSnapshotsInFpl.elementId,
              ],
              set: {
                sourceEventId: sql`excluded.source_event_id`,
                capturedAt: sql`excluded.captured_at`,
                playerCode: sql`excluded.player_code`,
                webName: sql`excluded.web_name`,
                firstName: sql`excluded.first_name`,
                secondName: sql`excluded.second_name`,
                teamId: sql`excluded.team_id`,
                teamName: sql`excluded.team_name`,
                teamShortName: sql`excluded.team_short_name`,
                elementType: sql`excluded.element_type`,
                position: sql`excluded.position`,
                price: sql`excluded.price`,
                selectedByPercent: sql`excluded.selected_by_percent`,
                transfersIn: sql`excluded.transfers_in`,
                transfersOut: sql`excluded.transfers_out`,
                transfersInEvent: sql`excluded.transfers_in_event`,
                transfersOutEvent: sql`excluded.transfers_out_event`,
                status: sql`excluded.status`,
                news: sql`excluded.news`,
                newsAdded: sql`excluded.news_added`,
                chanceOfPlayingThisRound: sql`excluded.chance_of_playing_this_round`,
                chanceOfPlayingNextRound: sql`excluded.chance_of_playing_next_round`,
                updatedAt: sql`NOW()`,
              },
            })
            .returning({ elementId: playerMarketSnapshotsInFpl.elementId });

          if (persisted.length !== expectedCount) {
            throw new Error(
              `Incomplete market snapshot write: expected ${expectedCount}, persisted ${persisted.length}`,
            );
          }

          const elementIds = snapshots.map((snapshot) => snapshot.elementId);
          await db
            .delete(playerMarketSnapshotsInFpl)
            .where(
              and(
                eq(playerMarketSnapshotsInFpl.snapshotDate, snapshotDate),
                eq(playerMarketSnapshotsInFpl.seasonId, season.seasonId),
                notInArray(playerMarketSnapshotsInFpl.elementId, elementIds),
              ),
            );

          const [verification] = await db
            .select({ count: count() })
            .from(playerMarketSnapshotsInFpl)
            .where(
              and(
                eq(playerMarketSnapshotsInFpl.seasonId, season.seasonId),
                eq(playerMarketSnapshotsInFpl.snapshotDate, snapshotDate),
              ),
            );
          const persistedCount = verification?.count ?? 0;

          if (persistedCount !== expectedCount) {
            throw new Error(
              `Incomplete market snapshot day: expected ${expectedCount}, found ${persistedCount}`,
            );
          }
          return persistedCount;
        };

        const db = await getDbInstance();
        // The runtime path owns one atomic boundary around upsert, stale-row
        // deletion, and cardinality verification. Injected transactions retain
        // their caller-owned boundary for composition and unit tests.
        const persistedCount = dbInstance
          ? await persist(dbInstance)
          : await db.transaction((transaction) => persist(transaction));

        logInfo('Complete player market snapshot persisted', {
          snapshotDate,
          expectedCount,
          persistedCount,
        });
        return { snapshotDate, persistedCount };
      } catch (error) {
        logError('Failed to persist complete player market snapshot', error, { expectedCount });
        throw new DatabaseError(
          'Failed to persist complete player market snapshot',
          'MARKET_SNAPSHOT_UPSERT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

export const playerMarketSnapshotsRepository = createPlayerMarketSnapshotsRepository();
