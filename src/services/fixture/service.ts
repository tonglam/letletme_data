import { createEventFixtureOperations } from 'domains/event-fixture/operation';
import { EventFixtureCache, EventFixtureOperations } from 'domains/event-fixture/types';
import { TeamCache } from 'domains/team/types';
import { TeamFixtureCache } from 'domains/team-fixture/types';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as RA from 'fp-ts/ReadonlyArray';
import * as R from 'fp-ts/Record';
import * as TE from 'fp-ts/TaskEither';
import { FixtureService, FixtureServiceOperations } from 'services/fixture/types';
import { FplFixtureDataService } from 'src/data/types';
import { EventFixtureRepository } from 'src/repositories/event-fixture/type';
import { EventFixture, EventFixtures, RawEventFixtures } from 'src/types/domain/event-fixture.type';
import { EventId } from 'src/types/domain/event.type';
import { TeamFixture, TeamFixtures } from 'src/types/domain/team-fixture.type';
import { TeamId } from 'src/types/domain/team.type';
import {
  createDomainError,
  DataLayerError,
  DomainError,
  DomainErrorCode,
  ServiceError,
} from 'src/types/error.type';
import { enrichEventFixtures } from 'src/utils/data-enrichment.util';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'src/utils/error.util';

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
  eventFixtureDomainOps: EventFixtureOperations,
  eventFixtureCache: EventFixtureCache,
  teamFixtureCache: TeamFixtureCache,
  teamCacheActual: TeamCache,
): FixtureServiceOperations => {
  const mapTeamEventFixtures = (
    eventFixtures: EventFixtures,
  ): TE.TaskEither<ServiceError, TeamFixtures> => {
    return pipe(
      TE.of(eventFixtures),
      TE.chainW(enrichEventFixtures(teamCacheActual)),
      TE.chainEitherKW((enrichedFixtures: EventFixtures) =>
        pipe(
          enrichedFixtures,
          RA.traverse(E.Applicative)((ef: EventFixture): E.Either<DomainError, TeamFixtures> => {
            if (
              ef.teamH === null ||
              ef.teamA === null ||
              ef.kickoffTime === null ||
              ef.teamHName === null ||
              ef.teamHShortName === null ||
              ef.teamAName === null ||
              ef.teamAShortName === null
            ) {
              return E.left(
                createDomainError({
                  code: DomainErrorCode.VALIDATION_ERROR,
                  message: `Invalid EventFixture data: Missing required fields for fixture ID ${ef.id}`,
                }),
              );
            }
            const homeTeamId = ef.teamH as TeamId;
            const awayTeamId = ef.teamA as TeamId;
            return E.right([
              {
                eventId: ef.eventId as EventId,
                teamId: homeTeamId,
                teamName: ef.teamHName,
                teamShortName: ef.teamHShortName,
                teamScore: ef.teamHScore ?? 0,
                teamDifficulty: ef.teamHDifficulty ?? 0,
                opponentTeamId: awayTeamId,
                opponentTeamName: ef.teamAName,
                opponentTeamShortName: ef.teamAShortName,
                opponentTeamScore: ef.teamAScore ?? 0,
                opponentTeamDifficulty: ef.teamADifficulty ?? 0,
                kickoffTime: ef.kickoffTime,
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
                eventId: ef.eventId as EventId,
                teamId: awayTeamId,
                teamName: ef.teamAName,
                teamShortName: ef.teamAShortName,
                teamScore: ef.teamAScore ?? 0,
                teamDifficulty: ef.teamADifficulty ?? 0,
                opponentTeamId: homeTeamId,
                opponentTeamName: ef.teamHName,
                opponentTeamShortName: ef.teamHShortName,
                opponentTeamScore: ef.teamHScore ?? 0,
                opponentTeamDifficulty: ef.teamHDifficulty ?? 0,
                kickoffTime: ef.kickoffTime,
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
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chainFirstW((teamFixtures: TeamFixtures) =>
        pipe(
          teamFixtures,
          groupTeamFixturesByTeam,
          R.toEntries,
          RA.traverse(TE.ApplicativePar)(([, fixturesForTeam]) =>
            pipe(
              teamFixtureCache.setFixturesByTeamId(fixturesForTeam),
              TE.mapLeft(mapDomainErrorToServiceError),
            ),
          ),
          TE.map(() => undefined),
        ),
      ),
    );
  };

  const findFixturesByTeamId = (teamId: TeamId): TE.TaskEither<ServiceError, TeamFixtures> =>
    pipe(teamFixtureCache.getFixturesByTeamId(teamId), TE.mapLeft(mapDomainErrorToServiceError));

  const findFixturesByEventId = (eventId: EventId): TE.TaskEither<ServiceError, EventFixtures> =>
    pipe(eventFixtureCache.getEventFixtures(eventId), TE.mapLeft(mapDomainErrorToServiceError));

  const findFixtures = (): TE.TaskEither<ServiceError, EventFixtures> =>
    pipe(eventFixtureCache.getAllEventFixtures(), TE.mapLeft(mapDomainErrorToServiceError));

  const syncEventFixturesFromApi = (eventId: EventId): TE.TaskEither<ServiceError, void> =>
    pipe(
      fplDataService.getFixtures(eventId),
      TE.mapLeft((error: DataLayerError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch fixtures',
          cause: error.cause,
          details: error.details,
        }),
      ),
      TE.chainFirstW(() =>
        pipe(
          eventFixtureDomainOps.deleteEventFixtures(eventId),
          TE.mapLeft(mapDomainErrorToServiceError),
        ),
      ),
      TE.chainW((rawFixtures: RawEventFixtures) =>
        pipe(
          rawFixtures.length > 0
            ? eventFixtureDomainOps.saveEventFixtures(rawFixtures)
            : TE.right([] as RawEventFixtures),
          TE.mapLeft(mapDomainErrorToServiceError),
        ),
      ),
      TE.chainW((savedRawFixtures: RawEventFixtures) =>
        pipe(
          enrichEventFixtures(teamCacheActual)(savedRawFixtures),
          TE.mapLeft(mapDomainErrorToServiceError),
        ),
      ),
      TE.chainFirstW((enrichedEventFixtures: EventFixtures) =>
        pipe(
          enrichedEventFixtures.length > 0
            ? eventFixtureCache.setEventFixtures(enrichedEventFixtures)
            : TE.rightIO(() => {}),
          TE.mapLeft(mapDomainErrorToServiceError),
        ),
      ),
      TE.chainW((enrichedEventFixtures: EventFixtures) =>
        mapTeamEventFixtures(enrichedEventFixtures),
      ),
      TE.chainFirstW((enrichedTeamFixtures: TeamFixtures) =>
        pipe(
          enrichedTeamFixtures.length > 0
            ? teamFixtureCache.setFixturesByTeamId(enrichedTeamFixtures)
            : TE.rightIO(() => {}),
          TE.mapLeft(mapDomainErrorToServiceError),
        ),
      ),
      TE.map(() => undefined),
    );

  return {
    mapTeamEventFixtures,
    findFixturesByTeamId,
    findFixturesByEventId,
    findFixtures,
    syncEventFixturesFromApi,
  };
};

export const createFixtureService = (
  fplDataService: FplFixtureDataService,
  eventFixtureRepository: EventFixtureRepository,
  eventFixtureCache: EventFixtureCache,
  teamFixtureCache: TeamFixtureCache,
  teamCache: TeamCache,
): FixtureService => {
  const domainOps = createEventFixtureOperations(eventFixtureRepository);
  const ops: FixtureServiceOperations = fixtureServiceOperations(
    fplDataService,
    domainOps,
    eventFixtureCache,
    teamFixtureCache,
    teamCache,
  );

  return {
    getFixturesByTeamId: ops.findFixturesByTeamId,
    getFixturesByEventId: ops.findFixturesByEventId,
    getFixtures: ops.findFixtures,
    syncEventFixturesFromApi: ops.syncEventFixturesFromApi,
  };
};
