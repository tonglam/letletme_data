import { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import * as TE from 'fp-ts/TaskEither';
import * as schema from 'schema/tournament-knockout-result';
import { TournamentId } from 'types/domain/tournament-info.type';
import {
  TournamentKnockoutResult,
  TournamentKnockoutResults,
} from 'types/domain/tournament-knockout-result.type';
import { DBError } from 'types/error.type';

export type DbTournamentKnockoutResult = InferSelectModel<typeof schema.tournamentKnockoutResults>;
export type DbTournamentKnockoutResultCreateInput = InferInsertModel<
  typeof schema.tournamentKnockoutResults
>;

export type TournamentKnockoutResultCreateInput = TournamentKnockoutResult;
export type TournamentKnockoutResultCreateInputs = readonly TournamentKnockoutResultCreateInput[];

export interface TournamentKnockoutResultRepository {
  readonly findByTournamentId: (
    tournamentId: TournamentId,
  ) => TE.TaskEither<DBError, TournamentKnockoutResults>;
  readonly saveBatchByTournamentId: (
    tournamentKnockoutResults: TournamentKnockoutResultCreateInputs,
  ) => TE.TaskEither<DBError, TournamentKnockoutResults>;
}
