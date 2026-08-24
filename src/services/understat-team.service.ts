import { getConfig } from '../utils/config';
import { getDb } from '../db/singleton';
import type { UnderstatTeamDiscovery } from '../domain/understat';
import type { UnderstatTeamJobData } from '../queues/understat-team.queue';
import { understatClient } from '../clients/understat';
import {
  createUnderstatReferenceRepository,
  createUnderstatTeamRepository,
  understatReferenceRepository,
  understatTeamRepository,
} from '../repositories/understat';
import { persistUnderstatTeamDiscovery } from '../repositories/understat-discovery';
import {
  createUnderstatSyncRepository,
  understatSyncRepository,
} from '../repositories/understat-sync';
import {
  enqueueUnderstatTeamDetail,
  enqueueUnderstatTeamFinalize,
} from '../jobs/understat-enqueue';
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
  evaluateUnderstatTeamResourceCompleteness,
  IncompleteUnderstatResourceError,
  mergeUnderstatTeamDetailIds,
  selectCompleteUnderstatTeamSeasonRows,
  selectTeamDetailIds,
  teamById,
  withdrawnUnderstatMatchIds,
} from './understat-sync.service';
import {
  readStagedUnderstatTeamDetail,
  readStagedUnderstatTeamLeague,
  stageUnderstatTeamDetail,
  stageUnderstatTeamLeague,
  understatStagingHash,
} from './understat-staging';
import { enqueueUnderstatFanout, selectUnsettledUnderstatFanoutIds } from './understat-fanout';

const LEAGUE_RESOURCE_TYPE = 'league';
const TEAM_RESOURCE_TYPE = 'team-detail';

function obligationFields(job: UnderstatTeamJobData): {
  obligationId?: string;
  obligationGeneration?: number;
} {
  return {
    ...(job.obligationId ? { obligationId: job.obligationId } : {}),
    ...(job.obligationGeneration === undefined
      ? {}
      : { obligationGeneration: job.obligationGeneration }),
  };
}

type UnderstatTeamDetailSnapshot = ReturnType<typeof readStagedUnderstatTeamDetail>;

async function persistUnderstatTeamDiscoverySnapshot(
  runId: string,
  season: string,
  discovery: UnderstatTeamDiscovery,
): Promise<boolean> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const references = createUnderstatReferenceRepository(tx);
    const previousMatches = await references.findMatchesBySeason(season);
    assertNoUnderstatMatchesDisappeared(
      previousMatches.map((match) => match.id),
      discovery.matches,
    );
    const withdrawnMatchIds = withdrawnUnderstatMatchIds(previousMatches, discovery.matches);
    const changed = await persistUnderstatTeamDiscovery(tx, discovery, withdrawnMatchIds);
    if (changed) await createUnderstatSyncRepository(tx).markRunDataChanged(runId);
    return changed;
  });
}

function discoveryForPersistence(
  discovery: UnderstatTeamDiscovery,
  activeIncremental: boolean,
): UnderstatTeamDiscovery {
  if (!activeIncremental) return discovery;
  return {
    ...discovery,
    teamSeasons: selectCompleteUnderstatTeamSeasonRows(
      discovery.matches,
      discovery.teamMatchStats,
      discovery.teamSeasons,
    ),
  };
}

async function persistUnderstatTeamResource(
  runId: string,
  season: string,
  discovery: UnderstatTeamDiscovery,
  detail: UnderstatTeamDetailSnapshot,
): Promise<{ changed: boolean; complete: boolean; reason: string }> {
  const completeness = evaluateUnderstatTeamResourceCompleteness(
    detail.teamId,
    discovery,
    detail.rows,
  );
  if (!completeness.complete) {
    return { changed: false, complete: false, reason: completeness.reason };
  }

  const db = await getDb();
  const changed = await db.transaction(async (tx) => {
    const teams = createUnderstatTeamRepository(tx);
    const result = await teams.replaceSplits(season, detail.teamId, detail.rows);
    assertUnderstatResourceHashes(
      `team splits season=${season} team=${detail.teamId}`,
      detail.rows.map((row) => row.sourceHash),
      await teams.getSplitHashes(season, detail.teamId),
    );
    if (result) await createUnderstatSyncRepository(tx).markRunDataChanged(runId);
    return result;
  });
  return { changed, complete: true, reason: completeness.reason };
}

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

async function finalizeWhenReady(job: UnderstatTeamJobData, ready: boolean): Promise<void> {
  if (!ready) return;
  await enqueueUnderstatTeamFinalize({
    runId: job.runId,
    season: job.season,
    mode: job.mode,
    trigger: job.trigger,
    ...obligationFields(job),
  });
}

async function enqueueTeamDetailJobs(
  job: UnderstatTeamJobData,
  targetIds: number[],
  teams: Map<number, { title: string }>,
): Promise<void> {
  await enqueueUnderstatFanout(
    'Understat team detail',
    targetIds.map((teamId) => ({
      resourceType: TEAM_RESOURCE_TYPE,
      resourceId: String(teamId),
      enqueue: async () => {
        const team = teams.get(teamId);
        if (!team) throw new Error(`Understat team ${teamId} disappeared during discovery`);
        await enqueueUnderstatTeamDetail({
          runId: job.runId,
          season: job.season,
          mode: job.mode,
          trigger: job.trigger,
          ...obligationFields(job),
          teamId,
          teamTitle: team.title,
        });
      },
    })),
  );
}

export async function discoverUnderstatTeams(job: UnderstatTeamJobData): Promise<void> {
  const { league, sourceYear } = assertUnderstatSyncAllowed(job.season);
  const config = getConfig();
  const activeSeason = job.season === config.UNDERSTAT_SEASON;
  const activeIncremental = activeSeason && job.mode === 'incremental';
  const priorRun = (await understatSyncRepository.findLatestRuns(job.season)).team;
  const priorItems =
    priorRun && (priorRun.status === 'failed' || priorRun.status === 'completed')
      ? await understatSyncRepository.findItems(priorRun.runId)
      : [];
  const active = await understatSyncRepository.findActiveRun(job.season, 'team', job.runId);
  if (active) {
    throw new Error(`Understat team run ${active.runId} is already active for ${job.season}`);
  }
  await understatSyncRepository.createRun({
    runId: job.runId,
    lane: 'team',
    season: job.season,
    mode: job.mode,
    trigger: job.trigger,
    ...obligationFields(job),
  });
  await understatSyncRepository.addItems(job.runId, [
    { resourceType: LEAGUE_RESOURCE_TYPE, resourceId: league },
  ]);
  const leagueItem = await understatSyncRepository.findItem(
    job.runId,
    LEAGUE_RESOURCE_TYPE,
    league,
  );
  if (leagueItem?.status === 'completed') {
    const discovery = readStagedUnderstatTeamLeague(
      leagueItem.normalizedPayload,
      leagueItem.sourceHash,
      job.season,
    );
    await persistUnderstatTeamDiscoverySnapshot(
      job.runId,
      job.season,
      discoveryForPersistence(discovery, activeIncremental),
    );
    const items = await understatSyncRepository.findItems(job.runId);
    await enqueueTeamDetailJobs(
      job,
      selectUnsettledUnderstatFanoutIds(items, TEAM_RESOURCE_TYPE),
      teamById(discovery.teams),
    );
    await finalizeWhenReady(job, await understatSyncRepository.refreshRun(job.runId));
    return;
  }
  if (leagueItem?.status === 'skipped') {
    await finalizeWhenReady(job, await understatSyncRepository.refreshRun(job.runId));
    return;
  }
  await understatSyncRepository.markItemRunning(job.runId, LEAGUE_RESOURCE_TYPE, league);
  const currentRunItems = await understatSyncRepository.findItems(job.runId);
  const sameRunTeamIds = selectUnsettledUnderstatFanoutIds(currentRunItems, TEAM_RESOURCE_TYPE);

  const sourceCheckedAt = new Date();
  const response = await understatClient.getLeagueData(league, sourceYear);
  const discovery = transformUnderstatTeamDiscovery(
    job.season,
    sourceYear,
    league,
    response,
    sourceCheckedAt,
    activeIncremental,
  );
  if (!activeIncremental) {
    assertUnderstatLeagueSnapshotComplete(league, discovery.teams.length, discovery.matches.length);
  }
  discovery.season.state = activeSeason ? 'active' : 'complete';
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

  const selectedTargetIds = selectTeamDetailIds({
    mode: job.mode,
    teams: discovery.teams,
    explicitTeamIds: job.teamIds,
    changedTeamIds: changedTeams,
    existingTeamIds: splitTeamIds,
    reconcileAll: true,
  });
  const priorUnsettledIds = priorItems
    .filter(
      (item) =>
        item.resourceType === TEAM_RESOURCE_TYPE &&
        (item.status === 'failed' ||
          item.status === 'pending' ||
          item.status === 'running' ||
          item.status === 'skipped'),
    )
    .map((item) => Number(item.resourceId))
    .filter(Number.isInteger)
    .filter((teamId) => discovery.teams.some((team) => team.id === teamId));
  const targetIds = mergeUnderstatTeamDetailIds(selectedTargetIds, changedTeams, [
    ...priorUnsettledIds,
    ...sameRunTeamIds,
  ]);
  const teams = teamById(discovery.teams);
  await understatSyncRepository.addItems(
    job.runId,
    targetIds.map((teamId) => ({ resourceType: TEAM_RESOURCE_TYPE, resourceId: String(teamId) })),
  );
  await persistUnderstatTeamDiscoverySnapshot(
    job.runId,
    job.season,
    discoveryForPersistence(discovery, activeIncremental),
  );
  const staged = stageUnderstatTeamLeague(job.season, discovery);
  const ready = await understatSyncRepository.completeItem(
    job.runId,
    LEAGUE_RESOURCE_TYPE,
    league,
    understatStagingHash(staged),
    staged,
  );
  await enqueueTeamDetailJobs(job, targetIds, teams);
  await finalizeWhenReady(job, ready);
}

export async function syncUnderstatTeamDetail(job: UnderstatTeamJobData): Promise<void> {
  const { sourceYear } = assertUnderstatSyncAllowed(job.season);
  const config = getConfig();
  const activeIncremental = job.season === config.UNDERSTAT_SEASON && job.mode === 'incremental';
  const teamId = requireJobValue(job.teamId, 'teamId');
  const teamTitle = requireJobValue(job.teamTitle, 'teamTitle');
  const resourceId = String(teamId);
  if (await alreadySettled(job.runId, TEAM_RESOURCE_TYPE, resourceId)) {
    await finalizeWhenReady(job, await understatSyncRepository.refreshRun(job.runId));
    return;
  }
  await understatSyncRepository.markItemRunning(job.runId, TEAM_RESOURCE_TYPE, resourceId);
  const [response, leagueItem] = await Promise.all([
    understatClient.getTeamData(teamTitle, sourceYear),
    understatSyncRepository.findItem(job.runId, LEAGUE_RESOURCE_TYPE, getConfig().UNDERSTAT_LEAGUE),
  ]);
  if (!leagueItem) throw new Error(`Understat team run ${job.runId} has no staged league item`);
  const discovery = readStagedUnderstatTeamLeague(
    leagueItem.normalizedPayload,
    leagueItem.sourceHash,
    job.season,
  );
  validateUnderstatTeamDates(response, teamId, discovery.matches, activeIncremental);
  const rows = transformUnderstatTeamSplits(
    job.season,
    teamId,
    response,
    new Set(discovery.matches.map((match) => match.id)),
  );
  const completeness = evaluateUnderstatTeamResourceCompleteness(teamId, discovery, rows);
  if (!completeness.complete) {
    if (!activeIncremental) {
      throw new IncompleteUnderstatResourceError(`team=${teamId} splits`, completeness.reason);
    }
    await finalizeWhenReady(
      job,
      await understatSyncRepository.skipItem(
        job.runId,
        TEAM_RESOURCE_TYPE,
        resourceId,
        completeness.reason,
      ),
    );
    return;
  }
  const staged = stageUnderstatTeamDetail(job.season, teamId, rows);
  const persisted = await persistUnderstatTeamResource(job.runId, job.season, discovery, {
    teamId,
    rows,
  });
  if (!persisted.complete) {
    throw new IncompleteUnderstatResourceError(`team=${teamId} splits`, persisted.reason);
  }
  const ready = await understatSyncRepository.completeItem(
    job.runId,
    TEAM_RESOURCE_TYPE,
    resourceId,
    understatStagingHash(staged),
    staged,
  );
  await finalizeWhenReady(job, ready);
}

export async function finalizeUnderstatTeamRun(job: UnderstatTeamJobData): Promise<void> {
  assertUnderstatSyncAllowed(job.season);
  const config = getConfig();
  const activeIncremental = job.season === config.UNDERSTAT_SEASON && job.mode === 'incremental';
  const run = await understatSyncRepository.findRun(job.runId);
  if (!run || run.lane !== 'team') throw new Error(`Unknown Understat team run ${job.runId}`);
  if (run.status === 'completed' || run.status === 'skipped') return;
  if (run.failedItems > 0 || run.status !== 'ready_to_publish') {
    throw new Error(`Understat team run ${job.runId} is not ready to finalize (${run.status})`);
  }
  const items = await understatSyncRepository.findItems(job.runId);
  if (
    items.length !== run.expectedItems ||
    items.some(
      (item) => item.status !== 'completed' && (!activeIncremental || item.status !== 'skipped'),
    )
  ) {
    throw new Error(`Understat team run ${job.runId} has unsettled staging items`);
  }
  const leagueItem = items.find((item) => item.resourceType === LEAGUE_RESOURCE_TYPE);
  if (!leagueItem || leagueItem.status !== 'completed') {
    throw new Error(`Understat team run ${job.runId} has no completed league staging item`);
  }
  const discovery = readStagedUnderstatTeamLeague(
    leagueItem.normalizedPayload,
    leagueItem.sourceHash,
    job.season,
  );
  const details = items
    .filter((item) => item.resourceType === TEAM_RESOURCE_TYPE && item.status === 'completed')
    .map((item) =>
      readStagedUnderstatTeamDetail(item.normalizedPayload, item.sourceHash, job.season),
    )
    .sort((left, right) => left.teamId - right.teamId);

  const discoveryChanged = await persistUnderstatTeamDiscoverySnapshot(
    job.runId,
    job.season,
    discoveryForPersistence(discovery, activeIncremental),
  );

  let changed = discoveryChanged;
  const incompleteTeams: Array<{ teamId: number; reason: string }> = [];
  for (const detail of details) {
    const result = await persistUnderstatTeamResource(job.runId, job.season, discovery, detail);
    changed = result.changed || changed;
    if (!result.complete) {
      incompleteTeams.push({ teamId: detail.teamId, reason: result.reason });
    }
  }

  const db = await getDb();
  const teams = createUnderstatTeamRepository(db);
  const snapshot = await teams.readSnapshot(job.season);
  await understatSyncRepository.markRunCompleted(
    job.runId,
    {
      finalized: true,
      storage: 'postgresql',
      partial: incompleteTeams.length > 0 || (activeIncremental && run.skippedItems > 0),
      incompleteTeams,
      ...(activeIncremental && run.skippedItems > 0 ? { skippedItems: run.skippedItems } : {}),
      counts: {
        teams: snapshot.teams.length,
        matches: snapshot.matches.length,
        teamMatchStats: snapshot.teamMatchRows.length,
        teamSplits: snapshot.splits.length,
      },
    },
    changed,
  );
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
