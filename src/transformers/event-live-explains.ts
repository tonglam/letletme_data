import type { EventLiveExplain } from '../domain/event-live-explains';
import type {
  RawFPLEventExplainFixture,
  RawFPLEventExplainStat,
  RawFPLEventLiveElement,
} from '../types';

type StatAccumulator = Map<string, { value: number; points: number }>;

const toFiniteNumber = (input: unknown): number => {
  if (typeof input === 'number') {
    return Number.isFinite(input) ? input : 0;
  }

  if (typeof input === 'string') {
    const parsed = Number.parseFloat(input);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
};

const isExplainFixture = (value: unknown): value is RawFPLEventExplainFixture => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fixture' in value &&
    'stats' in value &&
    Array.isArray((value as RawFPLEventExplainFixture).stats)
  );
};

const isExplainStat = (value: unknown): value is RawFPLEventExplainStat => {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RawFPLEventExplainStat).identifier === 'string'
  );
};

const buildStatAccumulator = (explain: RawFPLEventLiveElement['explain']): StatAccumulator => {
  const accumulator: StatAccumulator = new Map();

  if (!Array.isArray(explain)) {
    return accumulator;
  }

  for (const fixture of explain) {
    if (!isExplainFixture(fixture)) {
      continue;
    }

    for (const stat of fixture.stats) {
      if (!isExplainStat(stat)) {
        continue;
      }

      const identifier = stat.identifier.trim();
      if (identifier.length === 0) {
        continue;
      }

      const value = toFiniteNumber(stat.value);
      const points = toFiniteNumber(stat.points);
      const pointsModification = toFiniteNumber(stat.points_modification);

      const prev = accumulator.get(identifier) ?? { value: 0, points: 0 };
      accumulator.set(identifier, {
        value: prev.value + value,
        points: prev.points + points + pointsModification,
      });
    }
  }

  return accumulator;
};

export function transformSingleEventLiveExplain(
  eventId: number,
  element: RawFPLEventLiveElement,
): EventLiveExplain {
  const accumulator = buildStatAccumulator(element.explain);

  const get = (stat: string) => accumulator.get(stat);
  const has = (stat: string): boolean => accumulator.has(stat);
  const val = (stat: string): number => {
    const entry = get(stat);
    return entry === undefined ? 0 : entry.value;
  };
  const pts = (stat: string): number => {
    const entry = get(stat);
    return entry === undefined ? 0 : entry.points;
  };

  return {
    eventId,
    elementId: element.id,
    bonus: element.stats?.bonus ?? (has('bonus') ? pts('bonus') : 0),
    minutes: element.stats?.minutes ?? null,
    minutesPoints: has('minutes') ? pts('minutes') : null,
    goalsScored: val('goals_scored'),
    goalsScoredPoints: pts('goals_scored'),
    assists: val('assists'),
    assistsPoints: pts('assists'),
    cleanSheets: val('clean_sheets'),
    cleanSheetsPoints: pts('clean_sheets'),
    goalsConceded: val('goals_conceded'),
    goalsConcededPoints: pts('goals_conceded'),
    ownGoals: val('own_goals'),
    ownGoalsPoints: pts('own_goals'),
    penaltiesSaved: val('penalties_saved'),
    penaltiesSavedPoints: pts('penalties_saved'),
    penaltiesMissed: val('penalties_missed'),
    penaltiesMissedPoints: pts('penalties_missed'),
    yellowCards: val('yellow_cards'),
    yellowCardsPoints: pts('yellow_cards'),
    redCards: val('red_cards'),
    redCardsPoints: pts('red_cards'),
    saves: val('saves'),
    savesPoints: pts('saves'),
  };
}

export function transformEventLiveExplains(
  eventId: number,
  elements: RawFPLEventLiveElement[],
): EventLiveExplain[] {
  return elements.map((el) => transformSingleEventLiveExplain(eventId, el));
}
