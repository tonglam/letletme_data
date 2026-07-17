type MutationScopeInput = {
  queueName: string;
  jobName: string;
  eventId?: number;
  tournamentId?: number;
};

/**
 * Shared scope held by BOTH tournament setup rebuilds and every tournament
 * structure-results job (points-race, battle-race, knockout, cup-results).
 * Before FP-07 the two sides used disjoint scopes
 * (`tournament-structure:tournament:N` vs `tournament-structure:event:N`), so a
 * setup rebuild could tear down groups/knockouts while a results sync was
 * writing against them (C4).
 *
 * Documented tradeoff: results jobs across different events now serialize
 * against each other. They are seconds-long on a 10-minute cadence, so the
 * mutual exclusion costs nothing in practice.
 */
const TOURNAMENT_STRUCTURE_GLOBAL_SCOPE = 'tournament-structure:global';

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
      case 'teams':
      case 'players':
      case 'player-stats':
      case 'phases':
      case 'player-values':
        return [`data-core:${jobName}`];
      default:
        return [];
    }
  }

  if (queue === 'entry-sync') {
    switch (jobName) {
      case 'entry-info':
        return ['entry-core:all'];
      case 'entry-picks':
      case 'entry-transfers':
      case 'entry-results':
        return [withEvent('entry-event', eventId)];
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
          withEvent('entry-event', eventId),
          withTournament('league-event-picks', tournamentId),
        ];
      case 'league-event-results':
        return [
          withEvent('entry-event', eventId),
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
        return [withEvent('entry-event', eventId), withEvent('tournament-event-results', eventId)];
      case 'tournament-event-picks':
      case 'tournament-transfers-pre':
      case 'tournament-transfers-post':
      case 'tournament-selection-stats':
        return [
          withEvent('entry-event', eventId),
          withEvent('tournament-event-mutations', eventId),
        ];
      case 'tournament-points-race':
      case 'tournament-battle-race':
      case 'tournament-knockout':
      case 'tournament-cup-results':
        return [withEvent('tournament-structure', eventId), TOURNAMENT_STRUCTURE_GLOBAL_SCOPE];
      // Cascade enqueues this with a soft delay, but under the global structure
      // lock the four structure jobs run one-at-a-time and can exceed that delay.
      // Hold the same global scope so REFRESH cannot observe partial writes.
      case 'tournament-materialized-views-refresh':
        return [TOURNAMENT_STRUCTURE_GLOBAL_SCOPE];
      case 'tournament-info':
        return ['tournament-info:all'];
      default:
        return [];
    }
  }

  if (queue === 'tournament-setup') {
    if (jobName === 'tournament-setup') {
      return [
        withTournament('tournament-structure', tournamentId),
        TOURNAMENT_STRUCTURE_GLOBAL_SCOPE,
        'entry-core:all',
      ];
    }
    return [];
  }

  return [];
}
