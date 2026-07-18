type MutationScopeInput = {
  queueName: string;
  jobName: string;
  eventId?: number;
  tournamentId?: number;
};

/**
 * Shared scope held by tournament structure rebuilds and structure-results
 * jobs (points-race, battle-race, knockout). Before FP-07 setup used
 * `tournament-structure:tournament:N` while results used
 * `tournament-structure:event:N` — disjoint keys, so a rebuild could tear down
 * groups/knockouts while a results sync was writing (C4).
 *
 * Documented tradeoff: structure results jobs across different events serialize
 * against each other. They are seconds-long on a 10-minute cadence.
 *
 * Setup acquires this only around structure-writing phases (rebuild + per-event
 * history backfill), not during entry-info FPL sync (FP-07 Codex P1).
 */
export const TOURNAMENT_STRUCTURE_GLOBAL_SCOPE = 'tournament-structure:global';

/** Locks for the one-shot structure rebuild during tournament setup. */
export function tournamentSetupRebuildScopes(tournamentId: number): string[] {
  return [
    Number.isFinite(tournamentId)
      ? `tournament-structure:tournament:${tournamentId}`
      : 'tournament-structure:all',
    TOURNAMENT_STRUCTURE_GLOBAL_SCOPE,
  ];
}

/** Locks for one event of setup history backfill (points/knockout writes). */
export function tournamentSetupBackfillEventScopes(eventId: number): string[] {
  return [
    Number.isFinite(eventId) ? `tournament-structure:event:${eventId}` : 'tournament-structure:all',
    TOURNAMENT_STRUCTURE_GLOBAL_SCOPE,
  ];
}

/**
 * Lightweight per-tournament setup lifecycle lock. Serializes concurrent setup
 * jobs for the same tournament (force-requeue / concurrency>1) without holding
 * tournament-structure:global during entry FPL or other slow phases.
 */
export function tournamentSetupLifecycleScope(tournamentId: number): string {
  return Number.isFinite(tournamentId)
    ? `tournament-setup:tournament:${tournamentId}`
    : 'tournament-setup:all';
}

function baseQueueName(queueName: string): string {
  return queueName.replace(/-p[0-3]$/, '');
}

function withEvent(scope: string, eventId?: number): string {
  return Number.isFinite(eventId) ? `${scope}:event:${eventId}` : `${scope}:all`;
}

function withTournament(scope: string, tournamentId?: number): string {
  return Number.isFinite(tournamentId) ? `${scope}:tournament:${tournamentId}` : `${scope}:all`;
}

export function resolveMutationScopes(input: MutationScopeInput): string[] {
  const queue = baseQueueName(input.queueName);
  const { jobName, eventId, tournamentId } = input;

  if (queue === 'data-sync') {
    switch (jobName) {
      case 'events':
      case 'fixtures':
      case 'fixtures-all-gameweeks':
      case 'teams':
      case 'players':
      case 'player-stats':
      case 'phases':
      case 'player-values':
        // All-gameweek backfill shares the fixtures core lock with single-event syncs.
        return [`data-core:${jobName === 'fixtures-all-gameweeks' ? 'fixtures' : jobName}`];
      default:
        return [];
    }
  }

  if (queue === 'entry-sync') {
    switch (jobName) {
      case 'entry-info':
        return ['entry-core:all'];
      case 'entry-picks':
        return [withEvent('entry-event-picks', eventId)];
      case 'entry-transfers':
        return [withEvent('entry-event-transfers', eventId)];
      case 'entry-results':
        return [withEvent('entry-event-results', eventId)];
      default:
        return [];
    }
  }

  if (queue === 'live-data') {
    switch (jobName) {
      case 'event-lives-cache':
      case 'event-lives-db':
        return [withEvent('event-live', eventId)];
      case 'event-live-explain':
        return [withEvent('event-live', eventId), withEvent('event-live-explain', eventId)];
      case 'live-fixture-cache':
        return [withEvent('event-live', eventId), withEvent('live-fixture', eventId)];
      case 'live-bonus-cache':
        return [withEvent('event-live', eventId), withEvent('live-bonus', eventId)];
      case 'live-scores':
        return [withEvent('live-scores', eventId)];
      case 'event-live-summary':
        return ['event-live-summary:season'];
      case 'event-overall-result':
        return ['event-overall-result:season'];
      default:
        return [];
    }
  }

  if (queue === 'league-sync') {
    switch (jobName) {
      case 'league-event-picks':
        return [
          withEvent('entry-event-picks', eventId),
          withTournament('league-event-picks', tournamentId),
        ];
      case 'league-event-results':
        return [
          withEvent('entry-event-results', eventId),
          withEvent('league-event-results', eventId),
          withTournament('league-event-results', tournamentId),
        ];
      default:
        return [];
    }
  }

  if (queue === 'tournament-sync') {
    switch (jobName) {
      case 'tournament-event-results':
        return [
          withEvent('entry-event-picks', eventId),
          withEvent('entry-event-transfers', eventId),
          withEvent('entry-event-results', eventId),
          withEvent('tournament-event-results', eventId),
        ];
      case 'tournament-event-picks':
        return [
          withEvent('entry-event-picks', eventId),
          withEvent('tournament-event-mutations', eventId),
        ];
      case 'tournament-transfers-pre':
      case 'tournament-transfers-post':
        return [
          withEvent('entry-event-transfers', eventId),
          withEvent('tournament-event-mutations', eventId),
        ];
      case 'tournament-selection-stats':
        // Reads entry_event_picks/transfers but only writes tournament_selection_stats;
        // tournament-event-mutations covers its write target.
        return [withEvent('tournament-event-mutations', eventId)];
      // Structure-table writers (groups / battle / knockout). Share global with
      // setup rebuilds so C4 cannot tear down structure mid-write.
      case 'tournament-points-race':
      case 'tournament-battle-race':
      case 'tournament-knockout':
        return [withEvent('tournament-structure', eventId), TOURNAMENT_STRUCTURE_GLOBAL_SCOPE];
      // Cup only upserts entry_event_cup_results (FPL HTTP heavy). It does not
      // mutate group/knockout structure tables, so it must NOT hold the global
      // structure lock (would block setup/points/battle/knockout on FPL latency).
      case 'tournament-cup-results':
        return [withEvent('tournament-cup-results', eventId)];
      // Cascade enqueues refresh only after points/battle/knockout complete
      // (barrier). Still take the global scope so a concurrent setup rebuild
      // cannot race the REFRESH itself.
      case 'tournament-materialized-views-refresh':
        return [TOURNAMENT_STRUCTURE_GLOBAL_SCOPE];
      case 'tournament-info':
        return ['tournament-info:all'];
      default:
        return [];
    }
  }

  if (queue === 'tournament-setup') {
    // Default scopes empty: multi-phase setup must not hold global for entry
    // FPL sync. Structure phases use tournamentSetupRebuildScopes /
    // tournamentSetupBackfillEventScopes via explicit guard scopes.
    return [];
  }

  return [];
}
