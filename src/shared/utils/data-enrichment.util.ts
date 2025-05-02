import { EntryInfoRepository } from '@app/infrastructure/persistence/drizzle/repository/entry-info/types';
import { PlayerCache } from '@app/old-domain/player/types';
import { TeamCache } from '@app/old-domain/team/types';
import { ElementTypeId, ElementTypeName, ElementTypeNames } from '@app/shared/types/base.types';
import {
  EntryEventPick,
  EntryEventPicks,
  PickItem,
  RawEntryEventPick,
  RawEntryEventPicks,
  RawPickItem,
} from '@app/shared/types/domain/entry-event-pick.type';
import {
  EntryEventResult,
  EntryEventResults,
  RawEntryEventResult,
  RawEntryEventResults,
} from '@app/shared/types/domain/entry-event-result.type';
import {
  EntryEventTransfer,
  EntryEventTransfers,
  RawEntryEventTransfer,
  RawEntryEventTransfers,
} from '@app/shared/types/domain/entry-event-transfer.type';
import { EntryId, EntryInfo } from '@app/shared/types/domain/entry-info.type';
import {
  EventFixture,
  EventFixtures,
  RawEventFixture,
  RawEventFixtures,
} from '@app/shared/types/domain/event-fixture.type';
import { EventLive, EventLives, RawEventLives } from '@app/shared/types/domain/event-live.type';
import {
  EventOverallResult,
  RawEventOverallResult,
} from '@app/shared/types/domain/event-overall-result.type';
import { PlayerStat, PlayerStats, RawPlayerStat } from '@app/shared/types/domain/player-stat.type';
import {
  PlayerValue,
  PlayerValues,
  RawPlayerValue,
} from '@app/shared/types/domain/player-value.type';
import { Player, Players, RawPlayers } from '@app/shared/types/domain/player.type';
import { Team, TeamId } from '@app/shared/types/domain/team.type';
import { CacheError, CacheErrorCode, createCacheError } from '@app/shared/types/error.types';
import * as Eq from 'fp-ts/Eq';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as RA from 'fp-ts/ReadonlyArray';
import * as RNEA from 'fp-ts/ReadonlyNonEmptyArray';
import * as TE from 'fp-ts/TaskEither';

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
  ): TE.TaskEither<CacheError, ReadonlyArray<EnrichedWithElementType<T>>> => {
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
                  elementTypeName: ElementTypeNames[elementType],
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
  (items: ReadonlyArray<T>): TE.TaskEither<CacheError, ReadonlyArray<EnrichedWithTeam<T>>> => {
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
  (rawPlayers: RawPlayers): TE.TaskEither<CacheError, Players> => {
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
  (sourceStats: ReadonlyArray<RawPlayerStat>): TE.TaskEither<CacheError, PlayerStats> =>
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
  (sourceStat: RawPlayerStat): TE.TaskEither<CacheError, PlayerStat> =>
    pipe(
      TE.of([sourceStat]),
      TE.chain(enrichPlayerStats(playerCache, teamCache)),
      TE.chainOptionK(() =>
        createCacheError({
          code: CacheErrorCode.NOT_FOUND,
          message:
            'Enrichment resulted in an empty array for a single item, likely missing Player or Team data.',
        }),
      )(RNEA.fromReadonlyArray),
      TE.map(RNEA.head),
    );

export const enrichPlayerValues =
  (playerCache: PlayerCache, teamCache: TeamCache) =>
  (sourceValues: ReadonlyArray<RawPlayerValue>): TE.TaskEither<CacheError, PlayerValues> =>
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
  (rawFixtures: RawEventFixtures): TE.TaskEither<CacheError, EventFixtures> => {
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
            const homeTeamOpt = O.fromNullable(teamMap.get(rawFixture.teamHId as TeamId));
            const awayTeamOpt = O.fromNullable(teamMap.get(rawFixture.teamAId as TeamId));

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

        return enrichedFixtures as EventFixtures;
      }),
      TE.mapLeft(
        (cacheError): CacheError =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to retrieve teams from cache for fixture enrichment',
            cause: cacheError,
          }),
      ),
    );
  };

export const enrichEventLives =
  (playerCache: PlayerCache, teamCache: TeamCache) =>
  (rawEventLives: RawEventLives): TE.TaskEither<CacheError, EventLives> => {
    if (RA.isEmpty(rawEventLives)) {
      return TE.right([]);
    }

    return pipe(
      playerCache.getAllPlayers(),
      TE.bindTo('players'),
      TE.bind('teams', () => teamCache.getAllTeams()),
      TE.map(({ players, teams }) => {
        const playerMap = new Map(players.map((p) => [p.id as number, p]));
        const teamMap = new Map(teams.map((t) => [t.id as number, t]));

        const enrichedItems = pipe(
          rawEventLives,
          RA.map((rawEventLive) => {
            const elementId = rawEventLive.elementId as number;
            const playerOpt = O.fromNullable(playerMap.get(elementId));
            const teamOpt: O.Option<Team> = pipe(
              playerOpt,
              O.chain((p: Player) => O.fromNullable(teamMap.get(p.teamId as number))),
            );
            return pipe(
              O.Do,
              O.bind('player', () => playerOpt),
              O.bind('team', () => teamOpt),
              O.map(
                ({ player, team }): EventLive => ({
                  ...rawEventLive,
                  webName: player.webName,
                  elementType: player.type as ElementTypeId,
                  elementTypeName: ElementTypeNames[player.type as ElementTypeId],
                  value: player.price,
                  teamId: team.id,
                  teamName: team.name,
                  teamShortName: team.shortName,
                }),
              ),
            );
          }),
          RA.compact,
        );

        return enrichedItems;
      }),
      TE.mapLeft(
        (error): CacheError =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to retrieve players or teams from cache for event live enrichment',
            cause: error,
          }),
      ),
    );
  };

export const enrichEntryEventPick =
  (playerCache: PlayerCache, teamCache: TeamCache, entryInfoRepository: EntryInfoRepository) =>
  (rawPick: RawEntryEventPick): TE.TaskEither<CacheError, EntryEventPick> =>
    pipe(
      entryInfoRepository.findById(rawPick.entryId),
      TE.mapLeft(
        (dbError): CacheError =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: `Failed to fetch entry info for enrichment: ${rawPick.entryId}`,
            cause: dbError,
          }),
      ),
      TE.chainW((entryInfo) =>
        pipe(
          playerCache.getAllPlayers(),
          TE.bindTo('players'),
          TE.bind('teams', () => teamCache.getAllTeams()),
          TE.map(({ players, teams }) => {
            const playerMap = new Map(players.map((p) => [p.id as number, p]));
            const teamMap = new Map(teams.map((t) => [t.id as number, t]));

            const enrichedPicks = pipe(
              rawPick.picks,
              RA.map((rawPickItem: RawPickItem): O.Option<PickItem> => {
                const playerOpt = O.fromNullable(playerMap.get(rawPickItem.elementId as number));
                return pipe(
                  playerOpt,
                  O.chain((player) => {
                    const teamOpt = O.fromNullable(teamMap.get(player.teamId as number));
                    const elementType = player.type as ElementTypeId;
                    return pipe(
                      teamOpt,
                      O.map(
                        (team): PickItem => ({
                          ...rawPickItem,
                          elementType: elementType,
                          elementTypeName: ElementTypeNames[elementType],
                          teamId: team.id,
                          teamName: team.name,
                          teamShortName: team.shortName,
                          webName: player.webName,
                          value: player.price,
                        }),
                      ),
                    );
                  }),
                );
              }),
              RA.compact,
            );

            return {
              ...rawPick,
              entryName: entryInfo.entryName,
              picks: enrichedPicks,
            } as EntryEventPick;
          }),
          TE.mapLeft(
            (cacheError): CacheError =>
              createCacheError({
                code: CacheErrorCode.OPERATION_ERROR,
                message: 'Failed to retrieve players or teams from cache for pick enrichment',
                cause: cacheError,
              }),
          ),
        ),
      ),
    );

export const enrichEntryEventPicks =
  (playerCache: PlayerCache, teamCache: TeamCache, entryInfoRepository: EntryInfoRepository) =>
  (rawPicks: RawEntryEventPicks): TE.TaskEither<CacheError, EntryEventPicks> =>
    pipe(
      rawPicks,
      RA.traverse(TE.ApplicativePar)(
        enrichEntryEventPick(playerCache, teamCache, entryInfoRepository),
      ),
    );

export const enrichEntryEventTransfer =
  (playerCache: PlayerCache, teamCache: TeamCache, entryInfoRepository: EntryInfoRepository) =>
  (rawTransfer: RawEntryEventTransfer): TE.TaskEither<CacheError, EntryEventTransfer> =>
    pipe(
      TE.Do,
      TE.bind('entryInfo', () =>
        pipe(
          entryInfoRepository.findById(rawTransfer.entryId),
          TE.mapLeft(
            (dbError): CacheError =>
              createCacheError({
                code: CacheErrorCode.OPERATION_ERROR,
                message: `Failed to fetch entry info for transfer enrichment: ${rawTransfer.entryId}`,
                cause: dbError,
              }),
          ),
        ),
      ),
      TE.bind('players', () => playerCache.getAllPlayers()),
      TE.bind('teams', () => teamCache.getAllTeams()),
      TE.chainW(({ entryInfo, players, teams }) => {
        const playerMap = new Map(players.map((p) => [p.id as number, p]));
        const teamMap = new Map(teams.map((t) => [t.id as number, t]));

        const getPlayerData = (elementId: number) => {
          const playerOpt = O.fromNullable(playerMap.get(elementId));
          return pipe(
            playerOpt,
            O.chain((player) => {
              const teamOpt = O.fromNullable(teamMap.get(player.teamId as number));
              const elementType = player.type as ElementTypeId;
              return pipe(
                teamOpt,
                O.map((team) => ({
                  webName: player.webName,
                  elementType: elementType,
                  elementTypeName: ElementTypeNames[elementType],
                  teamId: team.id,
                  teamName: team.name,
                  teamShortName: team.shortName,
                  value: player.price,
                  points: 0,
                })),
              );
            }),
          );
        };

        const elementInDataOpt = getPlayerData(rawTransfer.elementInId as number);
        const elementOutDataOpt = getPlayerData(rawTransfer.elementOutId as number);

        return pipe(
          O.Do,
          O.apS('elementInData', elementInDataOpt),
          O.apS('elementOutData', elementOutDataOpt),
          TE.fromOption(() =>
            createCacheError({
              code: CacheErrorCode.NOT_FOUND,
              message: 'Could not find player or team data for transfer elements',
            }),
          ),
          TE.map(
            ({ elementInData, elementOutData }): EntryEventTransfer => ({
              ...rawTransfer,
              entryName: entryInfo.entryName,
              elementInWebName: elementInData.webName,
              elementInType: elementInData.elementType,
              elementInTypeName: elementInData.elementTypeName,
              elementInTeamId: elementInData.teamId,
              elementInTeamName: elementInData.teamName,
              elementInTeamShortName: elementInData.teamShortName,
              elementInPoints: elementInData.points,
              elementOutWebName: elementOutData.webName,
              elementOutType: elementOutData.elementType,
              elementOutTypeName: elementOutData.elementTypeName,
              elementOutTeamId: elementOutData.teamId,
              elementOutTeamName: elementOutData.teamName,
              elementOutTeamShortName: elementOutData.teamShortName,
              elementOutPoints: elementOutData.points,
            }),
          ),
        );
      }),
      TE.mapLeft((error) =>
        error.code === CacheErrorCode.OPERATION_ERROR || error.code === CacheErrorCode.NOT_FOUND
          ? error
          : createCacheError({
              code: CacheErrorCode.OPERATION_ERROR,
              message: 'Failed to retrieve players or teams from cache for transfer enrichment',
              cause: error,
            }),
      ),
    );

export const enrichEntryEventTransfers =
  (playerCache: PlayerCache, teamCache: TeamCache, entryInfoRepository: EntryInfoRepository) =>
  (rawTransfers: RawEntryEventTransfers): TE.TaskEither<CacheError, EntryEventTransfers> =>
    pipe(
      rawTransfers,
      RA.traverse(TE.ApplicativePar)(
        enrichEntryEventTransfer(playerCache, teamCache, entryInfoRepository),
      ),
    );

const combineRawResultAndEntryInfo = (
  rawResult: RawEntryEventResult,
  entryInfo: EntryInfo,
): EntryEventResult => ({
  ...rawResult,
  entryName: entryInfo.entryName,
  playerName: entryInfo.playerName,
});

export const enrichEntryEventResults =
  (entryInfoRepository: EntryInfoRepository) =>
  (
    rawInput: RawEntryEventResult | RawEntryEventResults,
  ): TE.TaskEither<CacheError, EntryEventResult | EntryEventResults> => {
    if (!Array.isArray(rawInput)) {
      const rawResult = rawInput as RawEntryEventResult;
      return pipe(
        entryInfoRepository.findById(rawResult.entryId),
        TE.mapLeft(
          (dbError): CacheError =>
            createCacheError({
              code: CacheErrorCode.OPERATION_ERROR,
              message: `Failed to fetch entry info for event result enrichment: ${rawResult.entryId}`,
              cause: dbError,
            }),
        ),
        TE.chainOptionK(() =>
          createCacheError({
            code: CacheErrorCode.NOT_FOUND,
            message: `EntryInfo not found for entry ID: ${rawResult.entryId}`,
          }),
        )((entryInfo) => O.fromNullable(entryInfo)),
        TE.map((entryInfo) => combineRawResultAndEntryInfo(rawResult, entryInfo)),
      );
    }

    const rawResults = rawInput as RawEntryEventResults;
    if (RA.isEmpty(rawResults)) {
      return TE.right([]);
    }

    const entryIds = pipe(
      rawResults,
      RA.map((r) => r.entryId),
      RA.uniq(Eq.eqNumber as Eq.Eq<EntryId>),
    );

    return pipe(
      entryInfoRepository.findByIds(entryIds),
      TE.mapLeft(
        (dbError): CacheError =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to fetch entry info for event result enrichment',
            cause: dbError,
          }),
      ),
      TE.map((entryInfos) => {
        const entryInfoMap = new Map(entryInfos.map((info: EntryInfo) => [info.id, info]));
        const enrichedResults = pipe(
          rawResults,
          RA.map(
            (rawResultItem: RawEntryEventResult): O.Option<EntryEventResult> =>
              pipe(
                O.fromNullable(entryInfoMap.get(rawResultItem.entryId)),
                O.map((entryInfo) => combineRawResultAndEntryInfo(rawResultItem, entryInfo)),
              ),
          ),
          RA.compact,
        );

        if (enrichedResults.length < rawResults.length) {
          console.warn(
            '[enrichEntryEventResults] Enrichment dropped some results due to missing EntryInfo. Check EntryInfoRepository integrity.',
          );
        }

        return enrichedResults as EntryEventResults;
      }),
    );
  };

export const enrichEventOverallResult =
  (playerCache: PlayerCache) =>
  (rawResult: RawEventOverallResult): TE.TaskEither<CacheError, EventOverallResult> => {
    return pipe(
      playerCache.getAllPlayers(),
      TE.mapLeft((cacheError: CacheError) =>
        createCacheError({
          code: CacheErrorCode.OPERATION_ERROR,
          message: 'Failed to retrieve players from cache for event overall result enrichment',
          cause: cacheError,
        }),
      ),
      TE.map((players: ReadonlyArray<Player>) => {
        const playerMap = new Map(players.map((p: Player) => [p.id as number, p]));
        const getWebName = (id: number): string => playerMap.get(id)?.webName ?? 'N/A';

        return {
          ...rawResult,
          mostSelectedWebName: getWebName(rawResult.mostSelected),
          mostTransferredInWebName: getWebName(rawResult.mostTransferredIn),
          mostCaptainedWebName: getWebName(rawResult.mostCaptained),
          mostViceCaptainedWebName: getWebName(rawResult.mostViceCaptained),
        } as EventOverallResult;
      }),
    );
  };
