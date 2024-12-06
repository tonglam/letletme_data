export interface ChipPlay {
  chip_name: string;
  num_played: number;
}

export interface TopElementInfo {
  id: number;
  points: number;
}

export interface EventResponse {
  id: number;
  name: string;
  deadline_time: string;
  average_entry_score: number;
  finished: boolean;
  data_checked: boolean;
  highest_score: number | null;
  deadline_time_epoch: number;
  deadline_time_game_offset: number;
  highest_scoring_entry: number | null;
  is_previous: boolean;
  is_current: boolean;
  is_next: boolean;
  chip_plays: ChipPlay[];
  most_selected: number | null;
  most_transferred_in: number | null;
  top_element: number | null;
  top_element_info: TopElementInfo | null;
  transfers_made: number;
  most_captained: number | null;
  most_vice_captained: number | null;
  cup_leagues_created: boolean;
  h2h_ko_matches_created: boolean;
  ranked_count: number;
}

export interface Event {
  id: number;
  name: string;
  deadlineTime: Date;
  deadlineTimeEpoch: number | null;
  deadlineTimeGameOffset: number | null;
  releaseTime: Date | null;
  averageEntryScore: number | null;
  finished: boolean;
  dataChecked: boolean;
  highestScore: number | null;
  highestScoringEntry: number | null;
  isPrevious: boolean | null;
  isCurrent: boolean | null;
  isNext: boolean | null;
  cupLeaguesCreated: boolean | null;
  h2hKoMatchesCreated: boolean | null;
  rankedCount: number | null;
  chipPlays: ChipPlay[];
  mostSelected: number | null;
  mostTransferredIn: number | null;
  mostCaptained: number | null;
  mostViceCaptained: number | null;
  topElement: number | null;
  topElementInfo: TopElementInfo | null;
  transfersMade: number | null;
  createdAt: Date;
}
