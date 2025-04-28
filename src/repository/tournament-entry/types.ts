import { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import * as TE from 'fp-ts/TaskEither';
import * as schema from 'schema/tournament-entry';
import { EntryId } from 'types/domain/entry-info.type';
import { TournamentEntry, TournamentEntries } from 'types/domain/tournament-entry.type';
import { TournamentId } from 'types/domain/tournament-info.type';
import { DBError } from 'types/error.type';

export type DbTournamentEntry = InferSelectModel<typeof schema.tournamentEntries>;
export type DbTournamentEntryCreateInput = InferInsertModel<typeof schema.tournamentEntries>;

export type TournamentEntryCreateInput = TournamentEntry;
export type TournamentEntryCreateInputs = readonly TournamentEntryCreateInput[];

export interface TournamentEntryRepository {
  readonly findByTournamentId: (
    tournamentId: TournamentId,
  ) => TE.TaskEither<DBError, TournamentEntries>;
  readonly findAllTournamentEntryIds: () => TE.TaskEither<DBError, ReadonlyArray<EntryId>>;
  readonly saveBatchByTournamentId: (
    tournamentEntryInputs: TournamentEntryCreateInputs,
  ) => TE.TaskEither<DBError, TournamentEntries>;
}
