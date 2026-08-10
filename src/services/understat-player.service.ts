import { understatClient } from '../clients/understat';
import { getDb } from '../db/singleton';
import {
  enqueueUnderstatPlayerMatch,
  enqueueUnderstatPlayerFinalize,
  enqueueUnderstatPlayerTeamDetail,
} from '../jobs/understat-enqueue';
import type { UnderstatPlayerJobData } from '../queues/understat-player.queue';
import {
  createUnderstatPlayerRepository,
  createUnderstatReferenceRepository,
  understatPlayerRepository,
  understatReferenceRepository,
} from '../repositories/understat';
import { persistUnderstatPlayerDiscovery } from '../repositories/understat-discovery';
import { understatSyncRepository } from '../repositories/understat-sync';
import {
  findUnderstatRosterAggregateDifferences,
  transformUnderstatMatchRoster,
  transformUnderstatPlayerDiscovery,
  transformUnderstatTeamParticipants,
  validateUnderstatTeamDates,
} from '../transformers/understat';
import { getConfig } from '../utils/config';
import { logWarn } from '../utils/logger';
import {
  assertNoUnderstatMatchesDisappeared,
  assertUnderstatLeagueSnapshotComplete,
  assertUnderstatResourceHashes,
  assertUnderstatSyncAllowed,
  changedUnderstatPlayerSeasonIds,
  changedUnderstatPlayerTeamIds,
  evaluateUnderstatPlayerSnapshotCompleteness,
  mergeUnderstatTeamDetailIds,
  selectPlayerMatchIds,
  selectTeamDetailIds,
  teamById,
  withdrawnUnderstatMatchIds,
} from './understat-sync.service';
import {
  readStagedUnderstatPlayerLeague,
  readStagedUnderstatPlayerMatchDetail,
  readStagedUnderstatPlayerTeamDetail,
  stageUnderstatPlayerLeague,
  stageUnderstatPlayerMatchDetail,
  stageUnderstatPlayerTeamDetail,
  understatStagingHash,
} from './understat-staging';
import { enqueueUnderstatFanout, selectUnsettledUnderstatFanoutIds } from './understat-fanout';

const LEAGUE_RESOURCE_TYPE = 'league';
const TEAM_RESOURCE_TYPE = 'team-participants';
const MATCH_RESOURCE_TYPE = 'match-roster';

function requireJobValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`Understat player job requires ${name}`);
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

async function finalizeWhenReady(job: UnderstatPlayerJobData, ready: boolean): Promise<void> {
  if (!ready) return;
  await enqueueUnderstatPlayerFinalize({
    runId: job.runId,
    season: job.season,
    mode: job.mode,
    trigger: job.trigger,
  });
}

async function enqueuePlayerDetailJobs(
  job: UnderstatPlayerJobData,
  targetTeamIds: number[],
  targetMatchIds: number[],
  teams: Map<number, { title: string }>,
): Promise<void> {
  const jobs = [
    ...targetTeamIds.map((teamId) => ({
      resourceType: TEAM_RESOURCE_TYPE,
      resourceId: String(teamId),
      enqueue: async () => {
        const team = teams.get(teamId);
        if (!team) throw new Error(`Understat team ${teamId} disappeared during discovery`);
        await enqueueUnderstatPlayerTeamDetail({
          runId: job.runId,
          season: job.season,
          mode: job.mode,
          trigger: job.trigger,
          resourceId: teamId,
          teamTitle: team.title,
        });
      },
    })),
    ...targetMatchIds.map((matchId) => ({
      resourceType: MATCH_RESOURCE_TYPE,
      resourceId: String(matchId),
      enqueue: async () => {
        await enqueueUnderstatPlayerMatch({
          runId: job.runId,
          season: job.season,
          mode: job.mode,
          trigger: job.trigger,
          resourceId: matchId,
        });
      },
    })),
  ];
  await enqueueUnderstatFanout('Understat player detail', jobs);
}

export async function discoverUnderstatPlayers(job: UnderstatPlayerJobData): Promise<void> {
  const { league, sourceYear } = assertUnderstatSyncAllowed(job.season);
  const priorRun = (await understatSyncRepository.findLatestRuns(job.season)).player;
  const priorItems =
    priorRun?.status === 'failed' ? await understatSyncRepository.findItems(priorRun.runId) : [];
  const active = await understatSyncRepository.findActiveRun(job.season, 'player', job.runId);
  if (active) {
    throw new Error(`Understat player run ${active.runId} is already active for ${job.season}`);
  }
  await understatSyncRepository.createRun({
    runId: job.runId,
    lane: 'player',
    season: job.season,
    mode: job.mode,
    trigger: job.trigger,
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
    const discovery = readStagedUnderstatPlayerLeague(
      leagueItem.normalizedPayload,
      leagueItem.sourceHash,
      job.season,
    );
    const items = await understatSyncRepository.findItems(job.runId);
    await enqueuePlayerDetailJobs(
      job,
      selectUnsettledUnderstatFanoutIds(items, TEAM_RESOURCE_TYPE),
      selectUnsettledUnderstatFanoutIds(items, MATCH_RESOURCE_TYPE),
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

  const sourceCheckedAt = new Date();
  const response = await understatClient.getLeagueData(league, sourceYear);
  const discovery = transformUnderstatPlayerDiscovery(
    job.season,
    sourceYear,
    league,
    response,
    sourceCheckedAt,
  );
  assertUnderstatLeagueSnapshotComplete(league, discovery.teams.length, discovery.matches.length);
  discovery.season.state = job.season === getConfig().UNDERSTAT_SEASON ? 'active' : 'complete';
  const completedMatchIds = discovery.matches
    .filter((match) => match.isResult)
    .map((match) => match.id);
  const [previousMatches, previousPlayerHashes, existingParticipantTeams, syncedMatchIds] =
    await Promise.all([
      understatReferenceRepository.findMatchesBySeason(job.season),
      understatPlayerRepository.getPlayerSeasonHashes(job.season),
      understatPlayerRepository.getTeamIdsWithParticipants(job.season),
      understatPlayerRepository.getSyncedMatchIds(completedMatchIds),
    ]);
  assertNoUnderstatMatchesDisappeared(
    previousMatches.map((match) => match.id),
    discovery.matches,
  );
  const changedPlayerIds = changedUnderstatPlayerSeasonIds(
    discovery.playerSeasons,
    previousPlayerHashes,
  );
  const discoveredPlayerChangeTeamIds = changedUnderstatPlayerTeamIds(
    discovery.playerSeasons,
    changedPlayerIds,
    discovery.teams,
  );
  const participantChangeTeamIds = await understatPlayerRepository.getTeamIdsForPlayers(
    job.season,
    [...changedPlayerIds],
  );
  const changedPlayerMatchIds = await understatPlayerRepository.getMatchIdsForPlayers(job.season, [
    ...changedPlayerIds,
  ]);
  const newMatchTeamIds = discovery.matches
    .filter((match) => match.isResult && !syncedMatchIds.has(match.id))
    .flatMap((match) => [match.homeTeamId, match.awayTeamId]);
  const changedTeams = new Set([
    ...participantChangeTeamIds,
    ...discoveredPlayerChangeTeamIds,
    ...newMatchTeamIds,
  ]);

  const selectedTeamIds = selectTeamDetailIds({
    mode: job.mode,
    teams: discovery.teams,
    explicitTeamIds: job.teamIds,
    changedTeamIds: changedTeams,
    existingTeamIds: existingParticipantTeams,
    reconcileAll: false,
  });
  const priorTeamIds = job.teamIds
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
  const targetTeamIds = mergeUnderstatTeamDetailIds(selectedTeamIds, changedTeams, priorTeamIds);
  const selectedMatchIds = selectPlayerMatchIds({
    mode: job.mode,
    matches: discovery.matches,
    syncedMatchIds,
    explicitMatchIds: job.matchIds,
    requiredMatchIds: changedPlayerMatchIds,
  });
  const priorMatchIds = job.matchIds
    ? []
    : priorItems
        .filter(
          (item) =>
            item.resourceType === MATCH_RESOURCE_TYPE &&
            item.status !== 'completed' &&
            item.status !== 'skipped',
        )
        .map((item) => Number(item.resourceId))
        .filter(Number.isInteger);
  const targetMatchIds = [...new Set([...selectedMatchIds, ...priorMatchIds])].sort(
    (left, right) => left - right,
  );
  const teams = teamById(discovery.teams);
  await understatSyncRepository.addItems(job.runId, [
    ...targetTeamIds.map((teamId) => ({
      resourceType: TEAM_RESOURCE_TYPE,
      resourceId: String(teamId),
    })),
    ...targetMatchIds.map((matchId) => ({
      resourceType: MATCH_RESOURCE_TYPE,
      resourceId: String(matchId),
    })),
  ]);
  const staged = stageUnderstatPlayerLeague(job.season, discovery);
  const ready = await understatSyncRepository.completeItem(
    job.runId,
    LEAGUE_RESOURCE_TYPE,
    league,
    understatStagingHash(staged),
    staged,
  );
  await enqueuePlayerDetailJobs(job, targetTeamIds, targetMatchIds, teams);
  await finalizeWhenReady(job, ready);
}

export async function syncUnderstatPlayerTeamDetail(job: UnderstatPlayerJobData): Promise<void> {
  const { sourceYear } = assertUnderstatSyncAllowed(job.season);
  const teamId = requireJobValue(job.resourceId, 'resourceId');
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
  if (!leagueItem) throw new Error(`Understat player run ${job.runId} has no staged league item`);
  const matches = readStagedUnderstatPlayerLeague(
    leagueItem.normalizedPayload,
    leagueItem.sourceHash,
    job.season,
  ).matches;
  validateUnderstatTeamDates(response, teamId, matches);
  const transformed = transformUnderstatTeamParticipants(job.season, teamId, response);
  const staged = stageUnderstatPlayerTeamDetail(
    job.season,
    teamId,
    transformed.players,
    transformed.playerTeamSeasons,
  );
  await finalizeWhenReady(
    job,
    await understatSyncRepository.completeItem(
      job.runId,
      TEAM_RESOURCE_TYPE,
      resourceId,
      understatStagingHash(staged),
      staged,
    ),
  );
}

export async function syncUnderstatPlayerMatch(job: UnderstatPlayerJobData): Promise<void> {
  assertUnderstatSyncAllowed(job.season);
  const matchId = requireJobValue(job.resourceId, 'resourceId');
  const resourceId = String(matchId);
  if (await alreadySettled(job.runId, MATCH_RESOURCE_TYPE, resourceId)) {
    await finalizeWhenReady(job, await understatSyncRepository.refreshRun(job.runId));
    return;
  }
  await understatSyncRepository.markItemRunning(job.runId, MATCH_RESOURCE_TYPE, resourceId);
  const leagueItem = await understatSyncRepository.findItem(
    job.runId,
    LEAGUE_RESOURCE_TYPE,
    getConfig().UNDERSTAT_LEAGUE,
  );
  if (!leagueItem) throw new Error(`Understat player run ${job.runId} has no staged league item`);
  const match = readStagedUnderstatPlayerLeague(
    leagueItem.normalizedPayload,
    leagueItem.sourceHash,
    job.season,
  ).matches.find((candidate) => candidate.id === matchId);
  if (!match || match.season !== job.season || !match.isResult) {
    throw new Error(`Understat completed match ${matchId} is unavailable for ${job.season}`);
  }
  const response = await understatClient.getMatchData(matchId);
  const transformed = transformUnderstatMatchRoster(match, response);
  const aggregateDifferences = findUnderstatRosterAggregateDifferences(match, transformed.stats);
  if (aggregateDifferences.length > 0) {
    logWarn('Understat roster aggregates differ from league match totals', {
      season: job.season,
      matchId,
      differences: aggregateDifferences,
    });
  }
  const staged = stageUnderstatPlayerMatchDetail(
    job.season,
    matchId,
    transformed.players,
    transformed.stats,
  );
  await finalizeWhenReady(
    job,
    await understatSyncRepository.completeItem(
      job.runId,
      MATCH_RESOURCE_TYPE,
      resourceId,
      understatStagingHash(staged),
      staged,
    ),
  );
}

class IncompleteUnderstatPlayerSnapshotError extends Error {}

export async function finalizeUnderstatPlayerRun(job: UnderstatPlayerJobData): Promise<void> {
  assertUnderstatSyncAllowed(job.season);
  const run = await understatSyncRepository.findRun(job.runId);
  if (!run || run.lane !== 'player') throw new Error(`Unknown Understat player run ${job.runId}`);
  if (run.status === 'completed' || run.status === 'skipped') return;
  if (run.failedItems > 0 || run.status !== 'ready_to_publish') {
    throw new Error(`Understat player run ${job.runId} is not ready to finalize (${run.status})`);
  }
  const items = await understatSyncRepository.findItems(job.runId);
  if (items.length !== run.expectedItems || items.some((item) => item.status !== 'completed')) {
    throw new Error(`Understat player run ${job.runId} has unsettled staging items`);
  }
  const leagueItem = items.find((item) => item.resourceType === LEAGUE_RESOURCE_TYPE);
  if (!leagueItem) throw new Error(`Understat player run ${job.runId} has no league staging item`);
  const discovery = readStagedUnderstatPlayerLeague(
    leagueItem.normalizedPayload,
    leagueItem.sourceHash,
    job.season,
  );
  const teamDetails = items
    .filter((item) => item.resourceType === TEAM_RESOURCE_TYPE)
    .map((item) =>
      readStagedUnderstatPlayerTeamDetail(item.normalizedPayload, item.sourceHash, job.season),
    )
    .sort((left, right) => left.teamId - right.teamId);
  const matchDetails = items
    .filter((item) => item.resourceType === MATCH_RESOURCE_TYPE)
    .map((item) =>
      readStagedUnderstatPlayerMatchDetail(item.normalizedPayload, item.sourceHash, job.season),
    )
    .sort((left, right) => left.matchId - right.matchId);

  try {
    const db = await getDb();
    const result = await db.transaction(async (tx) => {
      const references = createUnderstatReferenceRepository(tx);
      const players = createUnderstatPlayerRepository(tx);
      const previousMatches = await references.findMatchesBySeason(job.season);
      assertNoUnderstatMatchesDisappeared(
        previousMatches.map((match) => match.id),
        discovery.matches,
      );
      const withdrawnMatchIds = withdrawnUnderstatMatchIds(previousMatches, discovery.matches);
      let changed = await persistUnderstatPlayerDiscovery(tx, discovery, withdrawnMatchIds);
      for (const detail of teamDetails) {
        const identityChanges = await players.upsertPlayers(detail.players);
        const participantsChanged = await players.replaceTeamParticipants(
          job.season,
          detail.teamId,
          detail.rows,
        );
        changed = identityChanges > 0 || participantsChanged || changed;
        assertUnderstatResourceHashes(
          `team participants season=${job.season} team=${detail.teamId}`,
          detail.rows.map((row) => row.sourceHash),
          await players.getTeamParticipantHashes(job.season, detail.teamId),
        );
      }
      for (const detail of matchDetails) {
        const identityChanges = await players.upsertPlayers(detail.players);
        const matchChanged = await players.replaceMatchStats(detail.matchId, detail.rows);
        changed = identityChanges > 0 || matchChanged || changed;
        assertUnderstatResourceHashes(
          `match roster match=${detail.matchId}`,
          detail.rows.map((row) => row.sourceHash),
          await players.getMatchStatHashes(detail.matchId),
        );
      }
      const [snapshot, matches] = await Promise.all([
        players.readSnapshot(job.season),
        references.findMatchesBySeason(job.season),
      ]);
      const completeness = evaluateUnderstatPlayerSnapshotCompleteness(
        getConfig().UNDERSTAT_LEAGUE,
        matches,
        snapshot,
      );
      if (!completeness.complete) {
        throw new IncompleteUnderstatPlayerSnapshotError(completeness.reason);
      }
      return {
        changed,
        counts: {
          players: snapshot.players.length,
          memberships: snapshot.memberships.length,
          playerMatchStats: snapshot.matchStats.length,
        },
      };
    });
    await understatSyncRepository.markRunCompleted(
      job.runId,
      { finalized: true, storage: 'postgresql', counts: result.counts },
      result.changed,
    );
  } catch (error) {
    if (error instanceof IncompleteUnderstatPlayerSnapshotError) {
      await understatSyncRepository.markRunSkipped(job.runId, error.message);
      return;
    }
    throw error;
  }
}

export function understatPlayerItemForJob(job: UnderstatPlayerJobData, name: string) {
  if (name === 'understat-player-discover') {
    return { resourceType: LEAGUE_RESOURCE_TYPE, resourceId: getConfig().UNDERSTAT_LEAGUE };
  }
  if (name === 'understat-player-team-detail' && job.resourceId !== undefined) {
    return { resourceType: TEAM_RESOURCE_TYPE, resourceId: String(job.resourceId) };
  }
  if (name === 'understat-player-match' && job.resourceId !== undefined) {
    return { resourceType: MATCH_RESOURCE_TYPE, resourceId: String(job.resourceId) };
  }
  return null;
}
