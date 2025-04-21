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
import { PlayerValueRepository } from 'src/repositories/player-value/type';
import { ValueChangeType } from 'src/types/base.type';
import { PlayerValue, PlayerValues, PlayerValueChanges } from 'src/types/domain/player-value.type';
import { createServiceError, ServiceError, ServiceErrorCode } from 'src/types/error.type';
import { enrichPlayerValues, EnrichedSourcePlayerValue } from 'src/utils/data-enrichment.util';
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

const detectAndCalculateValueChanges =
  (domainOps: PlayerValueOperations) =>
  (
    enrichedValues: ReadonlyArray<EnrichedSourcePlayerValue>,
  ): TE.TaskEither<ServiceError, ReadonlyArray<PlayerValue>> => {
    if (RA.isEmpty(enrichedValues)) {
      return TE.right([]);
    }
    const elements = enrichedValues.map((value) => value.element);
    return pipe(
      domainOps.getPlayerValuesByElements(elements),
      TE.mapLeft((error) =>
        createServiceError({
          code: ServiceErrorCode.OPERATION_ERROR,
          message: `Failed to fetch existing player values for change detection: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((currentValues) => {
        const currentValueMap = new Map(currentValues.map((value) => [value.element, value]));
        const processedValues = enrichedValues.map((enrichedValue): PlayerValue => {
          const currentValue = currentValueMap.get(enrichedValue.element);
          const lastValue = currentValue?.value ?? enrichedValue.value;
          const changeType = currentValue
            ? determineChangeType(enrichedValue.value, lastValue)
            : ValueChangeType.Start;
          return {
            ...enrichedValue,
            lastValue,
            changeType,
          };
        });
        return processedValues.filter(
          (value) =>
            !currentValueMap.has(value.element) ||
            value.value !== currentValueMap.get(value.element)?.value,
        ) as ReadonlyArray<PlayerValue>;
      }),
    );
  };

const mapToPlayerValues = (
  enrichedValues: ReadonlyArray<EnrichedSourcePlayerValue>,
): ReadonlyArray<PlayerValue> => {
  return enrichedValues.map((enrichedValue) => ({
    ...enrichedValue,
    lastValue: enrichedValue.value,
    changeType: ValueChangeType.Start,
  }));
};

export const playerValueServiceOperations = (
  fplDataService: FplBootstrapDataService,
  domainOps: PlayerValueOperations,
  playerValueCache: PlayerValueCache,
  eventCache: EventCache,
  teamCache: TeamCache,
  playerCache: PlayerCache,
): PlayerValueServiceOperations => {
  const enrichSourceValues = flow(
    enrichPlayerValues(playerCache, teamCache),
    TE.mapLeft(mapDomainErrorToServiceError),
  );

  const detectAndCalculateChanges = detectAndCalculateValueChanges(domainOps);

  const mapToPlayerValuesTask = flow(mapToPlayerValues, TE.right);

  const ops: PlayerValueServiceOperations = {
    detectPlayerValueChanges: (
      enrichedSourceValues: ReadonlyArray<EnrichedSourcePlayerValue>,
    ): TE.TaskEither<ServiceError, PlayerValueChanges> =>
      detectAndCalculateChanges(enrichedSourceValues),

    findPlayerValuesByChangeDate: (changeDate: string): TE.TaskEither<ServiceError, PlayerValues> =>
      pipe(
        playerValueCache.getPlayerValuesByChangeDate(changeDate),
        TE.mapLeft(mapDomainErrorToServiceError),
        TE.chainW(enrichSourceValues),
        TE.chainW(mapToPlayerValuesTask),
      ),

    findPlayerValuesByElement: (element: number): TE.TaskEither<ServiceError, PlayerValues> =>
      pipe(
        domainOps.getPlayerValuesByElement(element),
        TE.mapLeft(mapDomainErrorToServiceError),
        TE.chainW(enrichSourceValues),
        TE.chainW(mapToPlayerValuesTask),
      ),

    findPlayerValuesByTeam: (team: number): TE.TaskEither<ServiceError, PlayerValues> =>
      pipe(
        playerCache.getAllPlayers(),
        TE.mapLeft(mapDomainErrorToServiceError),
        TE.map(RA.filter((player) => player.team === team)),
        TE.map(RA.map((player) => player.element as number)),
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
        TE.chainW(enrichSourceValues),
        TE.chainW(mapToPlayerValuesTask),
      ),

    syncPlayerValuesFromApi: (): TE.TaskEither<ServiceError, void> =>
      pipe(
        eventCache.getCurrentEvent(),
        TE.mapLeft(mapDomainErrorToServiceError),
        TE.chainW((event) =>
          event
            ? pipe(
                fplDataService.getPlayerValues(event.id),
                TE.mapLeft((error) =>
                  createServiceIntegrationError({
                    message: 'Failed to fetch player values via data layer',
                    cause: error.cause,
                  }),
                ),
                TE.chainW(enrichSourceValues),
                TE.chainW(detectAndCalculateChanges),
                TE.chainW((playerValueChanges) =>
                  playerValueChanges.length === 0
                    ? TE.right(undefined)
                    : pipe(
                        domainOps.deleteAllPlayerValues(),
                        TE.mapLeft(mapDomainErrorToServiceError),
                        TE.chain(() =>
                          pipe(
                            domainOps.savePlayerValues(playerValueChanges),
                            TE.mapLeft(mapDomainErrorToServiceError),
                          ),
                        ),
                        TE.map(() => undefined),
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
    getPlayerValuesByChangeDate: (changeDate: string) =>
      ops.findPlayerValuesByChangeDate(changeDate),
    getPlayerValuesByElement: (element: number) => ops.findPlayerValuesByElement(element),
    getPlayerValuesByTeam: (team: number) => ops.findPlayerValuesByTeam(team),
    syncPlayerValuesFromApi: () => ops.syncPlayerValuesFromApi(),
  };
};
