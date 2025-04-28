import { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import * as TE from 'fp-ts/TaskEither';
import * as schema from 'schema/tournament-knockout';
import { DBError } from 'src/types/error.type';

import { TournamentId } from '../../types/domain/tournament-info.type';
import {
  TournamentKnockout,
  TournamentKnockouts,
} from '../../types/domain/tournament-knockout.type';

export type DbTournamentKnockout = InferSelectModel<typeof schema.tournamentKnockouts>;
export type DbTournamentKnockoutCreateInput = InferInsertModel<typeof schema.tournamentKnockouts>;

export type TournamentKnockoutCreateInput = TournamentKnockout;
export type TournamentKnockoutCreateInputs = readonly TournamentKnockoutCreateInput[];

export interface TournamentKnockoutRepository {
  readonly findByTournamentId: (
    tournamentId: TournamentId,
  ) => TE.TaskEither<DBError, TournamentKnockouts>;
  readonly saveBatchByTournamentId: (
    tournamentKnockouts: TournamentKnockoutCreateInputs,
  ) => TE.TaskEither<DBError, TournamentKnockouts>;
}
