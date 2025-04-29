import { EventCache } from 'domain/event/types';
import { PlayerCache } from 'domain/player/types';
import { createPlayerValueOperations } from 'domain/player-value/operation';
import { PlayerValueCache, PlayerValueOperations } from 'domain/player-value/types';
import { TeamCache } from 'domain/team/types';

import { FplBootstrapDataService } from 'data/types';
import { pipe, flow } from 'fp-ts/function';
import * as IO from 'fp-ts/IO';
import * as RA from 'fp-ts/ReadonlyArray';
import * as TE from 'fp-ts/TaskEither';
import { PlayerValueRepository } from 'repository/player-value/types';
import { PlayerValueService, PlayerValueServiceOperations } from 'service/player-value/types';
import { ValueChangeTypes } from 'types/base.type';
import {
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

import { getWorkflowLogger } from '../../infrastructure/logger';
import { DomainError } from '../../types/error.type';

const detectRawValueChanges =
  (domainOps: PlayerValueOperations) =>
  (sourceValues: SourcePlayerValues): TE.TaskEither<ServiceError, RawPlayerValues> => {
    if (RA.isEmpty(sourceValues)) {
      return TE.right([]);
    }
    const elementIds = sourceValues.map((value) => value.elementId);

    const logFetchStart: IO.IO<void> = () =>
      getWorkflowLogger().info(
        { count: elementIds.length },
        'detectRawValueChanges: Fetching latest values from DB',
      );

    return pipe(
      TE.fromIO(logFetchStart),
      TE.chainW(() => domainOps.getLatestPlayerValuesByElements(elementIds)),
      TE.tapError((error: DomainError) =>
        TE.fromIO(() =>
          getWorkflowLogger().error({ err: error }, 'detectRawValueChanges: Failed DB fetch'),
        ),
      ),
      TE.mapLeft((error) =>
        createServiceError({
          code: ServiceErrorCode.OPERATION_ERROR,
          message: `Failed to fetch latest player values for change detection: ${error.message}`,
          cause: error,
        }),
      ),
      TE.chainW((latestDbValues) =>
        pipe(
          TE.fromIO(() =>
            getWorkflowLogger().info(
              { count: latestDbValues.length },
              'detectRawValueChanges: Successfully fetched latest values',
            ),
          ),
          TE.map(() => {
            const dbValuesTyped = latestDbValues as ReadonlyArray<{
              elementId: PlayerId;
              value: number;
            }>;
            const latestValueMap = new Map(dbValuesTyped.map((v) => [v.elementId, v.value]));
            const changes: Array<RawPlayerValue> = [];

            for (const sourceValue of sourceValues) {
              const latestDbValueNum = latestValueMap.get(sourceValue.elementId);

              if (latestDbValueNum === undefined) {
                changes.push({
                  ...sourceValue,
                  lastValue: 0,
                  changeType: ValueChangeTypes[0], // 'start'
                });
              } else if (sourceValue.value !== latestDbValueNum) {
                const changeType =
                  sourceValue.value > latestDbValueNum
                    ? ValueChangeTypes[1] // 'rise'
                    : ValueChangeTypes[2]; // 'fall'
                changes.push({
                  ...sourceValue,
                  lastValue: latestDbValueNum,
                  changeType: changeType,
                });
              }
            }
            return changes;
          }),
        ),
      ),
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

  const processSourceToPlayerValues = (
    sourceValues: RawPlayerValues,
  ): TE.TaskEither<ServiceError, PlayerValues> =>
    pipe(TE.of(sourceValues), TE.chainW(enrichSourceData));

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
        TE.tapError((err: ServiceError) =>
          TE.fromIO(() => getWorkflowLogger().error({ err }, 'sync: Step 1 FAILED')),
        ),
        TE.chainFirstW((_currentEvent) =>
          TE.fromIO(() => getWorkflowLogger().info('sync: Step 1 DONE')),
        ),
        TE.chainW((currentEvent) =>
          pipe(
            fplDataService.getPlayerValues(currentEvent.id),
            TE.mapLeft((error: DataLayerError) =>
              createServiceIntegrationError({
                message: 'Failed to fetch source player values',
                cause: error.cause,
                details: error.details,
              }),
            ),
          ),
        ),
        TE.tapError((err: ServiceError) =>
          TE.fromIO(() => getWorkflowLogger().error({ err }, 'sync: Step 2 FAILED')),
        ),
        TE.chainFirstW((_sourceValues) =>
          TE.fromIO(() => getWorkflowLogger().info('sync: Step 2 DONE')),
        ),

        TE.chainW((sourceValues) => detectChanges(sourceValues)),
        TE.tapError((err: ServiceError) =>
          TE.fromIO(() => getWorkflowLogger().error({ err }, 'sync: Step 3 FAILED')),
        ),
        TE.chainFirstW((_changes) =>
          TE.fromIO(() => getWorkflowLogger().info('sync: Step 3 DONE')),
        ),

        // Step 4: Save Changes - Input should be RawPlayerValues from Step 3
        TE.chainW((changes: RawPlayerValues) => {
          const logSaveStart: IO.IO<void> = () =>
            getWorkflowLogger().info(
              { count: changes.length },
              'sync: Step 4 START - Saving changes',
            );
          if (RA.isEmpty(changes)) {
            return pipe(
              TE.fromIO(logSaveStart),
              TE.chainW(() =>
                TE.fromIO(() => getWorkflowLogger().info('sync: Step 4 - No changes to save.')),
              ),
              TE.map(() => changes), // Pass empty changes array along
            );
          }

          const logSaveCall: IO.IO<void> = () =>
            getWorkflowLogger().info('sync: Step 4 - Calling savePlayerValueChanges...');
          return pipe(
            TE.fromIO(logSaveStart),
            TE.chainW(() => TE.fromIO(logSaveCall)),
            // Pass changes directly, as RawPlayerValues is compatible with PlayerValueCreateInputs
            TE.chainW(() => domainOps.savePlayerValueChanges(changes)),
            TE.mapLeft(mapDomainErrorToServiceError), // Map DomainError to ServiceError
            // Assume savePlayerValueChanges returns the saved RawPlayerValues
            TE.map((savedResult) => savedResult as RawPlayerValues), // Ensure type consistency for next step
          );
        }),
        TE.tapError(
          (
            err: ServiceError, // Type is ServiceError
          ) => TE.fromIO(() => getWorkflowLogger().error({ err }, 'sync: Step 4 FAILED')),
        ),
        TE.chainFirstW(
          (
            savedChanges: RawPlayerValues, // savedChanges is RawPlayerValues
          ) =>
            TE.fromIO(() =>
              getWorkflowLogger().info({ count: savedChanges.length }, 'sync: Step 4 DONE'),
            ),
        ),

        // Step 5: Enrich Data - Input is RawPlayerValues from Step 4
        TE.chainW((savedChanges: RawPlayerValues) => {
          // savedChanges is RawPlayerValues
          const logEnrichStart: IO.IO<void> = () =>
            getWorkflowLogger().info(
              { count: savedChanges.length },
              'sync: Step 5 START - Enriching saved changes',
            );
          return pipe(
            TE.fromIO(logEnrichStart),
            // enrichSourceData expects RawPlayerValues and returns PlayerValues
            TE.chainW(() => enrichSourceData(savedChanges)), // Returns TaskEither<ServiceError, PlayerValues>
          );
        }),
        TE.tapError(
          (
            err: ServiceError, // Type is ServiceError
          ) => TE.fromIO(() => getWorkflowLogger().error({ err }, 'sync: Step 5 FAILED')),
        ),
        TE.chainFirstW(
          (
            enrichedValues: PlayerValues, // enrichedValues is PlayerValues
          ) =>
            TE.fromIO(() =>
              getWorkflowLogger().info({ count: enrichedValues.length }, 'sync: Step 5 DONE'),
            ),
        ),

        // Step 7: Update Cache - Input is PlayerValues from Step 5
        TE.chainW((processedValues: PlayerValues) => {
          // processedValues is PlayerValues
          const logCacheStart: IO.IO<void> = () =>
            getWorkflowLogger().info(
              { count: processedValues.length },
              'sync: Step 7 START - Updating cache',
            );
          if (RA.isEmpty(processedValues)) {
            return pipe(
              TE.fromIO(logCacheStart),
              TE.chainW(() =>
                TE.fromIO(() =>
                  getWorkflowLogger().info('sync: Step 7 - No processed values to cache.'),
                ),
              ),
              TE.map(() => undefined), // Return undefined for void
            );
          }
          const logCacheCall: IO.IO<void> = () =>
            getWorkflowLogger().info('sync: Step 7 - Calling setPlayerValuesByChangeDate...');
          return pipe(
            TE.fromIO(logCacheStart),
            TE.chainW(() => TE.fromIO(logCacheCall)),
            TE.chainW(() => playerValueCache.setPlayerValuesByChangeDate(processedValues)), // Returns TaskEither<DomainError, void>
            TE.mapLeft(mapDomainErrorToServiceError), // Map DomainError to ServiceError
          );
        }),
        TE.tapError(
          (
            err: ServiceError, // Type is ServiceError
          ) => TE.fromIO(() => getWorkflowLogger().error({ err }, 'sync: Step 7 FAILED')),
        ),
        TE.chainFirstW(() => TE.fromIO(() => getWorkflowLogger().info('sync: Step 7 DONE'))),

        // Final Step - Map the result of the last active step (Step 7: Cache result) to void
        TE.map((_cacheResult) => {
          // _cacheResult is likely void | undefined
          getWorkflowLogger().info('sync: COMPLETED SUCCESSFULLY'); // Changed log message
          return undefined; // Return void
        }),
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
