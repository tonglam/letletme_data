import { contentHash } from '../utils/content-hash';
import { getConfig } from '../utils/config';
import { getDb } from '../db/singleton';
import type { UnderstatTeamJobData } from '../queues/understat-team.queue';
import { understatClient } from '../clients/understat';
import {
  createUnderstatReferenceRepository,
  createUnderstatTeamRepository,
  understatReferenceRepository,
  understatTeamRepository,
} from '../repositories/understat';
import { understatSyncRepository } from '../repositories/understat-sync';
import { enqueueUnderstatTeamDetail, enqueueUnderstatTeamPublish } from '../jobs/understat-enqueue';
import {
  transformUnderstatTeamDiscovery,
  transformUnderstatTeamSplits,
  validateUnderstatTeamDates,
} from '../transformers/understat';
import { understatCache } from '../cache/understat-cache';
import {
  assertNoUnderstatMatchesDisappeared,
  assertUnderstatLeagueSnapshotComplete,
  assertUnderstatSyncAllowed,
  changedUnderstatTeamStatIds,
  plannedUnderstatSeason,
  selectTeamDetailIds,
  teamById,
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

  const response = await understatClient.getLeagueData(league, sourceYear);
  const discovery = transformUnderstatTeamDiscovery(job.season, sourceYear, league, response);
  assertUnderstatLeagueSnapshotComplete(league, discovery.teams.length, discovery.matches.length);
  discovery.season.state = job.season === getConfig().UNDERSTAT_SEASON ? 'active' : 'complete';
  const [previousMatchHashes, previousStatHashes] = await Promise.all([
    understatReferenceRepository.getMatchHashes(job.season),
    understatTeamRepository.getMatchStatHashes(job.season),
  ]);
  assertNoUnderstatMatchesDisappeared(previousMatchHashes.keys(), discovery.matches);
  const splitTeamIds = await understatTeamRepository.getTeamIdsWithSplits(job.season);
  const changedTeams = changedUnderstatTeamStatIds(discovery.teamMatchStats, previousStatHashes);

  const db = await getDb();
  const changed = await db.transaction(async (tx) => {
    const references = createUnderstatReferenceRepository(tx);
    const teams = createUnderstatTeamRepository(tx);
    if (discovery.season.state === 'active') {
      await references.completeOlderSeasons(discovery.season.season);
    }
    await references.upsertSeason(discovery.season);
    const counts = await Promise.all([
      references.upsertTeams(discovery.teams),
      references.upsertMatches(discovery.matches),
      teams.upsertMatchStats(discovery.teamMatchStats),
      teams.upsertTeamSeasons(discovery.teamSeasons),
    ]);
    return counts.some((count) => count > 0);
  });
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
  const targetIds = [...new Set([...selectedTargetIds, ...priorUnsettledIds])].sort(
    (left, right) => left - right,
  );
  const teams = teamById(discovery.teams);
  await understatSyncRepository.addItems(
    job.runId,
    targetIds.map((teamId) => ({ resourceType: TEAM_RESOURCE_TYPE, resourceId: String(teamId) })),
  );
  await Promise.all(
    targetIds.map((teamId) => {
      const team = teams.get(teamId);
      if (!team) throw new Error(`Understat team ${teamId} disappeared during discovery`);
      return enqueueUnderstatTeamDetail({
        runId: job.runId,
        season: job.season,
        mode: job.mode,
        trigger: job.trigger,
        teamId,
        teamTitle: team.title,
      });
    }),
  );
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
  const prior = await understatCache.getManifest(job.season, 'team');
  const hasUnpublishedChanges = prior
    ? await understatSyncRepository.hasDataChangesSince(
        job.season,
        'team',
        new Date(prior.publishedAt),
      )
    : true;
  if (prior?.revision === job.runId || (!run.dataChanged && prior && !hasUnpublishedChanges)) {
    await understatSyncRepository.markPublished(job.runId, prior.revision);
    return;
  }
  const snapshot = await understatTeamRepository.readSnapshot(job.season);
  if (snapshot.teams.length === 0 || snapshot.matches.length === 0) {
    throw new Error(`Understat team snapshot ${job.season} is incomplete`);
  }
  for (const match of snapshot.matches.filter((candidate) => candidate.isResult)) {
    const rows = snapshot.teamMatchRows.filter((row) => row.match.id === match.id);
    if (
      rows.length !== 2 ||
      !rows.some((row) => row.stat.teamId === match.homeTeamId && row.stat.side === 'h') ||
      !rows.some((row) => row.stat.teamId === match.awayTeamId && row.stat.side === 'a')
    ) {
      throw new Error(`Understat team snapshot match ${match.id} is missing one side`);
    }
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
