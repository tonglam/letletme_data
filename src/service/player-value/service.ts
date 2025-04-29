import { EventCache } from 'domain/event/types';
import { PlayerCache } from 'domain/player/types';
import { createPlayerValueOperations } from 'domain/player-value/operation';
import { PlayerValueCache, PlayerValueOperations } from 'domain/player-value/types';
import { TeamCache } from 'domain/team/types';

import { FplBootstrapDataService } from 'data/types';
import { pipe, flow } from 'fp-ts/function';
import * as RA from 'fp-ts/ReadonlyArray';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructure/logger';
import { PlayerValueRepository, PlayerValueCreateInputs } from 'repository/player-value/types';
import { PlayerValueService, PlayerValueServiceOperations } from 'service/player-value/types';
import { ValueChangeType, ValueChangeTypes } from 'types/base.type';
import {
  PlayerValue,
  PlayerValues,
  RawPlayerValue,
  RawPlayerValues,
  SourcePlayerValues,
} from 'types/domain/player-value.type';
import { PlayerId } from 'types/domain/player.type';
import { TeamId } from 'types/domain/team.type';
import {
  createServiceError,
  DataLayerError,
  ServiceError,
  ServiceErrorCode,
} from 'types/error.type';
import { enrichPlayerValues } from 'utils/data-enrichment.util';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'utils/error.util';

const workflowLogger = getWorkflowLogger();

const determineChangeType = (newValue: number, lastValue: number): ValueChangeType => {
  if (newValue > lastValue) {
    return ValueChangeTypes[0];
  }
  if (newValue < lastValue) {
    return ValueChangeTypes[1];
  }
  return ValueChangeTypes[2];
};

const detectRawValueChanges =
  (domainOps: PlayerValueOperations) =>
  (sourceValues: SourcePlayerValues): TE.TaskEither<ServiceError, RawPlayerValues> => {
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
              : ValueChangeTypes[2];
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
            : ValueChangeTypes[2];
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

  const processSourceToPlayerValues = (
    sourceValues: RawPlayerValues,
  ): TE.TaskEither<ServiceError, PlayerValues> =>
    pipe(TE.of(sourceValues), TE.chainW(enrichSourceData), TE.chainW(addChangeInfo));

  const ops: PlayerValueServiceOperations = {
    detectPlayerValueChanges: (): TE.TaskEither<ServiceError, PlayerValues> =>
      TE.left(
        createServiceError({
          code: ServiceErrorCode.OPERATION_ERROR,
          message:
            'detectPlayerValueChanges needs redefinition or removal. Use syncPlayerValuesFromApi logic.',
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
        TE.chainW((elementIds) => {
          const mutableElements = [...elementIds];
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
        TE.tapError((err) =>
          TE.fromIO(() => workflowLogger.error({ err }, 'Error getting current event')),
        ),
        TE.chainW((currentEvent) => {
          workflowLogger.info({ eventId: currentEvent.id }, 'Current event fetched successfully');
          return pipe(
            fplDataService.getPlayerValues(currentEvent.id),
            TE.mapLeft((error: DataLayerError) =>
              createServiceIntegrationError({
                message: 'Failed to fetch source player values',
                cause: error.cause,
                details: error.details,
              }),
            ),
          );
        }),
        TE.tapError((err) =>
          TE.fromIO(() => workflowLogger.error({ err }, 'Error fetching source player values')),
        ),
        TE.chainW((sourceValues) => {
          workflowLogger.info(
            { count: sourceValues.length },
            'Source values fetched, detecting changes...',
          );
          return pipe(detectChanges(sourceValues));
        }),
        TE.tapError((err) =>
          TE.fromIO(() => workflowLogger.error({ err }, 'Error detecting value changes')),
        ),
        TE.chainFirstW((changes) =>
          TE.fromIO(() =>
            workflowLogger.info({ count: changes.length }, 'Changes detected, saving...'),
          ),
        ),
        TE.chainW((changes: RawPlayerValues) => {
          if (RA.isEmpty(changes)) {
            workflowLogger.info('No value changes to save.');
            return TE.right([]);
          }

          const keySet = new Set<string>();
          const duplicates = changes.filter((c) => {
            const key = `${c.elementId}-${c.changeDate}`;
            if (keySet.has(key)) return true;
            keySet.add(key);
            return false;
          });
          if (duplicates.length > 0) {
            workflowLogger.error(
              { duplicates },
              'Duplicate (elementId, changeDate) pairs detected in changes before saving!',
            );
          }

          return pipe(
            domainOps.savePlayerValueChanges(changes as PlayerValueCreateInputs),
            TE.mapLeft(mapDomainErrorToServiceError),
          );
        }),
        TE.tapError((err) =>
          TE.fromIO(() => workflowLogger.error({ err }, 'Error saving value changes')),
        ),
        TE.chainW((savedChanges) => {
          workflowLogger.info({ count: savedChanges.length }, 'Changes saved, enriching...');
          return pipe(enrichSourceData(savedChanges));
        }),
        TE.tapError((err) =>
          TE.fromIO(() => workflowLogger.error({ err }, 'Error enriching saved changes')),
        ),
        TE.chainW((enrichedValues) => {
          workflowLogger.info(
            { count: enrichedValues.length },
            'Changes enriched, adding change info...',
          );
          return pipe(addChangeInfo(enrichedValues));
        }),
        TE.tapError((err) =>
          TE.fromIO(() => workflowLogger.error({ err }, 'Error adding change info')),
        ),
        TE.chainW((processedValues) => {
          workflowLogger.info(
            { count: processedValues.length },
            'Processing complete, updating cache...',
          );
          if (RA.isEmpty(processedValues)) {
            workflowLogger.info('No processed values to cache.');
            return TE.right(undefined);
          }
          return pipe(
            playerValueCache.setPlayerValuesByChangeDate(processedValues),
            TE.mapLeft(mapDomainErrorToServiceError),
          );
        }),
        TE.tapError((err) =>
          TE.fromIO(() => workflowLogger.error({ err }, 'Error updating cache')),
        ),
        TE.map(() => undefined),
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
