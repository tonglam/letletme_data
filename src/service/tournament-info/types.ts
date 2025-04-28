import * as TE from 'fp-ts/TaskEither';
import { TournamentInfo, TournamentInfos, TournamentId } from 'types/domain/tournament-info.type';

import type { ServiceError } from 'types/error.type';

export interface TournamentInfoServiceOperations {
  readonly findTournamentInfoById: (
    id: TournamentId,
  ) => TE.TaskEither<ServiceError, TournamentInfo>;
  readonly findPointsRaceGroups: () => TE.TaskEither<ServiceError, TournamentInfos>;
  readonly findBattleGroups: () => TE.TaskEither<ServiceError, TournamentInfos>;
  readonly findKnockouts: () => TE.TaskEither<ServiceError, TournamentInfos>;
  readonly findAllTournamentInfos: () => TE.TaskEither<ServiceError, TournamentInfos>;
}

export interface TournamentInfoService {
  readonly getTournamentInfo: (id: TournamentId) => TE.TaskEither<ServiceError, TournamentInfo>;
  readonly getPointsRaceGroups: () => TE.TaskEither<ServiceError, TournamentInfos>;
  readonly getBattleGroups: () => TE.TaskEither<ServiceError, TournamentInfos>;
  readonly getKnockouts: () => TE.TaskEither<ServiceError, TournamentInfos>;
  readonly getTournamentInfos: () => TE.TaskEither<ServiceError, TournamentInfos>;
}
