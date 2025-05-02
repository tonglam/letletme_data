import * as TE from 'fp-ts/TaskEither';
import { LeagueType } from 'types/base.type';
import { EntryId } from 'types/domain/entry-info.type';
import { LeagueId } from 'types/domain/league.type';
import { TournamentEntries } from 'types/domain/tournament-entry.type';
import { TournamentId } from 'types/domain/tournament-info.type';
import { ServiceError } from 'types/error.type';

export interface TournamentEntryServiceOperations {
  readonly findByTournamentId: (id: TournamentId) => TE.TaskEither<ServiceError, TournamentEntries>;
  readonly findAllTournamentEntryIds: () => TE.TaskEither<ServiceError, ReadonlyArray<EntryId>>;
  readonly createTournamentEntriesFromApi: (
    id: TournamentId,
    leagueId: LeagueId,
    leagueType: LeagueType,
  ) => TE.TaskEither<ServiceError, void>;
}

export interface TournamentEntryService {
  readonly getEntriesByTournamentId: (
    id: TournamentId,
  ) => TE.TaskEither<ServiceError, TournamentEntries>;
  readonly getAllTournamentEntryIds: () => TE.TaskEither<ServiceError, ReadonlyArray<EntryId>>;
  readonly createTournamentEntriesFromApi: (
    id: TournamentId,
    leagueId: LeagueId,
    leagueType: LeagueType,
  ) => TE.TaskEither<ServiceError, void>;
}
