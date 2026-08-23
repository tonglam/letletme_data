import { eq, sql } from 'drizzle-orm';

import {
  matchesInUnderstat as understatMatches,
  playerMatchStatsInUnderstat as understatPlayerMatchStats,
  playerSeasonsInUnderstat as understatPlayerSeasons,
  playerTeamSeasonsInUnderstat as understatPlayerTeamSeasons,
  teamMatchStatsInUnderstat as understatTeamMatchStats,
  teamSeasonsInUnderstat as understatTeamSeasons,
  teamStatSplitsInUnderstat as understatTeamStatSplits,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { understatSyncRepository } from '../repositories/understat-sync';

const ORPHAN_CUTOFF_MS = 30 * 60_000;

function laneRecoveryStatus(
  run: Awaited<ReturnType<typeof understatSyncRepository.findLatestRuns>>['team'],
) {
  const stale = Boolean(
    run &&
      ['pending', 'running', 'ready_to_publish'].includes(run.status) &&
      run.updatedAt.getTime() <= Date.now() - ORPHAN_CUTOFF_MS,
  );
  const recovery = run?.metadata.recovery;
  return {
    stale,
    recovery:
      recovery && typeof recovery === 'object' ? recovery : { state: stale ? 'stale' : 'none' },
  };
}

interface CountAndUpdatedAt {
  count: number;
  updatedAt: Date | null;
}

export async function getUnderstatStatus(season: string) {
  const db = await getDb();
  const [runs, resources] = await Promise.all([
    understatSyncRepository.findLatestRuns(season),
    Promise.all([
      db
        .select({
          count: sql<number>`count(*)::int`,
          updatedAt: sql<Date | null>`max(COALESCE(${understatTeamSeasons.updatedAt}, ${understatTeamSeasons.createdAt}))`,
        })
        .from(understatTeamSeasons)
        .where(eq(understatTeamSeasons.seasonCode, season)),
      db
        .select({
          count: sql<number>`count(*)::int`,
          updatedAt: sql<Date | null>`max(COALESCE(${understatMatches.updatedAt}, ${understatMatches.createdAt}))`,
        })
        .from(understatMatches)
        .where(eq(understatMatches.seasonCode, season)),
      db
        .select({
          count: sql<number>`count(*)::int`,
          updatedAt: sql<Date | null>`max(COALESCE(${understatTeamMatchStats.updatedAt}, ${understatTeamMatchStats.createdAt}))`,
        })
        .from(understatTeamMatchStats)
        .innerJoin(understatMatches, eq(understatTeamMatchStats.matchId, understatMatches.matchId))
        .where(eq(understatMatches.seasonCode, season)),
      db
        .select({
          count: sql<number>`count(*)::int`,
          updatedAt: sql<Date | null>`max(COALESCE(${understatTeamStatSplits.updatedAt}, ${understatTeamStatSplits.createdAt}))`,
        })
        .from(understatTeamStatSplits)
        .where(eq(understatTeamStatSplits.seasonCode, season)),
      db
        .select({
          count: sql<number>`count(*)::int`,
          updatedAt: sql<Date | null>`max(COALESCE(${understatPlayerSeasons.updatedAt}, ${understatPlayerSeasons.createdAt}))`,
        })
        .from(understatPlayerSeasons)
        .where(eq(understatPlayerSeasons.seasonCode, season)),
      db
        .select({
          count: sql<number>`count(*)::int`,
          updatedAt: sql<Date | null>`max(COALESCE(${understatPlayerTeamSeasons.updatedAt}, ${understatPlayerTeamSeasons.createdAt}))`,
        })
        .from(understatPlayerTeamSeasons)
        .where(eq(understatPlayerTeamSeasons.seasonCode, season)),
      db
        .select({
          count: sql<number>`count(*)::int`,
          updatedAt: sql<Date | null>`max(COALESCE(${understatPlayerMatchStats.updatedAt}, ${understatPlayerMatchStats.createdAt}))`,
        })
        .from(understatPlayerMatchStats)
        .innerJoin(
          understatMatches,
          eq(understatPlayerMatchStats.matchId, understatMatches.matchId),
        )
        .where(eq(understatMatches.seasonCode, season)),
    ]),
  ]);
  const names = [
    'teams',
    'matches',
    'teamMatchStats',
    'teamSplits',
    'players',
    'teamParticipants',
    'playerMatchStats',
  ] as const;
  const resourceCounts = Object.fromEntries(
    names.map((name, index) => {
      const row = resources[index][0] as CountAndUpdatedAt | undefined;
      return [name, { count: row?.count ?? 0, updatedAt: row?.updatedAt ?? null }];
    }),
  );
  const failedItems = {
    team: runs.team
      ? (await understatSyncRepository.findItems(runs.team.runId)).filter(
          (item) => item.status === 'failed',
        )
      : [],
    player: runs.player
      ? (await understatSyncRepository.findItems(runs.player.runId)).filter(
          (item) => item.status === 'failed',
        )
      : [],
  };
  const teamRecovery = laneRecoveryStatus(runs.team);
  const playerRecovery = laneRecoveryStatus(runs.player);

  return {
    season,
    storage: 'postgresql' as const,
    dataCache: 'disabled' as const,
    lanes: {
      team: {
        latestRun: runs.team,
        failedItems: failedItems.team,
        ...teamRecovery,
      },
      player: {
        latestRun: runs.player,
        failedItems: failedItems.player,
        ...playerRecovery,
      },
    },
    resources: resourceCounts,
  };
}
