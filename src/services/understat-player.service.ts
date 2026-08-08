import { understatCache, understatPlayerReferenceRevision } from '../cache/understat-cache';
import { understatClient } from '../clients/understat';
import { getDb } from '../db/singleton';
import {
  enqueueUnderstatPlayerMatch,
  enqueueUnderstatPlayerPublish,
  enqueueUnderstatPlayerTeamDetail,
} from '../jobs/understat-enqueue';
import type { UnderstatPlayerJobData } from '../queues/understat-player.queue';
import {
  createUnderstatPlayerRepository,
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
import { contentHash } from '../utils/content-hash';
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
  plannedUnderstatSeason,
  selectPlayerMatchIds,
  selectTeamDetailIds,
  teamById,
  withdrawnUnderstatMatchIds,
} from './understat-sync.service';

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

async function publishWhenReady(job: UnderstatPlayerJobData, ready: boolean): Promise<void> {
  if (!ready) return;
  await enqueueUnderstatPlayerPublish({
    runId: job.runId,
    season: job.season,
    mode: job.mode,
    trigger: job.trigger,
  });
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
  await understatReferenceRepository.ensureSeason(
    plannedUnderstatSeason(job.season, sourceYear, league),
  );
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
  if (await alreadySettled(job.runId, LEAGUE_RESOURCE_TYPE, league)) {
    await publishWhenReady(job, await understatSyncRepository.refreshRun(job.runId));
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
  const withdrawnMatchIds = withdrawnUnderstatMatchIds(previousMatches, discovery.matches);
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
  const newMatchTeamIds = discovery.matches
    .filter((match) => match.isResult && !syncedMatchIds.has(match.id))
    .flatMap((match) => [match.homeTeamId, match.awayTeamId]);
  const changedTeams = new Set([
    ...participantChangeTeamIds,
    ...discoveredPlayerChangeTeamIds,
    ...newMatchTeamIds,
  ]);

  const db = await getDb();
  const changed = await db.transaction((tx) =>
    persistUnderstatPlayerDiscovery(tx, discovery, withdrawnMatchIds),
  );
  if (changed) await understatSyncRepository.markDataChanged(job.runId);

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
  const selectedMatchIds = job.participantsOnly
    ? []
    : selectPlayerMatchIds({
        mode: job.mode,
        matches: discovery.matches,
        syncedMatchIds,
        explicitMatchIds: job.matchIds,
      });
  const priorMatchIds =
    job.matchIds || job.participantsOnly
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

  await Promise.all([
    ...targetTeamIds.map((teamId) => {
      const team = teams.get(teamId);
      if (!team) throw new Error(`Understat team ${teamId} disappeared during discovery`);
      return enqueueUnderstatPlayerTeamDetail({
        runId: job.runId,
        season: job.season,
        mode: job.mode,
        trigger: job.trigger,
        resourceId: teamId,
        teamTitle: team.title,
      });
    }),
    ...targetMatchIds.map((matchId) =>
      enqueueUnderstatPlayerMatch({
        runId: job.runId,
        season: job.season,
        mode: job.mode,
        trigger: job.trigger,
        resourceId: matchId,
      }),
    ),
  ]);

  const sourceHash = contentHash({
    matches: discovery.matches.map((match) => match.sourceHash),
    players: discovery.players.map((player) => player.sourceHash),
    seasons: discovery.playerSeasons.map((season) => season.sourceHash),
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

export async function syncUnderstatPlayerTeamDetail(job: UnderstatPlayerJobData): Promise<void> {
  const { sourceYear } = assertUnderstatSyncAllowed(job.season);
  const teamId = requireJobValue(job.resourceId, 'resourceId');
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
  const transformed = transformUnderstatTeamParticipants(job.season, teamId, response);
  const db = await getDb();
  const changed = await db.transaction(async (tx) => {
    const players = createUnderstatPlayerRepository(tx);
    const identityChanges = await players.upsertPlayers(transformed.players);
    const participantsChanged = await players.replaceTeamParticipants(
      job.season,
      teamId,
      transformed.playerTeamSeasons,
    );
    return participantsChanged || identityChanges > 0;
  });
  assertUnderstatResourceHashes(
    `team participants season=${job.season} team=${teamId}`,
    transformed.playerTeamSeasons.map((row) => row.sourceHash),
    await understatPlayerRepository.getTeamParticipantHashes(job.season, teamId),
  );
  await publishWhenReady(
    job,
    await understatSyncRepository.completeItem(
      job.runId,
      TEAM_RESOURCE_TYPE,
      resourceId,
      contentHash(transformed.playerTeamSeasons.map((row) => row.sourceHash)),
      changed,
    ),
  );
}

export async function syncUnderstatPlayerMatch(job: UnderstatPlayerJobData): Promise<void> {
  assertUnderstatSyncAllowed(job.season);
  const matchId = requireJobValue(job.resourceId, 'resourceId');
  const resourceId = String(matchId);
  if (await alreadySettled(job.runId, MATCH_RESOURCE_TYPE, resourceId)) {
    await publishWhenReady(job, await understatSyncRepository.refreshRun(job.runId));
    return;
  }
  await understatSyncRepository.markItemRunning(job.runId, MATCH_RESOURCE_TYPE, resourceId);
  const match = await understatReferenceRepository.findMatch(matchId);
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
  const db = await getDb();
  const changed = await db.transaction(async (tx) => {
    const players = createUnderstatPlayerRepository(tx);
    const identityChanges = await players.upsertPlayers(transformed.players);
    const matchChanged = await players.replaceMatchStats(matchId, transformed.stats);
    return matchChanged || identityChanges > 0;
  });
  assertUnderstatResourceHashes(
    `match roster match=${matchId}`,
    transformed.stats.map((row) => row.sourceHash),
    await understatPlayerRepository.getMatchStatHashes(matchId),
  );
  await publishWhenReady(
    job,
    await understatSyncRepository.completeItem(
      job.runId,
      MATCH_RESOURCE_TYPE,
      resourceId,
      contentHash(transformed.stats.map((row) => row.sourceHash)),
      changed,
    ),
  );
}

export async function publishUnderstatPlayerSnapshot(job: UnderstatPlayerJobData): Promise<void> {
  assertUnderstatSyncAllowed(job.season);
  const run = await understatSyncRepository.findRun(job.runId);
  if (!run || run.lane !== 'player') throw new Error(`Unknown Understat player run ${job.runId}`);
  if (run.status === 'published') return;
  if (run.failedItems > 0 || run.status !== 'ready_to_publish') {
    throw new Error(`Understat player run ${job.runId} is not ready to publish (${run.status})`);
  }
  const [snapshot, matches] = await Promise.all([
    understatPlayerRepository.readSnapshot(job.season),
    understatReferenceRepository.findMatchesBySeason(job.season),
  ]);
  const completeness = evaluateUnderstatPlayerSnapshotCompleteness(
    getConfig().UNDERSTAT_LEAGUE,
    matches,
    snapshot,
  );
  if (!completeness.complete) {
    await understatSyncRepository.markCompletedWithoutPublish(job.runId, completeness.reason);
    return;
  }
  const prior = await understatCache.getManifest(job.season, 'player');
  const referenceRevision = understatPlayerReferenceRevision(snapshot);
  const hasUnpublishedChanges = prior
    ? await understatSyncRepository.hasDataChangesSince(
        job.season,
        'player',
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
  const manifest = await understatCache.publishPlayer(job.season, job.runId, snapshot);
  await understatSyncRepository.markPublished(job.runId, manifest.revision);
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
