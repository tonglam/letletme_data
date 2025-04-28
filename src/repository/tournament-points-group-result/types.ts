import { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import * as TE from 'fp-ts/TaskEither';
import * as schema from 'schema/tournament-points-group-result';
import { TournamentId } from 'types/domain/tournament-info.type';
import {
  TournamentPointsGroupResult,
  TournamentPointsGroupResults,
} from 'types/domain/tournament-points-group-result.type';
import { DBError } from 'types/error.type';

export type DbTournamentPointsGroupResult = InferSelectModel<
  typeof schema.tournamentPointsGroupResults
>;
export type DbTournamentPointsGroupResultCreateInput = InferInsertModel<
  typeof schema.tournamentPointsGroupResults
>;

export type TournamentPointsGroupResultCreateInput = TournamentPointsGroupResult;
export type TournamentPointsGroupResultCreateInputs =
  readonly TournamentPointsGroupResultCreateInput[];

export interface TournamentPointsGroupResultRepository {
  readonly findByTournamentId: (
    tournamentId: TournamentId,
  ) => TE.TaskEither<DBError, TournamentPointsGroupResults>;
  readonly saveBatchByTournamentId: (
    tournamentPointsGroupResults: TournamentPointsGroupResultCreateInputs,
  ) => TE.TaskEither<DBError, TournamentPointsGroupResults>;
}
