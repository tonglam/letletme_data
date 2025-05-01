import { EventCache } from 'domain/event/types';
import { createEventFixtureOperations } from 'domain/event-fixture/operation';
import { EventFixtureCache, EventFixtureOperations } from 'domain/event-fixture/types';
import { TeamCache } from 'domain/team/types';
import { TeamFixtureCache } from 'domain/team-fixture/types';

import { FplFixtureDataService } from 'data/types';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as RA from 'fp-ts/ReadonlyArray';
import * as R from 'fp-ts/Record';
import * as TE from 'fp-ts/TaskEither';
import { EventFixtureRepository } from 'repository/event-fixture/types';
import { FixtureService, FixtureServiceOperations } from 'service/fixture/types';
import { EventFixture, EventFixtures, RawEventFixtures } from 'types/domain/event-fixture.type';
import { EventId } from 'types/domain/event.type';
import { TeamFixture, TeamFixtures } from 'types/domain/team-fixture.type';
import { TeamId } from 'types/domain/team.type';
import {
  createDomainError,
  DataLayerError,
  DomainError,
  DomainErrorCode,
  ServiceError,
} from 'types/error.type';
import { enrichEventFixtures } from 'utils/data-enrichment.util';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'utils/error.util';

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
  domainOps: EventFixtureOperations,
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
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chainEitherKW((enrichedFixtures: EventFixtures) =>
        pipe(
          enrichedFixtures,
          RA.traverse(E.Applicative)((ef: EventFixture): E.Either<DomainError, TeamFixtures> => {
            if (
              ef.teamHId === null ||
              ef.teamAId === null ||
              ef.kickoffTime === null ||
              ef.teamHName === null ||
              ef.teamHShortName === null ||
              ef.teamAName === null ||
              ef.teamAShortName === null
            ) {
              const domainError = createDomainError({
                code: DomainErrorCode.VALIDATION_ERROR,
                message: `Invalid EventFixture data: Missing required fields for fixture ID ${ef.id}`,
              });
              return E.left(domainError);
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
      TE.mapLeft((error) => {
        if (error.name === 'DomainError') {
          return mapDomainErrorToServiceError(error as DomainError);
        }
        return error as ServiceError;
      }),
      TE.chainFirstW((teamFixtures: TeamFixtures) =>
        pipe(
          teamFixtures,
          groupTeamFixturesByTeam,
          R.toEntries,
          RA.traverse(TE.ApplicativePar)(([, fixturesForTeam]) =>
            teamFixtureCache.setFixturesByTeamId(fixturesForTeam),
          ),
          TE.mapLeft(mapDomainErrorToServiceError),
          TE.map(() => undefined),
        ),
      ),
    );
  };

  const findFixturesByTeamId = (teamId: TeamId): TE.TaskEither<ServiceError, TeamFixtures> =>
    pipe(teamFixtureCache.getFixturesByTeamId(teamId), TE.mapLeft(mapDomainErrorToServiceError));

  const findFixturesByEventId = (eventId: EventId): TE.TaskEither<ServiceError, EventFixtures> =>
    pipe(eventFixturecache.getEventFixtures(eventId), TE.mapLeft(mapDomainErrorToServiceError));

  const findFixtures = (): TE.TaskEither<ServiceError, EventFixtures> =>
    pipe(eventFixturecache.getAllEventFixtures(), TE.mapLeft(mapDomainErrorToServiceError));

  const syncEventFixturesFromApi = (eventId: EventId): TE.TaskEither<ServiceError, void> =>
    pipe(
      fplDataService.getFixtures(eventId),
      TE.mapLeft((error: DataLayerError) => {
        return createServiceIntegrationError({
          message: 'Failed to fetch fixtures',
          cause: error.cause,
          details: error.details,
        });
      }),
      TE.chainFirstW(() =>
        pipe(domainOps.deleteEventFixtures(eventId), TE.mapLeft(mapDomainErrorToServiceError)),
      ),
      TE.chainW((rawFixtures: RawEventFixtures) =>
        pipe(
          rawFixtures.length > 0
            ? domainOps.saveEventFixtures(rawFixtures)
            : TE.right([] as RawEventFixtures),
          TE.mapLeft(mapDomainErrorToServiceError),
        ),
      ),
      TE.chainW((savedRawFixtures: RawEventFixtures) =>
        pipe(
          enrichEventFixtures(teamCache)(savedRawFixtures),
          TE.mapLeft(mapDomainErrorToServiceError),
        ),
      ),
      TE.chainFirstW((enrichedEventFixtures: EventFixtures) =>
        pipe(
          enrichedEventFixtures.length > 0
            ? eventFixturecache.setEventFixtures(enrichedEventFixtures)
            : TE.rightIO(() => {}),
          TE.mapLeft(mapDomainErrorToServiceError),
        ),
      ),
      TE.chainW((enrichedEventFixtures: EventFixtures) => {
        return mapTeamEventFixtures(enrichedEventFixtures);
      }),
      TE.map(() => {
        return undefined;
      }),
    );

  const syncFixturesFromApi = (): TE.TaskEither<ServiceError, void> =>
    pipe(
      eventCache.getAllEvents(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.map(RA.map((event) => event.id)),
      TE.chainW((eventIds) => pipe(eventIds.map(syncEventFixturesFromApi), TE.sequenceArray)),
      TE.map(() => undefined),
    );

  return {
    mapTeamEventFixtures,
    findFixturesByTeamId,
    findFixturesByEventId,
    findFixtures,
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
  const domainOps = createEventFixtureOperations(repository);
  const ops: FixtureServiceOperations = fixtureServiceOperations(
    fplDataService,
    domainOps,
    eventFixturecache,
    teamFixtureCache,
    eventCache,
    teamCache,
  );

  return {
    getFixturesByTeamId: ops.findFixturesByTeamId,
    getFixturesByEventId: ops.findFixturesByEventId,
    getFixtures: ops.findFixtures,
    syncEventFixturesFromApi: ops.syncEventFixturesFromApi,
    syncFixturesFromApi: ops.syncFixturesFromApi,
  };
};
