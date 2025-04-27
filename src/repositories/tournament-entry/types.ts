import { Prisma, TournamentEntry as PrismaTournamentEntryType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { EntryId } from 'src/types/domain/entry-info.type';
import { TournamentId } from 'src/types/domain/tournament-info.type';
import { DBError } from 'src/types/error.type';

import { TournamentEntry, TournamentEntries } from '../../types/domain/tournament-entry.type';

export type PrismaTournamentEntryCreateInput = Prisma.TournamentEntryCreateInput;
export type PrismaTournamentEntry = PrismaTournamentEntryType;

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
