export type Event = {
  readonly id: EventId;
  readonly name: string;
  readonly deadlineTime: string;
  readonly finished: boolean;
  readonly isPrevious: boolean;
  readonly isCurrent: boolean;
  readonly isNext: boolean;
  readonly averageEntryScore: number;
  readonly dataChecked: boolean;
  readonly highestScore: number | null;
  readonly highestScoringEntry: number | null;
  readonly cupLeaguesCreated: boolean;
  readonly h2hKoMatchesCreated: boolean;
  readonly transfersMade: number;
  readonly rankedCount: number;
  readonly chipPlays: readonly ChipPlay[];
  readonly mostSelected: number | null;
  readonly mostTransferredIn: number | null;
  readonly mostCaptained: number | null;
  readonly mostViceCaptained: number | null;
  readonly topElement: number | null;
  readonly topElementInfo: TopElementInfo | null;
};

export type Events = readonly Event[];
