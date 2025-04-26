import * as TE from 'fp-ts/TaskEither';
import { LeagueId } from 'src/types/domain/league.type';
import { TournamentEntries } from 'src/types/domain/tournament-entry.type';
import { TournamentId } from 'src/types/domain/tournament-info.type';

import type { ServiceError } from '../../types/error.type';

export interface TournamentEntryServiceOperations {
  readonly findByTournamentId: (id: TournamentId) => TE.TaskEither<ServiceError, TournamentEntries>;
  readonly createTournamentEntriesFromApi: (id: LeagueId) => TE.TaskEither<ServiceError, void>;
}

export interface TournamentEntryService {
  readonly getEntriesByTournamentId: (
    id: TournamentId,
  ) => TE.TaskEither<ServiceError, TournamentEntries>;
  readonly createTournamentEntriesFromApi: (id: LeagueId) => TE.TaskEither<ServiceError, void>;
}
