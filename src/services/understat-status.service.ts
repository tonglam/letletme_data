import { eq, sql } from 'drizzle-orm';

import { understatCache } from '../cache/understat-cache';
import type { UnderstatSnapshotManifest } from '../cache/understat-cache';
import {
  understatMatches,
  understatPlayerMatchStats,
  understatPlayerSeasons,
  understatPlayerTeamSeasons,
  understatTeamMatchStats,
  understatTeamSeasons,
  understatTeamStatSplits,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { understatSyncRepository } from '../repositories/understat-sync';
import { logWarn } from '../utils/logger';

interface CountAndUpdatedAt {
  count: number;
  updatedAt: Date | null;
}

type UnavailableManifest = {
  status: 'unavailable';
  reason: 'redis_unavailable';
};

type ManifestReader = (
  season: string,
  lane: 'team' | 'player',
) => Promise<UnderstatSnapshotManifest | null>;

export async function readManifest(
  season: string,
  lane: 'team' | 'player',
  getManifest: ManifestReader = (targetSeason, targetLane) =>
    understatCache.getManifest(targetSeason, targetLane),
): Promise<UnderstatSnapshotManifest | UnavailableManifest | null> {
  try {
    return await getManifest(season, lane);
  } catch (error) {
    logWarn('Understat status could not read Redis manifest', {
      season,
      lane,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: 'unavailable', reason: 'redis_unavailable' };
  }
}

export async function getUnderstatStatus(season: string) {
  const db = await getDb();
  const [runs, teamManifest, playerManifest, resources] = await Promise.all([
    understatSyncRepository.findLatestRuns(season),
    readManifest(season, 'team'),
    readManifest(season, 'player'),
    Promise.all([
      db
        .select({
          count: sql<number>`count(*)::int`,
          updatedAt: sql<Date | null>`max(COALESCE(${understatTeamSeasons.updatedAt}, ${understatTeamSeasons.createdAt}))`,
        })
        .from(understatTeamSeasons)
        .where(eq(understatTeamSeasons.season, season)),
      db
        .select({
          count: sql<number>`count(*)::int`,
          updatedAt: sql<Date | null>`max(COALESCE(${understatMatches.updatedAt}, ${understatMatches.createdAt}))`,
        })
        .from(understatMatches)
        .where(eq(understatMatches.season, season)),
      db
        .select({
          count: sql<number>`count(*)::int`,
          updatedAt: sql<Date | null>`max(COALESCE(${understatTeamMatchStats.updatedAt}, ${understatTeamMatchStats.createdAt}))`,
        })
        .from(understatTeamMatchStats)
        .innerJoin(understatMatches, eq(understatTeamMatchStats.matchId, understatMatches.id))
        .where(eq(understatMatches.season, season)),
      db
        .select({
          count: sql<number>`count(*)::int`,
          updatedAt: sql<Date | null>`max(COALESCE(${understatTeamStatSplits.updatedAt}, ${understatTeamStatSplits.createdAt}))`,
        })
        .from(understatTeamStatSplits)
        .where(eq(understatTeamStatSplits.season, season)),
      db
        .select({
          count: sql<number>`count(*)::int`,
          updatedAt: sql<Date | null>`max(COALESCE(${understatPlayerSeasons.updatedAt}, ${understatPlayerSeasons.createdAt}))`,
        })
        .from(understatPlayerSeasons)
        .where(eq(understatPlayerSeasons.season, season)),
      db
        .select({
          count: sql<number>`count(*)::int`,
          updatedAt: sql<Date | null>`max(COALESCE(${understatPlayerTeamSeasons.updatedAt}, ${understatPlayerTeamSeasons.createdAt}))`,
        })
        .from(understatPlayerTeamSeasons)
        .where(eq(understatPlayerTeamSeasons.season, season)),
      db
        .select({
          count: sql<number>`count(*)::int`,
          updatedAt: sql<Date | null>`max(COALESCE(${understatPlayerMatchStats.updatedAt}, ${understatPlayerMatchStats.createdAt}))`,
        })
        .from(understatPlayerMatchStats)
        .innerJoin(understatMatches, eq(understatPlayerMatchStats.matchId, understatMatches.id))
        .where(eq(understatMatches.season, season)),
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

  return {
    season,
    lanes: {
      team: { latestRun: runs.team, failedItems: failedItems.team, manifest: teamManifest },
      player: {
        latestRun: runs.player,
        failedItems: failedItems.player,
        manifest: playerManifest,
      },
    },
    resources: resourceCounts,
  };
}

export async function hasRecentUnderstatSuccess(
  season: string,
  maxAgeMs = 36 * 60 * 60 * 1000,
): Promise<boolean | null> {
  const [latest, published] = await Promise.all([
    understatSyncRepository.findLatestRuns(season),
    understatSyncRepository.findLatestPublishedRuns(season),
  ]);
  if (!latest.team && !latest.player) return null;
  const cutoff = Date.now() - maxAgeMs;
  return [published.team, published.player].every(
    (run) => run !== null && run.completedAt !== null && run.completedAt.getTime() >= cutoff,
  );
}
