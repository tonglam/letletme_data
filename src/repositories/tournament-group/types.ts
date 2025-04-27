import { Prisma, TournamentGroup as PrismaTournamentGroupType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { DBError } from 'src/types/error.type';

import { TournamentGroup, TournamentGroups } from '../../types/domain/tournament-group.type';
import { TournamentId } from '../../types/domain/tournament-info.type';

export type PrismaTournamentGroupCreateInput = Prisma.TournamentGroupCreateInput;
export type PrismaTournamentGroup = PrismaTournamentGroupType;

export type TournamentGroupCreateInput = TournamentGroup;
export type TournamentGroupCreateInputs = readonly TournamentGroupCreateInput[];

export interface TournamentGroupRepository {
  readonly findByTournamentId: (
    tournamentId: TournamentId,
  ) => TE.TaskEither<DBError, TournamentGroups>;
  readonly saveBatchByTournamentId: (
    tournamentGroups: TournamentGroupCreateInputs,
  ) => TE.TaskEither<DBError, TournamentGroups>;
}
