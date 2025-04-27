import {
  Prisma,
  TournamentKnockoutResult as PrismaTournamentKnockoutResultType,
} from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { DBError } from 'src/types/error.type';

import { TournamentId } from '../../types/domain/tournament-info.type';
import {
  TournamentKnockoutResult,
  TournamentKnockoutResults,
} from '../../types/domain/tournament-knockout-result.type';

export type PrismaTournamentKnockoutResultCreateInput = Prisma.TournamentKnockoutResultCreateInput;
export type PrismaTournamentKnockoutResult = PrismaTournamentKnockoutResultType;

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
