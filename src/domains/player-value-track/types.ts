import * as TE from 'fp-ts/TaskEither';
import { PlayerValueTrackCreateInputs } from 'src/repositories/player-value-track/types';
import { PlayerValueTracks } from 'src/types/domain/player-value-track.type';
import { DomainError } from 'src/types/error.type';

export interface PlayerValueTrackOperations {
  readonly getPlayerValueTracksByDate: (
    date: string,
  ) => TE.TaskEither<DomainError, PlayerValueTracks>;
  readonly savePlayerValueTracksByDate: (
    playerValueTrackInputs: PlayerValueTrackCreateInputs,
  ) => TE.TaskEither<DomainError, PlayerValueTracks>;
}
