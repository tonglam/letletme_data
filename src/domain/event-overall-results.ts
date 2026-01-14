export interface EventChipData {
  readonly chipName: string;
  readonly numberPlayed: number;
}

export interface EventTopElementData {
  readonly element: number;
  readonly points: number;
}

export interface EventOverallResultData {
  readonly event: number;
  readonly averageEntryScore: number | null;
  readonly finished: boolean;
  readonly highestScoringEntry: number | null;
  readonly highestScore: number | null;
  readonly chipPlays: EventChipData[];
  readonly mostSelected: number | null;
  readonly mostTransferredIn: number | null;
  readonly topElementInfo: EventTopElementData | null;
  readonly transfersMade: number | null;
  readonly mostCaptained: number | null;
  readonly mostViceCaptained: number | null;
}

export type EventOverallResultDataList = readonly EventOverallResultData[];
