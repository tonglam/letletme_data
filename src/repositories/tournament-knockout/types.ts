import { Prisma, TournamentKnockout as PrismaTournamentKnockoutType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { DBError } from 'src/types/error.type';

import { TournamentId } from '../../types/domain/tournament-info.type';
import {
  TournamentKnockout,
  TournamentKnockouts,
} from '../../types/domain/tournament-knockout.type';

export type PrismaTournamentKnockoutCreateInput = Prisma.TournamentKnockoutCreateInput;
export type PrismaTournamentKnockout = PrismaTournamentKnockoutType;

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
