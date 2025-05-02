import { Event, EventCache } from 'domain/event/types';
import { EventFixtureCache } from 'domain/event-fixture/types';
import { TeamCache } from 'domain/team/types';
import { TeamFixtureCache } from 'domain/team-fixture/types';

import { FplFixtureDataService } from 'data/types';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as RA from 'fp-ts/ReadonlyArray';
import * as R from 'fp-ts/Record';
import * as TE from 'fp-ts/TaskEither';
import { EventFixtureRepository } from 'repository/event-fixture/types';
import { FixtureService, FixtureServiceOperations } from 'service/fixture/types';
import { EventFixture, EventFixtures, RawEventFixtures } from 'types/domain/event-fixture.type';
import { EventId } from 'types/domain/event.type';
import { TeamFixture, TeamFixtures } from 'types/domain/team-fixture.type';
import { TeamId } from 'types/domain/team.type';
import { createServiceError, ServiceError, ServiceErrorCode } from 'types/error.type';
import { enrichEventFixtures } from 'utils/data-enrichment.util';
import { eqDate, normalizeDate } from 'utils/date.util';
import { ordDate } from 'utils/date.util';
import {
  mapCacheErrorToServiceError,
  mapDataLayerErrorToServiceError,
  mapDBErrorToServiceError,
} from 'utils/error.util';

const groupTeamFixturesByTeam = (fixtures: TeamFixtures): Readonly<Record<string, TeamFixtures>> =>
  pipe(
    fixtures,
    RA.reduce({} as Record<string, TeamFixture[]>, (acc, fixture) => {
      const teamIdStr = String(fixture.teamId);
      if (!acc[teamIdStr]) {
        acc[teamIdStr] = [];
      }
      acc[teamIdStr].push(fixture);
      return acc;
    }),
    R.map(RA.fromArray),
  );

const getScoreString = (scoreH: number | null, scoreA: number | null): string => {
  if (scoreH === null || scoreA === null) return '-:-';
  return `${scoreH}:${scoreA}`;
};

const getResultString = (
  scoreH: number | null,
  scoreA: number | null,
  teamId: TeamId,
  teamHId: TeamId,
): string => {
  if (scoreH === null || scoreA === null) return '';
  if (scoreH === scoreA) return 'D';
  return (teamId === teamHId && scoreH > scoreA) || (teamId !== teamHId && scoreA > scoreH)
    ? 'W'
    : 'L';
};

const fixtureServiceOperations = (
  fplDataService: FplFixtureDataService,
  repository: EventFixtureRepository,
  eventFixturecache: EventFixtureCache,
  teamFixtureCache: TeamFixtureCache,
  eventCache: EventCache,
  teamCache: TeamCache,
): FixtureServiceOperations => {
  const mapTeamEventFixtures = (
    eventFixtures: EventFixtures,
  ): TE.TaskEither<ServiceError, TeamFixtures> => {
    return pipe(
      TE.of(eventFixtures),
      TE.chainW(enrichEventFixtures(teamCache)),
      TE.mapLeft(mapCacheErrorToServiceError),
      TE.chainEitherKW((enrichedFixtures: EventFixtures) =>
        pipe(
          enrichedFixtures,
          RA.traverse(E.Applicative)((ef: EventFixture): E.Either<ServiceError, TeamFixtures> => {
            if (
              ef.teamHId === null ||
              ef.teamAId === null ||
              ef.kickoffTime === null ||
              ef.teamHName === null ||
              ef.teamHShortName === null ||
              ef.teamAName === null ||
              ef.teamAShortName === null
            ) {
              const serviceError = createServiceError({
                code: ServiceErrorCode.VALIDATION_ERROR,
                message: `Invalid EventFixture data: Missing required fields for fixture ID ${ef.id}`,
              });
              return E.left(serviceError);
            }
            const homeTeamId = ef.teamHId as TeamId;
            const awayTeamId = ef.teamAId as TeamId;
            return E.right([
              {
                id: ef.id,
                eventId: ef.eventId as EventId,
                teamId: homeTeamId,
                teamName: ef.teamHName!,
                teamShortName: ef.teamHShortName!,
                teamScore: ef.teamHScore ?? 0,
                teamDifficulty: ef.teamHDifficulty ?? 0,
                opponentTeamId: awayTeamId,
                opponentTeamName: ef.teamAName!,
                opponentTeamShortName: ef.teamAShortName!,
                opponentTeamScore: ef.teamAScore ?? 0,
                opponentTeamDifficulty: ef.teamADifficulty ?? 0,
                kickoffTime: ef.kickoffTime!,
                started: ef.started,
                finished: ef.finished,
                minutes: ef.minutes,
                wasHome: true,
                score: getScoreString(ef.teamHScore, ef.teamAScore),
                result: getResultString(ef.teamHScore, ef.teamAScore, homeTeamId, homeTeamId),
                dgw: false,
                bgw: false,
              },
              {
                id: ef.id,
                eventId: ef.eventId as EventId,
                teamId: awayTeamId,
                teamName: ef.teamAName!,
                teamShortName: ef.teamAShortName!,
                teamScore: ef.teamAScore ?? 0,
                teamDifficulty: ef.teamADifficulty ?? 0,
                opponentTeamId: homeTeamId,
                opponentTeamName: ef.teamHName!,
                opponentTeamShortName: ef.teamHShortName!,
                opponentTeamScore: ef.teamHScore ?? 0,
                opponentTeamDifficulty: ef.teamHDifficulty ?? 0,
                kickoffTime: ef.kickoffTime!,
                started: ef.started,
                finished: ef.finished,
                minutes: ef.minutes,
                wasHome: false,
                score: getScoreString(ef.teamHScore, ef.teamAScore),
                result: getResultString(ef.teamHScore, ef.teamAScore, awayTeamId, homeTeamId),
                dgw: false,
                bgw: false,
              },
            ]);
          }),
          E.map(RA.flatten),
        ),
      ),
      TE.chainFirstW((teamFixtures: TeamFixtures) =>
        pipe(
          teamFixtures,
          groupTeamFixturesByTeam,
          R.toEntries,
          RA.traverse(TE.ApplicativePar)(([, fixturesForTeam]) =>
            teamFixtureCache.setFixturesByTeamId(fixturesForTeam),
          ),
          TE.mapLeft(mapCacheErrorToServiceError),
          TE.map(() => undefined),
        ),
      ),
    );
  };

  const findFixturesByTeamId = (teamId: TeamId): TE.TaskEither<ServiceError, TeamFixtures> =>
    pipe(teamFixtureCache.getFixturesByTeamId(teamId), TE.mapLeft(mapCacheErrorToServiceError));

  const findFixturesByEventId = (eventId: EventId): TE.TaskEither<ServiceError, EventFixtures> =>
    pipe(eventFixturecache.getEventFixtures(eventId), TE.mapLeft(mapCacheErrorToServiceError));

  const findFixtures = (): TE.TaskEither<ServiceError, EventFixtures> =>
    pipe(eventFixturecache.getAllEventFixtures(), TE.mapLeft(mapCacheErrorToServiceError));

  const calculateAfterMatchDayDate = (kickoffTime: Date): Date => {
    const kickoffDate = normalizeDate(kickoffTime);
    const sixAmOnKickoffDay = new Date(kickoffDate);
    sixAmOnKickoffDay.setHours(6, 0, 0, 0);

    if (kickoffTime < sixAmOnKickoffDay) {
      return kickoffDate;
    } else {
      const nextDay = new Date(kickoffDate);
      nextDay.setDate(kickoffDate.getDate() + 1);
      return nextDay;
    }
  };

  const isMatchDay = (eventId: EventId): TE.TaskEither<ServiceError, boolean> => {
    const today = normalizeDate(new Date());
    return pipe(findAllMatchDays(eventId), TE.map(RA.elem(eqDate)(today)));
  };

  const isAfterMatchDay = (eventId: EventId): TE.TaskEither<ServiceError, boolean> => {
    const todayNormalized = normalizeDate(new Date());
    return pipe(
      findAllAfterMatchDays(eventId),
      TE.map(RA.last),
      TE.map(
        O.match(
          () => false,
          (latestAfterMatchDay: Date) => ordDate.compare(todayNormalized, latestAfterMatchDay) > 0,
        ),
      ),
    );
  };

  const isMatchTime = (eventId: EventId): TE.TaskEither<ServiceError, boolean> => {
    const now = new Date();
    return pipe(
      eventFixturecache.getEventFixtures(eventId),
      TE.mapLeft(mapCacheErrorToServiceError),
      TE.map((fixtures: EventFixtures) =>
        fixtures.some(
          (f: EventFixture) =>
            f.kickoffTime !== null && f.kickoffTime <= now && !f.finished && f.started,
        ),
      ),
    );
  };

  const isSelectTime = (eventId: EventId): TE.TaskEither<ServiceError, boolean> => {
    const now = new Date();

    return pipe(
      isMatchDay(eventId),
      TE.chainW((isMatchDayResult) => {
        if (!isMatchDayResult) {
          return TE.right(false);
        }

        return pipe(
          eventCache.getEvent(eventId),
          TE.mapLeft(mapCacheErrorToServiceError),
          TE.chainEitherK((event: Event) => {
            try {
              const deadlineDate = new Date(event.deadlineTime);
              if (isNaN(deadlineDate.getTime())) {
                return E.left(
                  createServiceError({
                    code: ServiceErrorCode.VALIDATION_ERROR,
                    message: `Invalid deadline time format for event ${eventId}: ${event.deadlineTime}`,
                  }),
                );
              }
              const deadlinePlus30 = new Date(deadlineDate);
              deadlinePlus30.setMinutes(deadlineDate.getMinutes() + 30);
              return E.right(now > deadlinePlus30);
            } catch (error) {
              return E.left(
                createServiceError({
                  code: ServiceErrorCode.UNKNOWN,
                  message: `Error processing deadline time for event ${eventId}: ${event.deadlineTime}`,
                  cause: error instanceof Error ? error : undefined,
                }),
              );
            }
          }),
        );
      }),
    );
  };

  const findAllMatchDays = (eventId: EventId): TE.TaskEither<ServiceError, ReadonlyArray<Date>> => {
    return pipe(
      eventFixturecache.getEventFixtures(eventId),
      TE.mapLeft(mapCacheErrorToServiceError),
      TE.map((fixtures: EventFixtures) =>
        pipe(
          fixtures,
          RA.filterMap((fixture) => O.fromNullable(fixture.kickoffTime)),
          RA.map(normalizeDate),
          RA.uniq(eqDate),
          RA.sort(ordDate),
        ),
      ),
    );
  };

  const findAllAfterMatchDays = (
    eventId: EventId,
  ): TE.TaskEither<ServiceError, ReadonlyArray<Date>> => {
    return pipe(
      eventFixturecache.getEventFixtures(eventId),
      TE.mapLeft(mapCacheErrorToServiceError),
      TE.map((fixtures: EventFixtures) =>
        pipe(
          fixtures,
          RA.filterMap((fixture) => O.fromNullable(fixture.kickoffTime)),
          RA.map(calculateAfterMatchDayDate),
          RA.uniq(eqDate),
          RA.sort(ordDate),
        ),
      ),
    );
  };

  const syncEventFixturesFromApi = (eventId: EventId): TE.TaskEither<ServiceError, void> =>
    pipe(
      fplDataService.getFixtures(eventId),
      TE.mapLeft(mapDataLayerErrorToServiceError),
      TE.chainFirstW(() =>
        pipe(repository.deleteByEventId(eventId), TE.mapLeft(mapDBErrorToServiceError)),
      ),
      TE.chainW((rawFixtures: RawEventFixtures) =>
        pipe(
          rawFixtures.length > 0
            ? repository.saveBatchByEventId(rawFixtures)
            : TE.right([] as RawEventFixtures),
          TE.mapLeft(mapDBErrorToServiceError),
        ),
      ),
      TE.chainW((savedRawEventFixtures: RawEventFixtures) =>
        pipe(
          enrichEventFixtures(teamCache)(savedRawEventFixtures),
          TE.mapLeft(mapCacheErrorToServiceError),
        ),
      ),
      TE.chainFirstW((enrichedEventFixtures: EventFixtures) =>
        pipe(
          enrichedEventFixtures.length > 0
            ? eventFixturecache.setEventFixtures(enrichedEventFixtures)
            : TE.right(undefined),
          TE.mapLeft(mapCacheErrorToServiceError),
        ),
      ),
      TE.chainW((enrichedEventFixtures: EventFixtures) => {
        return mapTeamEventFixtures(enrichedEventFixtures);
      }),
      TE.map(() => undefined),
    );

  const syncFixturesFromApi = (): TE.TaskEither<ServiceError, void> =>
    pipe(
      eventCache.getAllEvents(),
      TE.mapLeft(mapCacheErrorToServiceError),
      TE.map(RA.map((event) => event.id)),
      TE.chainW((eventIds) => pipe(eventIds.map(syncEventFixturesFromApi), TE.sequenceArray)),
      TE.map(() => undefined),
    );

  return {
    mapTeamEventFixtures,
    findFixturesByTeamId,
    findFixturesByEventId,
    findFixtures,
    isMatchDay,
    isAfterMatchDay,
    isMatchTime,
    isSelectTime,
    findAllMatchDays,
    findAllAfterMatchDays,
    syncEventFixturesFromApi,
    syncFixturesFromApi,
  };
};

export const createFixtureService = (
  fplDataService: FplFixtureDataService,
  repository: EventFixtureRepository,
  eventFixturecache: EventFixtureCache,
  teamFixtureCache: TeamFixtureCache,
  eventCache: EventCache,
  teamCache: TeamCache,
): FixtureService => {
  const ops: FixtureServiceOperations = fixtureServiceOperations(
    fplDataService,
    repository,
    eventFixturecache,
    teamFixtureCache,
    eventCache,
    teamCache,
  );

  return {
    getFixturesByTeamId: ops.findFixturesByTeamId,
    getFixturesByEventId: ops.findFixturesByEventId,
    getFixtures: ops.findFixtures,
    isMatchDay: (eventId: EventId): TE.TaskEither<ServiceError, boolean> => ops.isMatchDay(eventId),
    isAfterMatchDay: (eventId: EventId): TE.TaskEither<ServiceError, boolean> =>
      ops.isAfterMatchDay(eventId),
    isMatchTime: (eventId: EventId): TE.TaskEither<ServiceError, boolean> =>
      ops.isMatchTime(eventId),
    isSelectTime: (eventId: EventId): TE.TaskEither<ServiceError, boolean> =>
      ops.isSelectTime(eventId),
    getMatchDays: (eventId: EventId): TE.TaskEither<ServiceError, ReadonlyArray<Date>> =>
      ops.findAllMatchDays(eventId),
    getAfterMatchDays: (eventId: EventId): TE.TaskEither<ServiceError, ReadonlyArray<Date>> =>
      ops.findAllAfterMatchDays(eventId),
    syncEventFixturesFromApi: ops.syncEventFixturesFromApi,
    syncFixturesFromApi: ops.syncFixturesFromApi,
  };
};
