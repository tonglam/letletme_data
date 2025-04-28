import { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import * as TE from 'fp-ts/TaskEither';
import * as schema from 'schema/tournament-battle-group-result';
import {
  TournamentBattleGroupResult,
  TournamentBattleGroupResults,
} from 'types/domain/tournament-battle-group-result.type';
import { TournamentId } from 'types/domain/tournament-info.type';
import { DBError } from 'types/error.type';

export type DbTournamentBattleGroupResult = InferSelectModel<
  typeof schema.tournamentBattleGroupResults
>;
export type DbTournamentBattleGroupResultCreateInput = InferInsertModel<
  typeof schema.tournamentBattleGroupResults
>;

export type TournamentBattleGroupResultCreateInput = TournamentBattleGroupResult;
export type TournamentBattleGroupResultCreateInputs =
  readonly TournamentBattleGroupResultCreateInput[];

export interface TournamentBattleGroupResultRepository {
  readonly findByTournamentId: (
    tournamentId: TournamentId,
  ) => TE.TaskEither<DBError, TournamentBattleGroupResults>;
  readonly saveBatchByTournamentId: (
    tournamentBattleGroupResults: TournamentBattleGroupResultCreateInputs,
  ) => TE.TaskEither<DBError, TournamentBattleGroupResults>;
}
