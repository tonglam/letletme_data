import { PlayerCache } from 'domains/player/types';
import { TeamCache } from 'domains/team/types';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as RA from 'fp-ts/ReadonlyArray';
import * as RNEA from 'fp-ts/ReadonlyNonEmptyArray';
import * as TE from 'fp-ts/TaskEither';
import { ElementTypeId, ElementTypeName, getElementTypeName } from 'src/types/base.type';
import { PlayerStat, PlayerStats, SourcePlayerStat } from 'src/types/domain/player-stat.type';
import { PlayerValues, SourcePlayerValue } from 'src/types/domain/player-value.type';
import { Player } from 'src/types/domain/player.type';
import { Team, TeamId } from 'src/types/domain/team.type';
import { createDomainError, DomainError, DomainErrorCode } from 'src/types/error.type';

type HasElement = { element: number };

type EnrichedWithElementType<T extends HasElement> = T & {
  elementTypeName: ElementTypeName;
};

type EnrichedWithTeam<T extends HasElement> = T & {
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
        const playerMap = new Map(players.map((p) => [p.element as number, p]));
        return pipe(
          items,
          RA.map((item): EnrichedWithElementType<T> => {
            const playerOpt = O.fromNullable(playerMap.get(item.element));
            const elementType = pipe(
              playerOpt,
              O.map((p) => p.elementType as ElementTypeId),
              O.getOrElse(() => ElementTypeId.FORWARD),
            );
            return {
              ...item,
              elementTypeName: getElementTypeName(elementType),
            };
          }),
        );
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
        const playerMap = new Map(players.map((p) => [p.element as number, p]));
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
              O.chain((p: Player) => O.fromNullable(teamMap.get(p.team as number))),
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

        if (enrichedItems.length !== items.length) {
          console.warn(
            `enrichWithTeam: ${items.length - enrichedItems.length} items could not be enriched with team data.`,
          );
        }

        return TE.right(enrichedItems as ReadonlyArray<EnrichedWithTeam<T>>);
      }),
    );
  };

export const enrichPlayerStats =
  (playerCache: PlayerCache, teamCache: TeamCache) =>
  (sourceStats: ReadonlyArray<SourcePlayerStat>): TE.TaskEither<DomainError, PlayerStats> =>
    pipe(
      sourceStats,
      enrichWithElementType(playerCache),
      TE.chain(enrichWithTeam(playerCache, teamCache)),
      TE.map((enrichedStats) => enrichedStats as PlayerStats),
    );

export const enrichPlayerStat =
  (playerCache: PlayerCache, teamCache: TeamCache) =>
  (sourceStat: SourcePlayerStat): TE.TaskEither<DomainError, PlayerStat> =>
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
  (sourceValues: ReadonlyArray<SourcePlayerValue>): TE.TaskEither<DomainError, PlayerValues> =>
    pipe(
      sourceValues,
      enrichWithElementType(playerCache),
      TE.chain(enrichWithTeam(playerCache, teamCache)),
      TE.map((enrichedValues) => enrichedValues as PlayerValues),
    );
