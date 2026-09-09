import { understatClient } from '../clients/understat';
import { getDb, registerDatabasePostCommit } from '../db/singleton';
import { withMutationScopes } from '../utils/mutation-scopes';
import { readDatabaseOrderingTimestamp } from '../db/ordering-timestamp';
import type { UnderstatPlayerDiscovery } from '../domain/understat';
import { explicitSeasonRef } from '../domain/fpl-season';
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
import {
  createUnderstatSyncRepository,
  understatSyncRepository,
} from '../repositories/understat-sync';
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
  understatMutationScopes,
  assertUnderstatReferenceSnapshotCurrent,
  assertNoUnderstatMatchesDisappeared,
  assertUnderstatLeagueSnapshotComplete,
  assertUnderstatResourceHashes,
  assertUnderstatResourceHashesIncluded,
  assertUnderstatSyncAllowed,
  changedUnderstatPlayerSeasonIds,
  changedUnderstatPlayerTeamIds,
  evaluateUnderstatPlayerDiscoveryCompleteness,
  evaluateUnderstatPlayerMatchResourceCompleteness,
  evaluateUnderstatPlayerTeamResourceCompleteness,
  IncompleteUnderstatResourceError,
  missingUnderstatDiscoveryTeamIds,
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
import {
  publishUnderstatPlayerState,
  refreshPlayerStateSeasonSafely,
} from './player-season-summaries.service';

const LEAGUE_RESOURCE_TYPE = 'league';
const TEAM_RESOURCE_TYPE = 'team-participants';
const MATCH_RESOURCE_TYPE = 'match-roster';

function obligationFields(job: UnderstatPlayerJobData): {
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

type UnderstatPlayerTeamDetailSnapshot = ReturnType<typeof readStagedUnderstatPlayerTeamDetail>;
type UnderstatPlayerMatchDetailSnapshot = ReturnType<typeof readStagedUnderstatPlayerMatchDetail>;

async function recoverMissingDiscoveryTeams(
  discovery: UnderstatPlayerDiscovery,
  activeIncremental: boolean,
): Promise<void> {
  const missingTeamIds = missingUnderstatDiscoveryTeamIds(discovery.teams, discovery.matches);
  if (missingTeamIds.length === 0) return;
  if (!activeIncremental) {
    throw new IncompleteUnderstatResourceError(
      'player discovery',
      `matches reference team IDs missing from league teams: ${missingTeamIds.join(',')}`,
    );
  }
  const recovered = await understatReferenceRepository.findTeamsByIds(missingTeamIds);
  const recoveredIds = new Set(recovered.map((team) => team.id));
  const unresolved = missingTeamIds.filter((teamId) => !recoveredIds.has(teamId));
  if (unresolved.length > 0) {
    throw new IncompleteUnderstatResourceError(
      'player discovery',
      `matches reference team IDs missing from league payload and database: ${unresolved.join(',')}`,
    );
  }
  discovery.teams = [...discovery.teams, ...recovered].sort((left, right) => left.id - right.id);
}

async function refreshPlayerStateAfterTeamResource(season: string): Promise<void> {
  registerDatabasePostCommit(async () => {
    try {
      await refreshPlayerStateSeasonSafely(explicitSeasonRef(season));
    } catch (error) {
      logWarn('Player State refresh after Understat team resource failed; repair will retry', {
        season,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

async function publishPlayerStateAfterMatchResource(season: string): Promise<void> {
  registerDatabasePostCommit(async () => {
    try {
      await publishUnderstatPlayerState(explicitSeasonRef(season));
    } catch (error) {
      logWarn('Player State publish after Understat resource failed; repair will retry', {
        season,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

async function persistUnderstatPlayerDiscoverySnapshot(
  runId: string,
  season: string,
  discovery: UnderstatPlayerDiscovery,
  allowPartial = false,
): Promise<boolean> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const references = createUnderstatReferenceRepository(tx);
    const players = createUnderstatPlayerRepository(tx);
    const previousMatches = await references.findMatchesBySeason(season);
    assertUnderstatReferenceSnapshotCurrent(discovery.matches, previousMatches);
    assertNoUnderstatMatchesDisappeared(
      previousMatches.map((match) => match.id),
      discovery.matches,
    );
    const completeness = evaluateUnderstatPlayerDiscoveryCompleteness(
      discovery.playerSeasons.map((player) => player.playerId),
      (await players.getPlayerSeasonHashes(season)).keys(),
      allowPartial,
    );
    if (!completeness.complete) {
      throw new IncompleteUnderstatResourceError('player discovery', completeness.reason);
    }
    const withdrawnMatchIds = withdrawnUnderstatMatchIds(previousMatches, discovery.matches);
    const incomingPlayerIds = new Set(discovery.playerSeasons.map((player) => player.playerId));
    const incomingMatchById = new Map(discovery.matches.map((match) => [match.id, match]));
    const candidateMatchIds = [
      ...new Set([
        ...withdrawnMatchIds,
        ...discovery.matches.filter((match) => !match.isResult).map((match) => match.id),
      ]),
    ];
    const playerIdsByMatch = await players.getMatchPlayerIdsBySeason(season, candidateMatchIds);
    const deletableMatchIds = [...playerIdsByMatch.entries()]
      .filter(([matchId, playerIds]) => {
        const match = incomingMatchById.get(matchId);
        return (
          match != null &&
          !match.isResult &&
          [...playerIds].every((playerId) => incomingPlayerIds.has(playerId))
        );
      })
      .map(([matchId]) => matchId);
    const changed = await persistUnderstatPlayerDiscovery(tx, discovery, deletableMatchIds, {
      preserveExistingPlayerSeasons: allowPartial,
    });
    if (changed) await createUnderstatSyncRepository(tx).markRunDataChanged(runId);
    return changed;
  });
}

async function persistUnderstatPlayerTeamResource(
  runId: string,
  season: string,
  discovery: UnderstatPlayerDiscovery,
  detail: UnderstatPlayerTeamDetailSnapshot,
  observedAt: Date,
  activeIncremental = false,
  rejectSuperseded = false,
): Promise<{ changed: boolean; complete: boolean; reason: string }> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    assertUnderstatReferenceSnapshotCurrent(
      discovery.matches,
      await createUnderstatReferenceRepository(tx).findMatchesBySeason(season),
    );
    const players = createUnderstatPlayerRepository(tx);
    const completeness = evaluateUnderstatPlayerTeamResourceCompleteness(
      detail.teamId,
      discovery,
      detail.rows,
      await players.getTeamParticipantPlayerIds(season, detail.teamId),
    );
    if (!completeness.complete) {
      return { changed: false, complete: false, reason: completeness.reason };
    }
    const identityChanges = await players.upsertPlayers(
      detail.players,
      observedAt,
      rejectSuperseded,
    );
    const participantsChanged = await players.replaceTeamParticipants(
      season,
      detail.teamId,
      detail.rows,
      !activeIncremental,
    );
    const verifyHashes = activeIncremental
      ? assertUnderstatResourceHashesIncluded
      : assertUnderstatResourceHashes;
    verifyHashes(
      `team participants season=${season} team=${detail.teamId}`,
      detail.rows.map((row) => row.sourceHash),
      await players.getTeamParticipantHashes(season, detail.teamId),
    );
    if (identityChanges > 0 || participantsChanged) {
      await createUnderstatSyncRepository(tx).markRunDataChanged(runId);
    }
    return {
      changed: identityChanges > 0 || participantsChanged,
      complete: true,
      reason: completeness.reason,
    };
  });
}

async function persistUnderstatPlayerMatchResource(
  runId: string,
  season: string,
  discovery: UnderstatPlayerDiscovery,
  detail: UnderstatPlayerMatchDetailSnapshot,
  observedAt: Date,
  rejectSuperseded = false,
): Promise<{ changed: boolean; complete: boolean; reason: string }> {
  const match = discovery.matches.find((candidate) => candidate.id === detail.matchId);
  if (!match) {
    return {
      changed: false,
      complete: false,
      reason: `match ${detail.matchId} is missing from league discovery`,
    };
  }
  const completeness = evaluateUnderstatPlayerMatchResourceCompleteness(match, detail.rows);
  if (!completeness.complete) {
    return { changed: false, complete: false, reason: completeness.reason };
  }

  const db = await getDb();
  const changed = await db.transaction(async (tx) => {
    assertUnderstatReferenceSnapshotCurrent(
      discovery.matches,
      await createUnderstatReferenceRepository(tx).findMatchesBySeason(season),
    );
    const players = createUnderstatPlayerRepository(tx);
    const identityChanges = await players.upsertPlayers(
      detail.players,
      observedAt,
      rejectSuperseded,
    );
    const matchChanged = await players.replaceMatchStats(detail.matchId, detail.rows);
    assertUnderstatResourceHashes(
      `match roster match=${detail.matchId}`,
      detail.rows.map((row) => row.sourceHash),
      await players.getMatchStatHashes(detail.matchId),
    );
    if (identityChanges > 0 || matchChanged) {
      await createUnderstatSyncRepository(tx).markRunDataChanged(runId);
    }
    return identityChanges > 0 || matchChanged;
  });
  return { changed, complete: true, reason: completeness.reason };
}

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

async function finalizeWhenReady(
  job: UnderstatPlayerJobData,
  ready: boolean,
): Promise<() => Promise<void>> {
  return async () => {
    if (!ready) return;
    await enqueueUnderstatPlayerFinalize({
      runId: job.runId,
      season: job.season,
      mode: job.mode,
      trigger: job.trigger,
      ...obligationFields(job),
    });
  };
}

async function enqueuePlayerDetailJobs(
  job: UnderstatPlayerJobData,
  targetTeamIds: number[],
  targetMatchIds: number[],
  teams: Map<number, { title: string }>,
): Promise<() => Promise<void>> {
  return async () => {
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
            ...obligationFields(job),
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
            ...obligationFields(job),
            resourceId: matchId,
          });
        },
      })),
    ];
    await enqueueUnderstatFanout('Understat player detail', jobs);
  };
}

export async function discoverUnderstatPlayers(
  job: UnderstatPlayerJobData,
  onClaim?: (attempt: number) => void,
): Promise<void> {
  const handoffs: Array<() => Promise<void>> = [];
  const { league, sourceYear } = assertUnderstatSyncAllowed(job.season);
  const config = getConfig();
  const activeSeason = job.season === config.UNDERSTAT_SEASON;
  const activeIncremental = activeSeason && job.mode === 'incremental';
  const mutation = {
    queueName: 'understat-player-sync',
    jobName: 'understat-player-discover',
    scopes: understatMutationScopes(
      'player',
      'understat-player-discover',
      job.season,
      job.resourceId,
    ),
  };
  const claim = await withMutationScopes(mutation, async () => {
    const priorItems = await understatSyncRepository.findUnsettledItems(job.season, 'player');
    const active = await understatSyncRepository.findActiveRun(job.season, 'player', job.runId);
    if (active) {
      throw new Error(`Understat player run ${active.runId} is already active for ${job.season}`);
    }
    const run = await understatSyncRepository.createRun({
      runId: job.runId,
      lane: 'player',
      season: job.season,
      mode: job.mode,
      trigger: job.trigger,
      ...obligationFields(job),
    });
    if (!['pending', 'running', 'ready_to_publish'].includes(run.status)) return null;
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
      await persistUnderstatPlayerDiscoverySnapshot(
        job.runId,
        job.season,
        discovery,
        activeIncremental,
      );
      const items = await understatSyncRepository.findItems(job.runId);
      handoffs.push(
        await enqueuePlayerDetailJobs(
          job,
          selectUnsettledUnderstatFanoutIds(items, TEAM_RESOURCE_TYPE),
          selectUnsettledUnderstatFanoutIds(items, MATCH_RESOURCE_TYPE),
          teamById(discovery.teams),
        ),
      );
      handoffs.push(
        await finalizeWhenReady(job, await understatSyncRepository.refreshRun(job.runId)),
      );
      return null;
    }
    if (leagueItem?.status === 'skipped') {
      handoffs.push(
        await finalizeWhenReady(job, await understatSyncRepository.refreshRun(job.runId)),
      );
      return null;
    }
    const attempt = await understatSyncRepository.markItemRunning(
      job.runId,
      LEAGUE_RESOURCE_TYPE,
      league,
    );
    if (attempt === null) return null;
    const currentRunItems = await understatSyncRepository.findItems(job.runId);
    const sameRunTeamIds = selectUnsettledUnderstatFanoutIds(currentRunItems, TEAM_RESOURCE_TYPE);
    const sameRunMatchIds = selectUnsettledUnderstatFanoutIds(currentRunItems, MATCH_RESOURCE_TYPE);

    return { priorItems, sameRunTeamIds, attempt, sameRunMatchIds };
  });
  for (const handoff of handoffs) await handoff();
  if (!claim) return;
  onClaim?.(claim.attempt);
  const { date: sourceCheckedAt } = await readDatabaseOrderingTimestamp();
  const response = await understatClient.getLeagueData(league, sourceYear);

  await withMutationScopes(mutation, async () => {
    if (
      !(await understatSyncRepository.isItemAttemptCurrent(
        job.runId,
        LEAGUE_RESOURCE_TYPE,
        league,
        claim.attempt,
      ))
    )
      return;
    const { priorItems, sameRunTeamIds, sameRunMatchIds } = claim;
    const discovery = transformUnderstatPlayerDiscovery(
      job.season,
      sourceYear,
      league,
      response,
      sourceCheckedAt,
    );
    await recoverMissingDiscoveryTeams(discovery, activeIncremental);
    // The 20-team/380-match cardinality guard protects full/reconcile replacement
    // snapshots. Only active incremental passes may contain partial history so
    // each complete resource can settle independently on every matchday pass.
    if (!activeIncremental) {
      assertUnderstatLeagueSnapshotComplete(
        league,
        discovery.teams.length,
        discovery.matches.length,
      );
    }
    discovery.season.state = activeSeason ? 'active' : 'complete';
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
    const discoveryCompleteness = evaluateUnderstatPlayerDiscoveryCompleteness(
      discovery.playerSeasons.map((player) => player.playerId),
      previousPlayerHashes.keys(),
      activeIncremental,
    );
    if (!discoveryCompleteness.complete) {
      throw new IncompleteUnderstatResourceError('player discovery', discoveryCompleteness.reason);
    }
    const changedPlayerIds = changedUnderstatPlayerSeasonIds(
      discovery.playerSeasons,
      previousPlayerHashes,
      !activeIncremental,
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
    const changedPlayerMatchIds = await understatPlayerRepository.getMatchIdsForPlayers(
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

    const selectedTeamIds = selectTeamDetailIds({
      mode: job.mode,
      teams: discovery.teams,
      explicitTeamIds: job.teamIds,
      changedTeamIds: changedTeams,
      existingTeamIds: existingParticipantTeams,
      reconcileAll: false,
    });
    const priorTeamIds = priorItems
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
    const targetTeamIds = mergeUnderstatTeamDetailIds(selectedTeamIds, changedTeams, [
      ...priorTeamIds,
      ...sameRunTeamIds,
    ]);
    const selectedMatchIds = selectPlayerMatchIds({
      mode: job.mode,
      matches: discovery.matches,
      syncedMatchIds,
      explicitMatchIds: job.matchIds,
      requiredMatchIds: changedPlayerMatchIds,
    });
    const priorMatchIds = priorItems
      .filter(
        (item) =>
          item.resourceType === MATCH_RESOURCE_TYPE &&
          (item.status === 'failed' ||
            item.status === 'pending' ||
            item.status === 'running' ||
            item.status === 'skipped'),
      )
      .map((item) => Number(item.resourceId))
      .filter(Number.isInteger)
      .filter((matchId) =>
        discovery.matches.some((match) => match.id === matchId && match.isResult),
      );
    const targetMatchIds = [
      ...new Set([...selectedMatchIds, ...priorMatchIds, ...sameRunMatchIds]),
    ].sort((left, right) => left - right);
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
    await persistUnderstatPlayerDiscoverySnapshot(
      job.runId,
      job.season,
      discovery,
      activeIncremental,
    );
    const staged = stageUnderstatPlayerLeague(job.season, discovery);
    const ready = await understatSyncRepository.completeItem(
      job.runId,
      LEAGUE_RESOURCE_TYPE,
      league,
      understatStagingHash(staged),
      staged,
    );
    handoffs.push(await enqueuePlayerDetailJobs(job, targetTeamIds, targetMatchIds, teams));
    handoffs.push(await finalizeWhenReady(job, ready));
  });
  for (const handoff of handoffs) await handoff();
}

export async function syncUnderstatPlayerTeamDetail(
  job: UnderstatPlayerJobData,
  onClaim?: (attempt: number) => void,
): Promise<void> {
  const handoffs: Array<() => Promise<void>> = [];
  const { sourceYear } = assertUnderstatSyncAllowed(job.season);
  const config = getConfig();
  const activeSeason = job.season === config.UNDERSTAT_SEASON;
  const activeIncremental = activeSeason && job.mode === 'incremental';
  const teamId = requireJobValue(job.resourceId, 'resourceId');
  const teamTitle = requireJobValue(job.teamTitle, 'teamTitle');
  const resourceId = String(teamId);
  const mutation = {
    queueName: 'understat-player-sync',
    jobName: 'understat-player-team-detail',
    scopes: understatMutationScopes(
      'player',
      'understat-player-team-detail',
      job.season,
      job.resourceId,
    ),
  };
  const attempt = await withMutationScopes(mutation, async () => {
    if (await alreadySettled(job.runId, TEAM_RESOURCE_TYPE, resourceId)) {
      await refreshPlayerStateAfterTeamResource(job.season);
      handoffs.push(
        await finalizeWhenReady(job, await understatSyncRepository.refreshRun(job.runId)),
      );
      return null;
    }
    return understatSyncRepository.markItemRunning(job.runId, TEAM_RESOURCE_TYPE, resourceId);
  });
  for (const handoff of handoffs) await handoff();
  if (attempt === null) return;
  onClaim?.(attempt);
  const { date: observedAt } = await readDatabaseOrderingTimestamp();
  const response = await understatClient.getTeamData(teamTitle, sourceYear);
  await withMutationScopes(mutation, async () => {
    if (
      !(await understatSyncRepository.isItemAttemptCurrent(
        job.runId,
        TEAM_RESOURCE_TYPE,
        resourceId,
        attempt,
      ))
    )
      return;

    const leagueItem = await understatSyncRepository.findItem(
      job.runId,
      LEAGUE_RESOURCE_TYPE,
      getConfig().UNDERSTAT_LEAGUE,
    );
    if (!leagueItem) throw new Error(`Understat player run ${job.runId} has no staged league item`);
    const discovery = readStagedUnderstatPlayerLeague(
      leagueItem.normalizedPayload,
      leagueItem.sourceHash,
      job.season,
    );
    const missingCompletedMatchIds = validateUnderstatTeamDates(
      response,
      teamId,
      discovery.matches,
      activeIncremental,
    );
    if (activeIncremental && missingCompletedMatchIds.length > 0) {
      handoffs.push(
        await finalizeWhenReady(
          job,
          await understatSyncRepository.skipItem(
            job.runId,
            TEAM_RESOURCE_TYPE,
            resourceId,
            `team ${teamId} completed matches missing: ${missingCompletedMatchIds.join(',')}`,
          ),
        ),
      );
      return;
    }
    const transformed = transformUnderstatTeamParticipants(job.season, teamId, response);
    const staged = stageUnderstatPlayerTeamDetail(
      job.season,
      teamId,
      transformed.players,
      transformed.playerTeamSeasons,
    );
    const persisted = await persistUnderstatPlayerTeamResource(
      job.runId,
      job.season,
      discovery,
      {
        teamId,
        players: transformed.players,
        rows: transformed.playerTeamSeasons,
      },
      observedAt,
      activeIncremental,
      true,
    );
    if (!persisted.complete) {
      if (!activeIncremental) {
        throw new IncompleteUnderstatResourceError(
          `player team=${teamId} participants`,
          persisted.reason,
        );
      }
      handoffs.push(
        await finalizeWhenReady(
          job,
          await understatSyncRepository.skipItem(
            job.runId,
            TEAM_RESOURCE_TYPE,
            resourceId,
            persisted.reason,
          ),
        ),
      );
      return;
    }
    const ready = await understatSyncRepository.completeItem(
      job.runId,
      TEAM_RESOURCE_TYPE,
      resourceId,
      understatStagingHash(staged),
      staged,
    );
    await refreshPlayerStateAfterTeamResource(job.season);
    handoffs.push(await finalizeWhenReady(job, ready));
  });
  for (const handoff of handoffs) await handoff();
}

export async function syncUnderstatPlayerMatch(
  job: UnderstatPlayerJobData,
  onClaim?: (attempt: number) => void,
): Promise<void> {
  const handoffs: Array<() => Promise<void>> = [];
  assertUnderstatSyncAllowed(job.season);
  const config = getConfig();
  const matchId = requireJobValue(job.resourceId, 'resourceId');
  const resourceId = String(matchId);
  const mutation = {
    queueName: 'understat-player-sync',
    jobName: 'understat-player-match',
    scopes: understatMutationScopes('player', 'understat-player-match', job.season, job.resourceId),
  };
  const attempt = await withMutationScopes(mutation, async () => {
    if (await alreadySettled(job.runId, MATCH_RESOURCE_TYPE, resourceId)) {
      await publishPlayerStateAfterMatchResource(job.season);
      handoffs.push(
        await finalizeWhenReady(job, await understatSyncRepository.refreshRun(job.runId)),
      );
      return null;
    }
    return understatSyncRepository.markItemRunning(job.runId, MATCH_RESOURCE_TYPE, resourceId);
  });
  for (const handoff of handoffs) await handoff();
  if (attempt === null) return;
  onClaim?.(attempt);
  const { date: observedAt } = await readDatabaseOrderingTimestamp();
  const response = await understatClient.getMatchData(matchId);
  await withMutationScopes(mutation, async () => {
    if (
      !(await understatSyncRepository.isItemAttemptCurrent(
        job.runId,
        MATCH_RESOURCE_TYPE,
        resourceId,
        attempt,
      ))
    )
      return;

    const leagueItem = await understatSyncRepository.findItem(
      job.runId,
      LEAGUE_RESOURCE_TYPE,
      getConfig().UNDERSTAT_LEAGUE,
    );
    if (!leagueItem) throw new Error(`Understat player run ${job.runId} has no staged league item`);
    const discovery = readStagedUnderstatPlayerLeague(
      leagueItem.normalizedPayload,
      leagueItem.sourceHash,
      job.season,
    );
    const match = discovery.matches.find((candidate) => candidate.id === matchId);
    if (!match || match.season !== job.season || !match.isResult) {
      throw new Error(`Understat completed match ${matchId} is unavailable for ${job.season}`);
    }
    const activeIncremental = job.season === config.UNDERSTAT_SEASON && job.mode === 'incremental';
    const transformed = transformUnderstatMatchRoster(match, response, activeIncremental);
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
    const persisted = await persistUnderstatPlayerMatchResource(
      job.runId,
      job.season,
      discovery,
      {
        matchId,
        players: transformed.players,
        rows: transformed.stats,
      },
      observedAt,
      true,
    );
    if (!persisted.complete) {
      if (!activeIncremental) {
        throw new IncompleteUnderstatResourceError(
          `player match=${matchId} roster`,
          persisted.reason,
        );
      }
      handoffs.push(
        await finalizeWhenReady(
          job,
          await understatSyncRepository.skipItem(
            job.runId,
            MATCH_RESOURCE_TYPE,
            resourceId,
            persisted.reason,
          ),
        ),
      );
      return;
    }
    const ready = await understatSyncRepository.completeItem(
      job.runId,
      MATCH_RESOURCE_TYPE,
      resourceId,
      understatStagingHash(staged),
      staged,
    );
    await publishPlayerStateAfterMatchResource(job.season);
    handoffs.push(await finalizeWhenReady(job, ready));
  });
  for (const handoff of handoffs) await handoff();
}

export async function finalizeUnderstatPlayerRun(job: UnderstatPlayerJobData): Promise<void> {
  const mutation = {
    queueName: 'understat-player-sync',
    jobName: 'understat-player-finalize',
    scopes: understatMutationScopes(
      'player',
      'understat-player-finalize',
      job.season,
      job.resourceId,
    ),
  };
  await withMutationScopes(mutation, async () => {
    assertUnderstatSyncAllowed(job.season);
    const config = getConfig();
    const activeSeason = job.season === config.UNDERSTAT_SEASON;
    const activeIncremental = activeSeason && job.mode === 'incremental';
    const run = await understatSyncRepository.findRun(job.runId);
    if (!run || run.lane !== 'player') throw new Error(`Unknown Understat player run ${job.runId}`);
    if (run.status === 'completed' || run.status === 'skipped') return;
    if (run.failedItems > 0 || run.status !== 'ready_to_publish') {
      throw new Error(`Understat player run ${job.runId} is not ready to finalize (${run.status})`);
    }
    const items = await understatSyncRepository.findItems(job.runId);
    if (
      items.length !== run.expectedItems ||
      items.some(
        (item) => item.status !== 'completed' && (!activeIncremental || item.status !== 'skipped'),
      )
    ) {
      throw new Error(`Understat player run ${job.runId} has unsettled staging items`);
    }
    const leagueItem = items.find((item) => item.resourceType === LEAGUE_RESOURCE_TYPE);
    if (!leagueItem || leagueItem.status !== 'completed') {
      throw new Error(`Understat player run ${job.runId} has no completed league staging item`);
    }
    const discovery = readStagedUnderstatPlayerLeague(
      leagueItem.normalizedPayload,
      leagueItem.sourceHash,
      job.season,
    );
    // Resource facts and identities commit before the item completion marker under
    // the same reference scope. On replay, preserve identities written after that
    // marker rather than treating the staged payload as a fresh provider response.
    const teamDetails = items
      .filter((item) => item.resourceType === TEAM_RESOURCE_TYPE && item.status === 'completed')
      .map((item) => ({
        ...readStagedUnderstatPlayerTeamDetail(item.normalizedPayload, item.sourceHash, job.season),
        observedAt: requireJobValue(item.completedAt ?? undefined, 'completedAt'),
      }))
      .sort((left, right) => left.teamId - right.teamId);
    const matchDetails = items
      .filter((item) => item.resourceType === MATCH_RESOURCE_TYPE && item.status === 'completed')
      .map((item) => ({
        ...readStagedUnderstatPlayerMatchDetail(
          item.normalizedPayload,
          item.sourceHash,
          job.season,
        ),
        observedAt: requireJobValue(item.completedAt ?? undefined, 'completedAt'),
      }))
      .sort((left, right) => left.matchId - right.matchId);

    const discoveryChanged = await persistUnderstatPlayerDiscoverySnapshot(
      job.runId,
      job.season,
      discovery,
      activeIncremental,
    );

    let changed = discoveryChanged;
    const incompleteTeams: Array<{ teamId: number; reason: string }> = [];
    for (const detail of teamDetails) {
      const result = await persistUnderstatPlayerTeamResource(
        job.runId,
        job.season,
        discovery,
        detail,
        detail.observedAt,
        activeIncremental,
      );
      changed = result.changed || changed;
      if (!result.complete) {
        incompleteTeams.push({ teamId: detail.teamId, reason: result.reason });
      }
    }

    const incompleteMatches: Array<{ matchId: number; reason: string }> = [];
    for (const detail of matchDetails) {
      const result = await persistUnderstatPlayerMatchResource(
        job.runId,
        job.season,
        discovery,
        detail,
        detail.observedAt,
      );
      changed = result.changed || changed;
      if (!result.complete) {
        incompleteMatches.push({ matchId: detail.matchId, reason: result.reason });
      }
    }

    const db = await getDb();
    const players = createUnderstatPlayerRepository(db);
    const snapshot = await players.readSnapshot(job.season);
    await understatSyncRepository.markRunCompleted(
      job.runId,
      {
        finalized: true,
        storage: 'postgresql',
        partial:
          incompleteTeams.length > 0 ||
          incompleteMatches.length > 0 ||
          (activeIncremental && run.skippedItems > 0),
        incompleteTeams,
        incompleteMatches,
        ...(activeIncremental && run.skippedItems > 0 ? { skippedItems: run.skippedItems } : {}),
        counts: {
          players: snapshot.players.length,
          memberships: snapshot.memberships.length,
          playerMatchStats: snapshot.matchStats.length,
        },
      },
      changed,
    );
    registerDatabasePostCommit(async () => {
      try {
        await publishUnderstatPlayerState(explicitSeasonRef(job.season));
      } catch (error) {
        logWarn('Player State publish after Understat finalize failed; repair will retry', {
          season: job.season,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  });
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
