type MutationScopeInput = {
  queueName: string;
  jobName: string;
  eventId?: number;
  tournamentId?: number;
};

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
      // Per-table scopes: jobs writing different entry tables no longer serialize
      // against each other; jobs writing the SAME table share its scope across the
      // entry/league/tournament domains below.
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
        // Reads all three entry tables to build the stats snapshot — serialize
        // with writers of each so the snapshot is not taken mid-write.
        return [
          withEvent('entry-event-picks', eventId),
          withEvent('entry-event-transfers', eventId),
          withEvent('entry-event-results', eventId),
          withEvent('tournament-event-mutations', eventId),
        ];
      case 'tournament-points-race':
      case 'tournament-battle-race':
      case 'tournament-knockout':
      case 'tournament-cup-results':
        return [withEvent('tournament-structure', eventId)];
      case 'tournament-info':
        return ['tournament-info:all'];
      default:
        return [];
    }
  }

  if (queue === 'tournament-setup') {
    if (jobName === 'tournament-setup') {
      return [withTournament('tournament-structure', tournamentId), 'entry-core:all'];
    }
    return [];
  }

  return [];
}
