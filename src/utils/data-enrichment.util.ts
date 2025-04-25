import { PlayerCache } from 'domains/player/types';
import { TeamCache } from 'domains/team/types';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as RA from 'fp-ts/ReadonlyArray';
import * as RNEA from 'fp-ts/ReadonlyNonEmptyArray';
import * as TE from 'fp-ts/TaskEither';
import { ElementTypeId, ElementTypeName, getElementTypeName } from 'src/types/base.type';
import {
  EventFixture,
  EventFixtures,
  RawEventFixture,
  RawEventFixtures,
} from 'src/types/domain/event-fixture.type';
import { PlayerStat, PlayerStats, RawPlayerStat } from 'src/types/domain/player-stat.type';
import { PlayerValue, PlayerValues, RawPlayerValue } from 'src/types/domain/player-value.type';
import { Player } from 'src/types/domain/player.type';
import { RawPlayers, Players } from 'src/types/domain/player.type';
import { Team, TeamId } from 'src/types/domain/team.type';
import { createDomainError, DomainError, DomainErrorCode } from 'src/types/error.type';

type HasElement = { element: number };

type EnrichedWithElementType<T extends HasElement> = T & {
  elementType: ElementTypeId;
  elementTypeName: ElementTypeName;
  webName: string;
  value: number;
};

type EnrichedWithTeam<
  T extends HasElement & { elementType: ElementTypeId; elementTypeName: ElementTypeName },
> = T & {
  team: TeamId;
  teamName: string;
  teamShortName: string;
};

export const enrichWithElementType =
  <T extends HasElement>(playerCache: PlayerCache) =>
  (
    items: ReadonlyArray<T>,
  ): TE.TaskEither<DomainError, ReadonlyArray<EnrichedWithElementType<T>>> => {
    if (RA.isEmpty(items)) {
      return TE.right([]);
    }

    return pipe(
      playerCache.getAllPlayers(),
      TE.map((players) => {
        const playerMap = new Map(players.map((p) => [p.id as number, p]));
        const enriched = pipe(
          items,
          RA.map((item): O.Option<EnrichedWithElementType<T>> => {
            const playerOpt = O.fromNullable(playerMap.get(item.element));
            return pipe(
              playerOpt,
              O.map((player) => {
                const elementType = player.type as ElementTypeId;
                return {
                  ...item,
                  elementType: elementType,
                  elementTypeName: getElementTypeName(elementType),
                  webName: player.webName,
                  value: player.price,
                };
              }),
            );
          }),
          RA.compact,
        );
        return enriched;
      }),
    );
  };

export const enrichWithTeam =
  <T extends HasElement & { elementType: ElementTypeId; elementTypeName: ElementTypeName }>(
    playerCache: PlayerCache,
    teamCache: TeamCache,
  ) =>
  (items: ReadonlyArray<T>): TE.TaskEither<DomainError, ReadonlyArray<EnrichedWithTeam<T>>> => {
    if (RA.isEmpty(items)) {
      return TE.right([]);
    }

    return pipe(
      playerCache.getAllPlayers(),
      TE.bindTo('players'),
      TE.bind('teams', () => teamCache.getAllTeams()),
      TE.chain(({ players, teams }) => {
        const playerMap = new Map(players.map((p) => [p.id as number, p]));
        const teamMap = new Map(teams.map((t: Team) => [t.id as number, t]));

        const relevantPlayerMap = new Map<number, Player>();
        items.forEach((item) => {
          const player = playerMap.get(item.element);
          if (player) relevantPlayerMap.set(item.element, player);
        });

        const enrichedItems = pipe(
          items,
          RA.map((item) => {
            const playerOpt = O.fromNullable(relevantPlayerMap.get(item.element));
            const teamOpt: O.Option<Team> = pipe(
              playerOpt,
              O.chain((p: Player) => O.fromNullable(teamMap.get(p.teamId as number))),
            );

            return pipe(
              teamOpt,
              O.map(
                (team): EnrichedWithTeam<T> => ({
                  ...item,
                  team: team.id,
                  teamName: team.name,
                  teamShortName: team.shortName,
                }),
              ),
            );
          }),
          RA.compact,
        );

        return TE.right(enrichedItems as ReadonlyArray<EnrichedWithTeam<T>>);
      }),
    );
  };

export const enrichPlayers =
  (teamCache: TeamCache) =>
  (rawPlayers: RawPlayers): TE.TaskEither<DomainError, Players> => {
    return pipe(
      teamCache.getAllTeams(),
      TE.map((teams) => {
        const teamMap = new Map(teams.map((t) => [t.id as number, t]));
        const enriched = pipe(
          rawPlayers,
          RA.map(
            (rawPlayer): O.Option<Player> =>
              pipe(
                O.fromNullable(teamMap.get(rawPlayer.teamId as number)),
                O.map(
                  (team): Player => ({
                    ...rawPlayer,
                    price: rawPlayer.price / 10,
                    startPrice: rawPlayer.startPrice / 10,
                    teamName: team.name,
                    teamShortName: team.shortName,
                  }),
                ),
              ),
          ),
          RA.compact,
        );
        return enriched;
      }),
    );
  };

export const enrichPlayerStats =
  (playerCache: PlayerCache, teamCache: TeamCache) =>
  (sourceStats: ReadonlyArray<RawPlayerStat>): TE.TaskEither<DomainError, PlayerStats> =>
    pipe(
      sourceStats,
      RA.map((stat) => ({ element: stat.elementId, original: stat })),
      enrichWithElementType(playerCache),
      TE.chain(enrichWithTeam(playerCache, teamCache)),
      TE.map(
        RA.map(
          (enriched) =>
            ({
              ...enriched.original,
              webName: enriched.webName,
              elementTypeName: enriched.elementTypeName,
              elementType: enriched.elementType,
              teamId: enriched.team,
              teamName: enriched.teamName,
              teamShortName: enriched.teamShortName,
              value: enriched.value,
            }) as PlayerStat,
        ),
      ),
      TE.map((stats) => stats as PlayerStats),
    );

export const enrichPlayerStat =
  (playerCache: PlayerCache, teamCache: TeamCache) =>
  (sourceStat: RawPlayerStat): TE.TaskEither<DomainError, PlayerStat> =>
    pipe(
      TE.of([sourceStat]),
      TE.chain(enrichPlayerStats(playerCache, teamCache)),
      TE.chainOptionK(() =>
        createDomainError({
          code: DomainErrorCode.NOT_FOUND,
          message:
            'Enrichment resulted in an empty array for a single item, likely missing Player or Team data.',
        }),
      )(RNEA.fromReadonlyArray),
      TE.map(RNEA.head),
    );

export const enrichPlayerValues =
  (playerCache: PlayerCache, teamCache: TeamCache) =>
  (sourceValues: ReadonlyArray<RawPlayerValue>): TE.TaskEither<DomainError, PlayerValues> =>
    pipe(
      sourceValues,
      RA.map((value) => ({ element: value.elementId, original: value })),
      enrichWithElementType(playerCache),
      TE.chain(enrichWithTeam(playerCache, teamCache)),
      TE.map(
        RA.map(
          (enriched) =>
            ({
              ...enriched.original,
              value: enriched.original.value / 10,
              webName: enriched.webName,
              elementTypeName: enriched.elementTypeName,
              elementType: enriched.elementType,
              teamId: enriched.team,
              teamName: enriched.teamName,
              teamShortName: enriched.teamShortName,
              lastValue: enriched.original.lastValue / 10,
            }) as PlayerValue,
        ),
      ),
      TE.map((values) => values as PlayerValues),
    );

export const enrichEventFixtures =
  (teamCache: TeamCache) =>
  (rawFixtures: RawEventFixtures): TE.TaskEither<DomainError, EventFixtures> => {
    if (RA.isEmpty(rawFixtures)) {
      return TE.right([]);
    }

    return pipe(
      teamCache.getAllTeams(),
      TE.map((teams: ReadonlyArray<Team>) => {
        const teamMap = new Map(teams.map((t: Team) => [t.id as number, t]));

        const enrichedFixtures = pipe(
          rawFixtures,
          RA.map((rawFixture: RawEventFixture): O.Option<EventFixture> => {
            const homeTeamOpt = O.fromNullable(teamMap.get(rawFixture.teamH as number));
            const awayTeamOpt = O.fromNullable(teamMap.get(rawFixture.teamA as number));

            return pipe(
              O.Do,
              O.apS('homeTeam', homeTeamOpt),
              O.apS('awayTeam', awayTeamOpt),
              O.map(
                ({ homeTeam, awayTeam }) =>
                  ({
                    ...rawFixture,
                    teamHName: homeTeam.name,
                    teamHShortName: homeTeam.shortName,
                    teamAName: awayTeam.name,
                    teamAShortName: awayTeam.shortName,
                  }) as EventFixture,
              ),
            );
          }),
          RA.compact,
        );

        if (enrichedFixtures.length < rawFixtures.length) {
          console.warn(
            '[enrichEventFixtures] Enrichment resulted in fewer fixtures than input. Check TeamCache integrity.',
          );
        }

        return enrichedFixtures as EventFixtures;
      }),
      TE.mapLeft(
        (domainError): DomainError =>
          createDomainError({
            code: DomainErrorCode.CACHE_ERROR,
            message: 'Failed to retrieve teams from cache for fixture enrichment',
            cause: domainError,
          }),
      ),
    );
  };
