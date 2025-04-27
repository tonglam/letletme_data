import {
  Prisma,
  TournamentBattleGroupResult as PrismaTournamentBattleGroupResultType,
} from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { DBError } from 'src/types/error.type';

import {
  TournamentBattleGroupResult,
  TournamentBattleGroupResults,
} from '../../types/domain/tournament-battle-group-result.type';
import { TournamentId } from '../../types/domain/tournament-info.type';

export type PrismaTournamentBattleGroupResultCreateInput =
  Prisma.TournamentBattleGroupResultCreateInput;
export type PrismaTournamentBattleGroupResult = PrismaTournamentBattleGroupResultType;

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
