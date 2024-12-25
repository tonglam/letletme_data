import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import type { TeamResponse } from '../../types/teams.type';
import { createError } from '../phases/operations';

export interface BootstrapData {
  teams: TeamResponse[];
  phases: Array<{
    id: number;
    name: string;
    start_event: number;
    stop_event: number;
  }>;
  events: Array<{
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
    cup_leagues_created: boolean;
    h2h_ko_matches_created: boolean;
    ranked_count: number;
    chip_plays: Array<{
      chip_name: string;
      num_played: number;
    }>;
    most_selected: number | null;
    most_transferred_in: number | null;
    most_captained: number | null;
    most_vice_captained: number | null;
    top_element: number | null;
    top_element_info: {
      id: number;
      points: number;
    } | null;
    transfers_made: number;
    release_time: string | null;
  }>;
}

export interface BootstrapApi {
  getBootstrapData: () => Promise<BootstrapData | null>;
}

export const fetchBootstrapData = (api: BootstrapApi) =>
  pipe(
    TE.tryCatch(
      () => api.getBootstrapData(),
      (error) => createError('Failed to fetch bootstrap data', error),
    ),
    TE.map((data) => data?.phases ?? []),
  );

export const fetchBootstrapTeams = (api: BootstrapApi) =>
  pipe(
    TE.tryCatch(
      () => api.getBootstrapData(),
      (error) => createError('Failed to fetch bootstrap data', error),
    ),
    TE.map((data) => data?.teams ?? []),
  );

export const fetchBootstrapEvents = (api: BootstrapApi) =>
  pipe(
    TE.tryCatch(
      () => api.getBootstrapData(),
      (error) => createError('Failed to fetch bootstrap data', error),
    ),
    TE.map((data) => data?.events ?? []),
  );
