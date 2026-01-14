export interface EventLiveExplain {
  readonly eventId: number;
  readonly elementId: number;
  readonly bonus: number | null;
  readonly minutes: number | null;
  readonly minutesPoints: number | null;
  readonly goalsScored: number | null;
  readonly goalsScoredPoints: number | null;
  readonly assists: number | null;
  readonly assistsPoints: number | null;
  readonly cleanSheets: number | null;
  readonly cleanSheetsPoints: number | null;
  readonly goalsConceded: number | null;
  readonly goalsConcededPoints: number | null;
  readonly ownGoals: number | null;
  readonly ownGoalsPoints: number | null;
  readonly penaltiesSaved: number | null;
  readonly penaltiesSavedPoints: number | null;
  readonly penaltiesMissed: number | null;
  readonly penaltiesMissedPoints: number | null;
  readonly yellowCards: number | null;
  readonly yellowCardsPoints: number | null;
  readonly redCards: number | null;
  readonly redCardsPoints: number | null;
  readonly saves: number | null;
  readonly savesPoints: number | null;
}

export type EventLiveExplains = readonly EventLiveExplain[];
