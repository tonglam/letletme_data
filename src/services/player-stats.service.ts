import { fplClient } from '../clients/fpl';
import type { FplSeasonRef } from '../domain/fpl-season';
import { playerStatsRepository, type PlayerStatsRepository } from '../repositories/player-stats';
import {
  createTeamsMap,
  transformCurrentGameweekPlayerStats,
  transformPlayerStatsStrict,
} from '../transformers/player-stats';
import type { RawFPLElement } from '../types';
import type { EventId } from '../types/base.type';
import { logInfo } from '../utils/logger';
import { loadTeamsBasicInfo } from '../utils/teams';
import { resolvePlayerSyncEvent } from './player-sync-event.service';

export type PlayerStatsSyncDependencies = {
  getBootstrap: () => ReturnType<typeof fplClient.getBootstrap>;
  getEventLive: (eventId: EventId) => ReturnType<typeof fplClient.getEventLive>;
  resolvePlayerSyncEvent: typeof resolvePlayerSyncEvent;
  repository: PlayerStatsRepository;
};

export type PlayerStatsSyncDependencyOverrides = Partial<PlayerStatsSyncDependencies>;

const defaultDependencies: PlayerStatsSyncDependencies = {
  getBootstrap: () => fplClient.getBootstrap(),
  getEventLive: (eventId) => fplClient.getEventLive(eventId),
  resolvePlayerSyncEvent,
  repository: playerStatsRepository,
};

const GW1_BASELINE_FIELDS = [
  'total_points',
  'minutes',
  'goals_scored',
  'assists',
  'clean_sheets',
  'goals_conceded',
  'own_goals',
  'penalties_saved',
  'penalties_missed',
  'yellow_cards',
  'red_cards',
  'saves',
  'bonus',
  'bps',
  'starts',
  'expected_goals',
  'expected_assists',
  'expected_goal_involvements',
  'expected_goals_conceded',
] as const;

const LIVE_BASELINE_COMPARISON: ReadonlyArray<
  readonly [
    keyof RawFPLElement,
    keyof NonNullable<
      Awaited<ReturnType<typeof fplClient.getEventLive>>
    >['elements'][number]['stats'],
  ]
> = [
  ['total_points', 'total_points'],
  ['minutes', 'minutes'],
  ['goals_scored', 'goals_scored'],
  ['assists', 'assists'],
  ['clean_sheets', 'clean_sheets'],
  ['goals_conceded', 'goals_conceded'],
  ['own_goals', 'own_goals'],
  ['penalties_saved', 'penalties_saved'],
  ['penalties_missed', 'penalties_missed'],
  ['yellow_cards', 'yellow_cards'],
  ['red_cards', 'red_cards'],
  ['saves', 'saves'],
  ['bonus', 'bonus'],
  ['bps', 'bps'],
  ['starts', 'starts'],
  ['expected_goals', 'expected_goals'],
  ['expected_assists', 'expected_assists'],
  ['expected_goal_involvements', 'expected_goal_involvements'],
  ['expected_goals_conceded', 'expected_goals_conceded'],
];

function numericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function isZeroGw1Baseline(elements: RawFPLElement[]): boolean {
  return elements.every((element) =>
    GW1_BASELINE_FIELDS.every((field) => {
      const value = numericValue(element[field]);
      return value !== null && value === 0;
    }),
  );
}

async function validateGw1AgainstLive(
  elements: RawFPLElement[],
  getEventLive: PlayerStatsSyncDependencies['getEventLive'],
): Promise<void> {
  const live = await getEventLive(1);
  const liveById = new Map(live.elements.map((element) => [element.id, element]));
  if (live.elements.length !== elements.length) {
    throw new Error(
      `GW1 baseline live row count ${live.elements.length} does not match bootstrap ${elements.length}`,
    );
  }

  for (const element of elements) {
    const liveElement = liveById.get(element.id);
    if (!liveElement) {
      throw new Error(`GW1 baseline live row missing for player ${element.id}`);
    }
    for (const [bootstrapField, liveField] of LIVE_BASELINE_COMPARISON) {
      const bootstrapValue = numericValue(element[bootstrapField]);
      const liveValue = numericValue(liveElement.stats[liveField]);
      if (bootstrapValue === null || liveValue === null || bootstrapValue !== liveValue) {
        throw new Error(
          `GW1 baseline mismatch for player ${element.id}: ${bootstrapField}=${String(element[bootstrapField])}, live=${String(liveElement.stats[liveField])}`,
        );
      }
    }
  }
}

async function assertCompletePlayerSet(
  season: FplSeasonRef,
  elements: RawFPLElement[],
  transformedPlayerStats: ReturnType<typeof transformCurrentGameweekPlayerStats>,
  repository: PlayerStatsRepository,
): Promise<void> {
  const sourceIds = elements.map((element) => element.id);
  const transformedIds = transformedPlayerStats.map((playerStat) => playerStat.elementId);
  const sourceSet = new Set(sourceIds);
  const transformedSet = new Set(transformedIds);
  if (
    sourceSet.size !== sourceIds.length ||
    transformedSet.size !== transformedIds.length ||
    sourceSet.size !== transformedSet.size ||
    sourceIds.some((elementId) => !transformedSet.has(elementId))
  ) {
    throw new Error('Player stats source and transformed player sets are incomplete or duplicated');
  }

  const coreIds = await repository.findCorePlayerIds(season);
  const coreSet = new Set(coreIds);
  if (
    coreSet.size === 0 ||
    coreSet.size !== sourceSet.size ||
    sourceIds.some((elementId) => !coreSet.has(elementId))
  ) {
    throw new Error(
      `Player stats source does not match the canonical core player set: source=${sourceSet.size}, core=${coreSet.size}`,
    );
  }
}

async function resolveGw1Baseline(
  season: FplSeasonRef,
  eventId: EventId,
  phase: 'preseason' | 'current',
  elements: RawFPLElement[],
  sourceCheckedAt: Date,
  dependencies: PlayerStatsSyncDependencies,
): Promise<Date | null> {
  if (eventId !== 1) return null;

  const publication = await dependencies.repository.findPublication(season, eventId);
  if (phase === 'preseason' && !isZeroGw1Baseline(elements)) {
    throw new Error('GW1 player stats baseline is not reset; publication is blocked');
  }

  if (publication?.baselineVerifiedAt) {
    return publication.baselineVerifiedAt;
  }

  if (isZeroGw1Baseline(elements)) {
    return sourceCheckedAt;
  }

  if (phase !== 'current') {
    throw new Error('GW1 player stats baseline is not verified');
  }

  await validateGw1AgainstLive(elements, dependencies.getEventLive);
  return sourceCheckedAt;
}

export async function syncCurrentPlayerStats(
  season: FplSeasonRef,
  options?: {
    onTargetEventResolved?: (eventId: EventId) => void;
  },
  dependencies: PlayerStatsSyncDependencyOverrides = {},
): Promise<{
  count: number;
  eventId: EventId;
  errors: number;
}> {
  logInfo('Starting player stats sync for current gameweek');
  const runtimeDependencies: PlayerStatsSyncDependencies = {
    ...defaultDependencies,
    ...dependencies,
  };

  // Resolve and publish the target before the fallible upstream request. This
  // keeps failed unscoped attempts traceable to the affected gameweek.
  const syncEvent = await runtimeDependencies.resolvePlayerSyncEvent(season);
  if (!syncEvent) {
    throw new Error('No current or next event found for player stats');
  }
  options?.onTargetEventResolved?.(syncEvent.event.id);

  const sourceCheckedAt = new Date();
  const fplData = await runtimeDependencies.getBootstrap();

  if (!Array.isArray(fplData.elements)) {
    throw new Error('Invalid player elements data from FPL API');
  }

  if (fplData.elements.length === 0) {
    throw new Error('No player stats returned from FPL API');
  }

  logInfo('Raw player stats data fetched', {
    playersCount: fplData.elements.length,
    eventId: syncEvent.event.id,
  });

  const transformedPlayerStats = transformCurrentGameweekPlayerStats(fplData, syncEvent.event.id);
  const errors = fplData.elements.length - transformedPlayerStats.length;

  logInfo('Player stats transformed', {
    total: fplData.elements.length,
    successful: transformedPlayerStats.length,
    errors,
    eventId: syncEvent.event.id,
  });

  await assertCompletePlayerSet(
    season,
    fplData.elements,
    transformedPlayerStats,
    runtimeDependencies.repository,
  );
  const baselineVerifiedAt = await resolveGw1Baseline(
    season,
    syncEvent.event.id,
    syncEvent.phase,
    fplData.elements,
    sourceCheckedAt,
    runtimeDependencies,
  );
  const persisted = await runtimeDependencies.repository.replaceBatch(
    season,
    transformedPlayerStats,
    {
      sourceCheckedAt,
      baselineVerifiedAt,
    },
  );
  logInfo('Player event snapshot committed', {
    expectedCount: fplData.elements.length,
    playerStatsCount: persisted.count,
  });

  const result = {
    count: persisted.count,
    eventId: syncEvent.event.id,
    errors,
  };

  logInfo('Player stats sync completed', result);
  return result;
}

export async function syncPlayerStatsForEvent(
  season: FplSeasonRef,
  eventId: EventId,
): Promise<{ count: number; errors: number }> {
  logInfo('Starting player stats sync for specific event', { eventId });

  const sourceCheckedAt = new Date();
  const fplData = await fplClient.getBootstrap();

  if (!Array.isArray(fplData.elements)) {
    throw new Error('Invalid player elements data from FPL API');
  }

  if (fplData.elements.length === 0) {
    throw new Error('No player stats returned from FPL API');
  }

  const teams = await loadTeamsBasicInfo(season);
  const teamsMap = createTeamsMap(teams);

  const transformedPlayerStats = transformPlayerStatsStrict(fplData.elements, eventId, teamsMap);
  const errors = fplData.elements.length - transformedPlayerStats.length;

  logInfo('Player stats transformed for event', {
    total: fplData.elements.length,
    successful: transformedPlayerStats.length,
    errors,
    eventId,
  });

  await assertCompletePlayerSet(
    season,
    fplData.elements,
    transformedPlayerStats,
    playerStatsRepository,
  );
  const baselineVerifiedAt = await resolveGw1Baseline(
    season,
    eventId,
    'current',
    fplData.elements,
    sourceCheckedAt,
    defaultDependencies,
  );
  const replaceResult = await playerStatsRepository.replaceBatch(season, transformedPlayerStats, {
    sourceCheckedAt,
    baselineVerifiedAt,
  });
  logInfo('Player stats snapshot published to database for event', {
    count: replaceResult.count,
    eventId,
    revision: replaceResult.revision,
  });

  const result = {
    count: replaceResult.count,
    errors,
  };

  logInfo('Player stats sync for event completed', { ...result, eventId });
  return result;
}
