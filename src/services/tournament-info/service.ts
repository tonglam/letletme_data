import { EventCache } from 'domains/event/types';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import { Option } from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { TournamentInfoRepository } from 'repositories/tournament-info/types';
import {
  TournamentInfoService,
  TournamentInfoServiceOperations,
} from 'services/tournament-info/types';
import { TournamentMode, GroupMode, TournamentState, KnockoutMode } from 'types/base.type';
import { TournamentInfo, TournamentInfos } from 'types/domain/tournament-info.type';
import { TournamentId } from 'types/domain/tournament-info.type';
import { createDomainError, DomainErrorCode, ServiceError } from 'types/error.type';
import { mapDBErrorToServiceError, mapDomainErrorToServiceError } from 'utils/error.util';

const tournamentInfoServiceOperations = (
  repository: TournamentInfoRepository,
  eventCache: EventCache,
): TournamentInfoServiceOperations => {
  const findTournamentInfoById = (id: TournamentId): TE.TaskEither<ServiceError, TournamentInfo> =>
    pipe(
      repository.findById(id),
      TE.mapLeft(mapDBErrorToServiceError),
      TE.chainOptionK<ServiceError>(
        (): ServiceError =>
          mapDomainErrorToServiceError(
            createDomainError({
              code: DomainErrorCode.NOT_FOUND,
              message: `TournamentInfo with ID ${id} not found.`,
            }),
          ),
      )((tournamentInfo): Option<TournamentInfo> => O.fromNullable(tournamentInfo)),
    );

  const findPointsRaceGroups = (): TE.TaskEither<ServiceError, TournamentInfos> =>
    pipe(
      eventCache.getCurrentEvent(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chain((currentEvent) =>
        pipe(
          repository.findAll(),
          TE.mapLeft(mapDBErrorToServiceError),
          TE.map((tournamentInfos) =>
            tournamentInfos.filter(
              (tournamentInfo) =>
                tournamentInfo.tournamentMode === TournamentMode.Normal &&
                tournamentInfo.groupMode === GroupMode.PointsRaces &&
                tournamentInfo.state === TournamentState.Active &&
                tournamentInfo.groupStartedEventId !== null &&
                tournamentInfo.groupStartedEventId <= currentEvent.id &&
                tournamentInfo.groupEndedEventId !== null &&
                tournamentInfo.groupEndedEventId >= currentEvent.id,
            ),
          ),
        ),
      ),
    );

  const findBattleGroups = (): TE.TaskEither<ServiceError, TournamentInfos> =>
    pipe(
      eventCache.getCurrentEvent(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chain((currentEvent) =>
        pipe(
          repository.findAll(),
          TE.mapLeft(mapDBErrorToServiceError),
          TE.map((tournamentInfos) =>
            tournamentInfos.filter(
              (tournamentInfo) =>
                tournamentInfo.tournamentMode === TournamentMode.Normal &&
                tournamentInfo.groupMode === GroupMode.BattleRaces &&
                tournamentInfo.state === TournamentState.Active &&
                tournamentInfo.groupStartedEventId !== null &&
                tournamentInfo.groupStartedEventId <= currentEvent.id &&
                tournamentInfo.groupEndedEventId !== null &&
                tournamentInfo.groupEndedEventId >= currentEvent.id,
            ),
          ),
        ),
      ),
    );

  const findKnockouts = (): TE.TaskEither<ServiceError, TournamentInfos> =>
    pipe(
      eventCache.getCurrentEvent(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chain((currentEvent) =>
        pipe(
          repository.findAll(),
          TE.mapLeft(mapDBErrorToServiceError),
          TE.map((tournamentInfos) =>
            tournamentInfos.filter(
              (tournamentInfo) =>
                tournamentInfo.tournamentMode === TournamentMode.Normal &&
                tournamentInfo.knockoutMode !== KnockoutMode.NoKnockout &&
                tournamentInfo.state === TournamentState.Active &&
                tournamentInfo.knockoutStartedEventId !== null &&
                tournamentInfo.knockoutStartedEventId <= currentEvent.id &&
                tournamentInfo.knockoutEndedEventId !== null &&
                tournamentInfo.knockoutEndedEventId >= currentEvent.id,
            ),
          ),
        ),
      ),
    );

  const findAllTournamentInfos = (): TE.TaskEither<ServiceError, TournamentInfos> =>
    pipe(repository.findAll(), TE.mapLeft(mapDBErrorToServiceError));

  return {
    findTournamentInfoById,
    findPointsRaceGroups,
    findBattleGroups,
    findKnockouts,
    findAllTournamentInfos,
  };
};

export const createTournamentInfoService = (
  repository: TournamentInfoRepository,
  eventCache: EventCache,
): TournamentInfoService => {
  const ops = tournamentInfoServiceOperations(repository, eventCache);

  return {
    getTournamentInfo: (id: TournamentId): TE.TaskEither<ServiceError, TournamentInfo> =>
      ops.findTournamentInfoById(id),
    getPointsRaceGroups: (): TE.TaskEither<ServiceError, TournamentInfos> =>
      ops.findPointsRaceGroups(),
    getBattleGroups: (): TE.TaskEither<ServiceError, TournamentInfos> => ops.findBattleGroups(),
    getKnockouts: (): TE.TaskEither<ServiceError, TournamentInfos> => ops.findKnockouts(),
    getTournamentInfos: (): TE.TaskEither<ServiceError, TournamentInfos> =>
      ops.findAllTournamentInfos(),
  };
};
