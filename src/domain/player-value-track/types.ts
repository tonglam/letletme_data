import * as TE from 'fp-ts/TaskEither';
import { PlayerValueTrackCreateInputs } from 'repository/player-value-track/types';
import { PlayerValueTracks } from 'types/domain/player-value-track.type';
import { DomainError } from 'types/error.type';

export interface PlayerValueTrackOperations {
  readonly getPlayerValueTracksByDate: (
    date: string,
  ) => TE.TaskEither<DomainError, PlayerValueTracks>;
  readonly savePlayerValueTracksByDate: (
    playerValueTrackInputs: PlayerValueTrackCreateInputs,
  ) => TE.TaskEither<DomainError, PlayerValueTracks>;
}
