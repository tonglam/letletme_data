import type { RawFPLEventLiveElement } from '../types';

// Target shape matches event_live_explains Drizzle schema fields
export interface EventLiveExplainRecord {
  eventId: number;
  elementId: number;
  // points buckets
  bonus: number | null;
  minutes: number | null;
  minutesPoints: number | null;
  goalsScored: number | null;
  goalsScoredPoints: number | null;
  assists: number | null;
  assistsPoints: number | null;
  cleanSheets: number | null;
  cleanSheetsPoints: number | null;
  goalsConceded: number | null;
  goalsConcededPoints: number | null;
  ownGoals: number | null;
  ownGoalsPoints: number | null;
  penaltiesSaved: number | null;
  penaltiesSavedPoints: number | null;
  penaltiesMissed: number | null;
  penaltiesMissedPoints: number | null;
  yellowCards: number | null;
  yellowCardsPoints: number | null;
  redCards: number | null;
  redCardsPoints: number | null;
  saves: number | null;
  savesPoints: number | null;
  mngWinPoints: number | null;
  mngDrawPoints: number | null;
  mngLossPoints: number | null;
  mngUnderdogWinPoints: number | null;
  mngUnderdogDrawPoints: number | null;
  mngCleanSheetsPoints: number | null;
  mngGoalsScoredPoints: number | null;
}

type ExplainItem = { stat: string; points: number; value: number };

function isExplainArray(value: unknown): value is ExplainItem[][] {
  return (
    Array.isArray(value) &&
    value.every(
      (inner) =>
        Array.isArray(inner) &&
        inner.every(
          (item) =>
            item &&
            typeof item === 'object' &&
            'stat' in item &&
            'points' in item &&
            'value' in item,
        ),
    )
  );
}

// Aggregate explains for one element
export function transformSingleEventLiveExplain(
  eventId: number,
  element: RawFPLEventLiveElement,
): EventLiveExplainRecord {
  const acc = new Map<string, { value: number; points: number }>();

  if (isExplainArray(element.explain)) {
    for (const part of element.explain) {
      for (const item of part) {
        const prev = acc.get(item.stat) || { value: 0, points: 0 };
        acc.set(item.stat, {
          value: prev.value + (Number.isFinite(item.value) ? item.value : 0),
          points: prev.points + (Number.isFinite(item.points) ? item.points : 0),
        });
      }
    }
  }

  const get = (stat: string) => acc.get(stat);
  const has = (stat: string): boolean => acc.has(stat);
  const val = (stat: string): number => {
    const e = get(stat);
    return e === undefined ? 0 : e.value;
  };
  const pts = (stat: string): number => {
    const e = get(stat);
    return e === undefined ? 0 : e.points;
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
    mngWinPoints: null,
    mngDrawPoints: null,
    mngLossPoints: null,
    mngUnderdogWinPoints: null,
    mngUnderdogDrawPoints: null,
    mngCleanSheetsPoints: null,
    mngGoalsScoredPoints: null,
  };
}

// Transform all explains
export function transformEventLiveExplains(
  eventId: number,
  elements: RawFPLEventLiveElement[],
): EventLiveExplainRecord[] {
  return elements.map((el) => transformSingleEventLiveExplain(eventId, el));
}
