import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'service/types';
import { PlayerValueTracks } from 'types/domain/player-value-track.type';
import { ServiceError } from 'types/error.type';

export interface PlayerValueTrackServiceOperations {
  readonly findPlayerValueTracksByDate: (
    date: string,
  ) => TE.TaskEither<ServiceError, PlayerValueTracks>;
  readonly syncPlayerValueTracksFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PlayerValueTrackService {
  readonly getPlayerValueTracksByDate: (
    date: string,
  ) => TE.TaskEither<ServiceError, PlayerValueTracks>;
  readonly syncPlayerValueTracksFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PlayerValueTrackWorkflowsOperations {
  readonly syncPlayerValueTracks: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
