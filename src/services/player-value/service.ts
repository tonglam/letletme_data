import { EventCache } from 'domains/event/types';
import { PlayerCache } from 'domains/player/types';
import { createPlayerValueOperations } from 'domains/player-value/operation';
import { PlayerValueCache, PlayerValueOperations } from 'domains/player-value/types';
import { TeamCache } from 'domains/team/types';
import { pipe, flow } from 'fp-ts/function';
import * as RA from 'fp-ts/ReadonlyArray';
import * as TE from 'fp-ts/TaskEither';
import { PlayerValueService, PlayerValueServiceOperations } from 'services/player-value/types';
import { FplBootstrapDataService } from 'src/data/types';
import { PlayerValueCreateInputs, PlayerValueRepository } from 'src/repositories/player-value/type';
import { ValueChangeType } from 'src/types/base.type';
import { Event } from 'src/types/domain/event.type';
import {
  PlayerValue,
  PlayerValues,
  RawPlayerValue,
  RawPlayerValues,
} from 'src/types/domain/player-value.type';
import { PlayerId } from 'src/types/domain/player.type';
import { TeamId } from 'src/types/domain/team.type';
import {
  createServiceError,
  DataLayerError,
  ServiceError,
  ServiceErrorCode,
} from 'src/types/error.type';
import { enrichPlayerValues } from 'src/utils/data-enrichment.util';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'src/utils/error.util';

const determineChangeType = (newValue: number, lastValue: number): ValueChangeType => {
  if (newValue > lastValue) {
    return ValueChangeType.Rise;
  }
  if (newValue < lastValue) {
    return ValueChangeType.Fall;
  }
  return ValueChangeType.Start;
};

const detectRawValueChanges =
  (domainOps: PlayerValueOperations) =>
  (sourceValues: RawPlayerValues): TE.TaskEither<ServiceError, RawPlayerValues> => {
    if (RA.isEmpty(sourceValues)) {
      return TE.right([]);
    }
    const elementIds = sourceValues.map((value) => value.elementId);
    return pipe(
      domainOps.getLatestPlayerValuesByElements(elementIds),
      TE.mapLeft((error) =>
        createServiceError({
          code: ServiceErrorCode.OPERATION_ERROR,
          message: `Failed to fetch latest player values for change detection: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((latestDbValues) => {
        const latestValueMap = new Map(latestDbValues.map((v) => [v.elementId, v.value]));
        const changes: Array<RawPlayerValue> = [];

        for (const sourceValue of sourceValues) {
          const latestDbValue = latestValueMap.get(sourceValue.elementId);

          if (latestDbValue === undefined || sourceValue.value !== latestDbValue) {
            const lastValue = latestDbValue ?? sourceValue.value;
            const changeType = latestDbValue
              ? determineChangeType(sourceValue.value, latestDbValue)
              : ValueChangeType.Start;
            changes.push({
              ...sourceValue,
              lastValue,
              changeType,
            });
          }
        }
        return changes;
      }),
    );
  };

const addChangeInfoToEnriched =
  (domainOps: PlayerValueOperations) =>
  (enrichedSourceValues: PlayerValues): TE.TaskEither<ServiceError, PlayerValues> => {
    if (RA.isEmpty(enrichedSourceValues)) {
      return TE.right([]);
    }
    const elementIds = enrichedSourceValues.map((v) => v.elementId);
    return pipe(
      domainOps.getLatestPlayerValuesByElements(elementIds),
      TE.mapLeft((error) =>
        createServiceError({
          code: ServiceErrorCode.OPERATION_ERROR,
          message: `Failed to fetch latest player values for adding change info: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((latestDbValues) => {
        const latestValueMap = new Map(latestDbValues.map((v) => [v.elementId, v.value]));
        return enrichedSourceValues.map((enrichedValue): PlayerValue => {
          const latestDbValue = latestValueMap.get(enrichedValue.elementId);
          const lastValue = latestDbValue ?? enrichedValue.value;
          const changeType = latestDbValue
            ? determineChangeType(enrichedValue.value, latestDbValue)
            : ValueChangeType.Start;
          return {
            ...enrichedValue,
            lastValue,
            changeType,
          };
        });
      }),
    );
  };

export const playerValueServiceOperations = (
  fplDataService: FplBootstrapDataService,
  domainOps: PlayerValueOperations,
  playerValueCache: PlayerValueCache,
  eventCache: EventCache,
  teamCache: TeamCache,
  playerCache: PlayerCache,
): PlayerValueServiceOperations => {
  const enrichSourceData = flow(
    enrichPlayerValues(playerCache, teamCache),
    TE.mapLeft(mapDomainErrorToServiceError),
  );

  const detectChanges = detectRawValueChanges(domainOps);

  const addChangeInfo = addChangeInfoToEnriched(domainOps);

  const enrichDetectedChanges = flow(
    (changes: RawPlayerValues) => TE.of(changes as RawPlayerValues),
    TE.chainW(enrichSourceData),
    TE.map((enriched) => enriched as PlayerValues),
  );

  const processSourceToPlayerValues = (
    sourceValues: RawPlayerValues,
  ): TE.TaskEither<ServiceError, PlayerValues> =>
    pipe(
      TE.of(sourceValues),
      TE.chainW(enrichSourceData),
      TE.chainW(addChangeInfo),
      TE.map((playerValues) => {
        const processed = RA.map((pv: PlayerValue) => ({
          ...pv,
          value: pv.value / 10,
        }))(playerValues);
        return processed;
      }),
    );

  const ops: PlayerValueServiceOperations = {
    detectPlayerValueChanges: (): TE.TaskEither<ServiceError, PlayerValues> =>
      TE.left(
        createServiceError({
          code: ServiceErrorCode.OPERATION_ERROR,
          message: 'detectPlayerValueChanges operation needs redefinition or removal.',
        }),
      ),

    findPlayerValuesByChangeDate: (changeDate: string): TE.TaskEither<ServiceError, PlayerValues> =>
      pipe(
        playerValueCache.getPlayerValuesByChangeDate(changeDate),
        TE.mapLeft(mapDomainErrorToServiceError),
        TE.chainW((cachedValues) => {
          if (!RA.isEmpty(cachedValues)) {
            return TE.right(cachedValues);
          }
          return pipe(
            domainOps.getPlayerValuesByChangeDate(changeDate),
            TE.mapLeft(mapDomainErrorToServiceError),
            TE.chainW(processSourceToPlayerValues),
            TE.chainFirstW((processedValues) =>
              pipe(
                playerValueCache.setPlayerValuesByChangeDate(processedValues),
                TE.mapLeft(mapDomainErrorToServiceError),
              ),
            ),
          );
        }),
      ),

    findPlayerValuesByElement: (elementId: PlayerId): TE.TaskEither<ServiceError, PlayerValues> =>
      pipe(
        domainOps.getPlayerValuesByElement(elementId),
        TE.mapLeft(mapDomainErrorToServiceError),
        TE.chainW(processSourceToPlayerValues),
      ),

    findPlayerValuesByTeam: (teamId: TeamId): TE.TaskEither<ServiceError, PlayerValues> =>
      pipe(
        playerCache.getAllPlayers(),
        TE.mapLeft(mapDomainErrorToServiceError),
        TE.map(RA.filter((player) => player.teamId === teamId)),
        TE.map(RA.map((player) => player.id)),
        TE.chainW((readonlyElements) => {
          const mutableElements = [...readonlyElements];
          if (mutableElements.length === 0) {
            return TE.right([]);
          }
          return pipe(
            domainOps.getPlayerValuesByElements(mutableElements),
            TE.mapLeft(mapDomainErrorToServiceError),
          );
        }),
        TE.chainW(processSourceToPlayerValues),
      ),

    syncPlayerValuesFromApi: (): TE.TaskEither<ServiceError, void> =>
      pipe(
        eventCache.getCurrentEvent(),
        TE.mapLeft(mapDomainErrorToServiceError),
        TE.chainW((event: Event) =>
          event
            ? pipe(
                fplDataService.getPlayerValues(event.id),
                TE.mapLeft((error: DataLayerError) =>
                  createServiceIntegrationError({
                    message: 'Failed to fetch player values via data layer',
                    cause: error.cause,
                  }),
                ),
                TE.chainW(detectChanges),
                TE.chainW(enrichDetectedChanges),
                TE.chainW((playerValueChanges: PlayerValues) =>
                  playerValueChanges.length === 0
                    ? TE.right(undefined)
                    : pipe(
                        domainOps.savePlayerValueChanges(
                          playerValueChanges as PlayerValueCreateInputs,
                        ),
                        TE.mapLeft(mapDomainErrorToServiceError),
                        TE.chainW(() => {
                          return pipe(
                            playerValueCache.setPlayerValuesByChangeDate(playerValueChanges),
                            TE.mapLeft(mapDomainErrorToServiceError),
                          );
                        }),
                      ),
                ),
              )
            : TE.left(
                createServiceError({
                  code: ServiceErrorCode.OPERATION_ERROR,
                  message: 'No current event found to sync player values for.',
                }),
              ),
        ),
      ),
  };

  return ops;
};

export const createPlayerValueService = (
  fplDataService: FplBootstrapDataService,
  repository: PlayerValueRepository,
  playerValueCache: PlayerValueCache,
  eventCache: EventCache,
  teamCache: TeamCache,
  playerCache: PlayerCache,
): PlayerValueService => {
  const domainOps = createPlayerValueOperations(repository);
  const ops = playerValueServiceOperations(
    fplDataService,
    domainOps,
    playerValueCache,
    eventCache,
    teamCache,
    playerCache,
  );

  return {
    getPlayerValuesByChangeDate: ops.findPlayerValuesByChangeDate,
    getPlayerValuesByElement: ops.findPlayerValuesByElement,
    getPlayerValuesByTeam: ops.findPlayerValuesByTeam,
    syncPlayerValuesFromApi: ops.syncPlayerValuesFromApi,
  };
};
