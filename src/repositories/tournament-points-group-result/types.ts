import {
  Prisma,
  TournamentPointsGroupResult as PrismaTournamentPointsGroupResultType,
} from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { DBError } from 'src/types/error.type';

import { TournamentId } from '../../types/domain/tournament-info.type';
import {
  TournamentPointsGroupResult,
  TournamentPointsGroupResults,
} from '../../types/domain/tournament-points-group-result.type';

export type PrismaTournamentPointsGroupResultCreateInput =
  Prisma.TournamentPointsGroupResultCreateInput;
export type PrismaTournamentPointsGroupResult = PrismaTournamentPointsGroupResultType;

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
