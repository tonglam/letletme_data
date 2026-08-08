import { understatCache, understatTeamReferenceRevision } from '../cache/understat-cache';
import { contentHash } from '../utils/content-hash';
import { getConfig } from '../utils/config';
import { getDb } from '../db/singleton';
import type { UnderstatTeamJobData } from '../queues/understat-team.queue';
import { understatClient } from '../clients/understat';
import {
  createUnderstatTeamRepository,
  understatReferenceRepository,
  understatTeamRepository,
} from '../repositories/understat';
import { persistUnderstatTeamDiscovery } from '../repositories/understat-discovery';
import { understatSyncRepository } from '../repositories/understat-sync';
import { enqueueUnderstatTeamDetail, enqueueUnderstatTeamPublish } from '../jobs/understat-enqueue';
import {
  transformUnderstatTeamDiscovery,
  transformUnderstatTeamSplits,
  validateUnderstatTeamDates,
} from '../transformers/understat';
import {
  assertNoUnderstatMatchesDisappeared,
  assertUnderstatLeagueSnapshotComplete,
  assertUnderstatResourceHashes,
  assertUnderstatSyncAllowed,
  changedUnderstatTeamStatIds,
  evaluateUnderstatTeamSnapshotCompleteness,
  mergeUnderstatTeamDetailIds,
  plannedUnderstatSeason,
  selectTeamDetailIds,
  teamById,
  withdrawnUnderstatMatchIds,
} from './understat-sync.service';

const LEAGUE_RESOURCE_TYPE = 'league';
const TEAM_RESOURCE_TYPE = 'team-detail';

function requireJobValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`Understat team job requires ${name}`);
  return value;
}

async function alreadySettled(
  runId: string,
  resourceType: string,
  resourceId: string,
): Promise<boolean> {
  const item = await understatSyncRepository.findItem(runId, resourceType, resourceId);
  return item?.status === 'completed' || item?.status === 'skipped';
}

async function publishWhenReady(job: UnderstatTeamJobData, ready: boolean): Promise<void> {
  if (!ready) return;
  await enqueueUnderstatTeamPublish({
    runId: job.runId,
    season: job.season,
    mode: job.mode,
    trigger: job.trigger,
  });
}

async function enqueueTeamDetailJobs(
  job: UnderstatTeamJobData,
  targetIds: number[],
  teams: Map<number, { title: string }>,
): Promise<void> {
  const results = await Promise.allSettled(
    targetIds.map(async (teamId) => {
      const team = teams.get(teamId);
      if (!team) throw new Error(`Understat team ${teamId} disappeared during discovery`);
      await enqueueUnderstatTeamDetail({
        runId: job.runId,
        season: job.season,
        mode: job.mode,
        trigger: job.trigger,
        teamId,
        teamTitle: team.title,
      });
    }),
  );
  const failures: Array<{ teamId: number; message: string }> = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') continue;
    const teamId = targetIds[index]!;
    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
    failures.push({ teamId, message });
    await understatSyncRepository.failItem(
      job.runId,
      TEAM_RESOURCE_TYPE,
      String(teamId),
      `Failed to enqueue Understat team detail: ${message}`,
    );
  }
  if (failures.length > 0) {
    throw new Error(
      `Failed to enqueue ${failures.length} Understat team detail job(s): ${failures
        .map(({ teamId, message }) => `${teamId}: ${message}`)
        .join('; ')}`,
    );
  }
}

export async function discoverUnderstatTeams(job: UnderstatTeamJobData): Promise<void> {
  const { league, sourceYear } = assertUnderstatSyncAllowed(job.season);
  const priorRun = (await understatSyncRepository.findLatestRuns(job.season)).team;
  const priorItems =
    priorRun?.status === 'failed' ? await understatSyncRepository.findItems(priorRun.runId) : [];
  const active = await understatSyncRepository.findActiveRun(job.season, 'team', job.runId);
  if (active) {
    throw new Error(`Understat team run ${active.runId} is already active for ${job.season}`);
  }
  await understatReferenceRepository.ensureSeason(
    plannedUnderstatSeason(job.season, sourceYear, league),
  );
  await understatSyncRepository.createRun({
    runId: job.runId,
    lane: 'team',
    season: job.season,
    mode: job.mode,
    trigger: job.trigger,
  });
  await understatSyncRepository.addItems(job.runId, [
    { resourceType: LEAGUE_RESOURCE_TYPE, resourceId: league },
  ]);
  if (await alreadySettled(job.runId, LEAGUE_RESOURCE_TYPE, league)) {
    await publishWhenReady(job, await understatSyncRepository.refreshRun(job.runId));
    return;
  }
  await understatSyncRepository.markItemRunning(job.runId, LEAGUE_RESOURCE_TYPE, league);

  const sourceCheckedAt = new Date();
  const response = await understatClient.getLeagueData(league, sourceYear);
  const discovery = transformUnderstatTeamDiscovery(
    job.season,
    sourceYear,
    league,
    response,
    sourceCheckedAt,
  );
  assertUnderstatLeagueSnapshotComplete(league, discovery.teams.length, discovery.matches.length);
  discovery.season.state = job.season === getConfig().UNDERSTAT_SEASON ? 'active' : 'complete';
  const [previousMatches, previousStatHashes] = await Promise.all([
    understatReferenceRepository.findMatchesBySeason(job.season),
    understatTeamRepository.getMatchStatHashes(job.season),
  ]);
  assertNoUnderstatMatchesDisappeared(
    previousMatches.map((match) => match.id),
    discovery.matches,
  );
  const withdrawnMatchIds = withdrawnUnderstatMatchIds(previousMatches, discovery.matches);
  const splitTeamIds = await understatTeamRepository.getTeamIdsWithSplits(job.season);
  const withdrawnMatchIdSet = new Set(withdrawnMatchIds);
  const withdrawnTeamIds = previousMatches
    .filter((match) => withdrawnMatchIdSet.has(match.id))
    .flatMap((match) => [match.homeTeamId, match.awayTeamId]);
  const changedTeams = new Set([
    ...changedUnderstatTeamStatIds(discovery.teamMatchStats, previousStatHashes),
    ...withdrawnTeamIds,
  ]);

  const db = await getDb();
  const changed = await db.transaction((tx) =>
    persistUnderstatTeamDiscovery(tx, discovery, withdrawnMatchIds),
  );
  if (changed) await understatSyncRepository.markDataChanged(job.runId);

  const selectedTargetIds = selectTeamDetailIds({
    mode: job.mode,
    teams: discovery.teams,
    explicitTeamIds: job.teamIds,
    changedTeamIds: changedTeams,
    existingTeamIds: splitTeamIds,
    reconcileAll: true,
  });
  const priorUnsettledIds = job.teamIds
    ? []
    : priorItems
        .filter(
          (item) =>
            item.resourceType === TEAM_RESOURCE_TYPE &&
            item.status !== 'completed' &&
            item.status !== 'skipped',
        )
        .map((item) => Number(item.resourceId))
        .filter(Number.isInteger);
  const targetIds = mergeUnderstatTeamDetailIds(selectedTargetIds, changedTeams, priorUnsettledIds);
  const teams = teamById(discovery.teams);
  await understatSyncRepository.addItems(
    job.runId,
    targetIds.map((teamId) => ({ resourceType: TEAM_RESOURCE_TYPE, resourceId: String(teamId) })),
  );
  await enqueueTeamDetailJobs(job, targetIds, teams);
  const sourceHash = contentHash({
    matches: discovery.matches.map((match) => match.sourceHash),
    teams: discovery.teams.map((team) => team.sourceHash),
    stats: discovery.teamMatchStats.map((stat) => stat.sourceHash),
  });
  await publishWhenReady(
    job,
    await understatSyncRepository.completeItem(
      job.runId,
      LEAGUE_RESOURCE_TYPE,
      league,
      sourceHash,
      changed,
    ),
  );
}

export async function syncUnderstatTeamDetail(job: UnderstatTeamJobData): Promise<void> {
  const { sourceYear } = assertUnderstatSyncAllowed(job.season);
  const teamId = requireJobValue(job.teamId, 'teamId');
  const teamTitle = requireJobValue(job.teamTitle, 'teamTitle');
  const resourceId = String(teamId);
  if (await alreadySettled(job.runId, TEAM_RESOURCE_TYPE, resourceId)) {
    await publishWhenReady(job, await understatSyncRepository.refreshRun(job.runId));
    return;
  }
  await understatSyncRepository.markItemRunning(job.runId, TEAM_RESOURCE_TYPE, resourceId);
  const [response, matches] = await Promise.all([
    understatClient.getTeamData(teamTitle, sourceYear),
    understatReferenceRepository.findMatchesBySeason(job.season),
  ]);
  validateUnderstatTeamDates(response, teamId, matches);
  const rows = transformUnderstatTeamSplits(job.season, teamId, response);
  const db = await getDb();
  const changed = await db.transaction((tx) =>
    createUnderstatTeamRepository(tx).replaceSplits(job.season, teamId, rows),
  );
  assertUnderstatResourceHashes(
    `team splits season=${job.season} team=${teamId}`,
    rows.map((row) => row.sourceHash),
    await understatTeamRepository.getSplitHashes(job.season, teamId),
  );
  await publishWhenReady(
    job,
    await understatSyncRepository.completeItem(
      job.runId,
      TEAM_RESOURCE_TYPE,
      resourceId,
      contentHash(rows.map((row) => row.sourceHash)),
      changed,
    ),
  );
}

export async function publishUnderstatTeamSnapshot(job: UnderstatTeamJobData): Promise<void> {
  assertUnderstatSyncAllowed(job.season);
  const run = await understatSyncRepository.findRun(job.runId);
  if (!run || run.lane !== 'team') throw new Error(`Unknown Understat team run ${job.runId}`);
  if (run.status === 'published') return;
  if (run.failedItems > 0 || run.status !== 'ready_to_publish') {
    throw new Error(`Understat team run ${job.runId} is not ready to publish (${run.status})`);
  }
  const snapshot = await understatTeamRepository.readSnapshot(job.season);
  const completeness = evaluateUnderstatTeamSnapshotCompleteness(
    getConfig().UNDERSTAT_LEAGUE,
    snapshot,
  );
  if (!completeness.complete) {
    await understatSyncRepository.markCompletedWithoutPublish(job.runId, completeness.reason);
    return;
  }
  const prior = await understatCache.getManifest(job.season, 'team');
  const referenceRevision = understatTeamReferenceRevision(snapshot);
  const hasUnpublishedChanges = prior
    ? await understatSyncRepository.hasDataChangesSince(
        job.season,
        'team',
        new Date(prior.publishedAt),
      )
    : true;
  const referenceChanged = prior?.referenceRevision !== referenceRevision;
  if (
    prior?.revision === job.runId ||
    (!run.dataChanged && prior && !hasUnpublishedChanges && !referenceChanged)
  ) {
    await understatSyncRepository.markPublished(job.runId, prior.revision);
    return;
  }
  const manifest = await understatCache.publishTeam(job.season, job.runId, snapshot);
  await understatSyncRepository.markPublished(job.runId, manifest.revision);
}

export function understatTeamItemForJob(job: UnderstatTeamJobData, name: string) {
  if (name === 'understat-team-discover') {
    return { resourceType: LEAGUE_RESOURCE_TYPE, resourceId: getConfigLeague() };
  }
  if (name === 'understat-team-detail' && job.teamId !== undefined) {
    return { resourceType: TEAM_RESOURCE_TYPE, resourceId: String(job.teamId) };
  }
  return null;
}

function getConfigLeague(): string {
  // Failure bookkeeping must still identify the discover item if the provider
  // was disabled between enqueue and execution.
  return getConfig().UNDERSTAT_LEAGUE;
}
