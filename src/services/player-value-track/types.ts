import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';
import { PlayerValueTrackCreateInputs } from 'src/repositories/player-value-track/type';
import { PlayerValueTracks } from 'src/types/domain/player-value-track.type';
import { ServiceError } from 'src/types/error.type';

export interface PlayerValueTrackServiceOperations {
  readonly getPlayerValueTracksByDate: (
    date: string,
  ) => TE.TaskEither<ServiceError, PlayerValueTracks>;
  readonly savePlayerValueTracksByDate: (
    playerValueTracks: PlayerValueTrackCreateInputs,
  ) => TE.TaskEither<ServiceError, PlayerValueTracks>;
  readonly deletePlayerValueTracksByDate: (date: string) => TE.TaskEither<ServiceError, void>;
  readonly syncPlayerValueTracksFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PlayerValueTrackService {
  readonly getPlayerValueTracksByDate: (
    date: string,
  ) => TE.TaskEither<ServiceError, PlayerValueTracks>;
  readonly savePlayerValueTracksByDate: (
    playerValueTracks: PlayerValueTrackCreateInputs,
  ) => TE.TaskEither<ServiceError, PlayerValueTracks>;
  readonly deletePlayerValueTracksByDate: (date: string) => TE.TaskEither<ServiceError, void>;
  readonly syncPlayerValueTracksFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PlayerValueTrackWorkflowsOperations {
  readonly syncPlayerValueTracks: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
