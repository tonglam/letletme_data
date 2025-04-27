import { TournamentInfo as PrismaTournamentInfoType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { DBError } from 'src/types/error.type';

import {
  TournamentInfo,
  TournamentInfos,
  TournamentId,
} from '../../types/domain/tournament-info.type';

export type PrismaTournamentInfo = PrismaTournamentInfoType;

export type TournamentInfoCreateInput = TournamentInfo;
export type TournamentInfoCreateInputs = readonly TournamentInfoCreateInput[];

export interface TournamentInfoRepository {
  readonly findById: (id: TournamentId) => TE.TaskEither<DBError, TournamentInfo>;
  readonly findAll: () => TE.TaskEither<DBError, TournamentInfos>;
}
