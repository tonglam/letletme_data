// Player Value Service Module
// Provides business logic for Player Value operations, implementing caching and error handling.
// Uses functional programming principles for type-safe operations.

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createPlayerValueOperations } from '../../domain/player-value/operation';
import { PlayerValueOperations } from '../../domain/player-value/types';
import { PlayerOperations } from '../../domain/player/types';
import { ValueChangeType, getElementTypeById } from '../../types/base.type';
import { ElementResponse } from '../../types/element.type';
import {
  PlayerValue,
  PlayerValueId,
  PlayerValueRepository,
  PlayerValues,
} from '../../types/player-value.type';
import { Player, PlayerId } from '../../types/player.type';
import { createServiceIntegrationError } from '../../utils/error.util';
import { mapDomainError } from '../utils';
import type {
  PlayerValueService,
  PlayerValueServiceDependencies,
  PlayerValueServiceOperations,
  PlayerValueServiceWithWorkflows,
  PriceChange,
} from './types';
import { playerValueWorkflows } from './workflow';

interface PlayerPriceUpdate {
  readonly id: PlayerId;
  readonly price: number;
}

const detectPriceChanges = (
  currentElements: readonly ElementResponse[],
  currentPlayers: readonly Player[],
): PriceChange[] => {
  const currentPriceMap = new Map(currentPlayers.map((player) => [player.id, player.price]));

  return currentElements
    .filter((element) => {
      const currentPrice = currentPriceMap.get(element.id as PlayerId) ?? 0;
      return element.now_cost !== currentPrice;
    })
    .map((element) => {
      const elementType = getElementTypeById(element.element_type);
      if (!elementType) {
        throw new Error(`Invalid element type: ${element.element_type}`);
      }
      return {
        elementId: element.id,
        oldPrice: currentPriceMap.get(element.id as PlayerId) ?? 0,
        newPrice: element.now_cost,
        elementType,
        eventId: typeof element.event === 'number' ? element.event : 0,
      };
    });
};

const getChangeType = (newPrice: number, oldPrice: number): ValueChangeType => {
  if (oldPrice === 0) return ValueChangeType.Start;
  return newPrice > oldPrice ? ValueChangeType.Rise : ValueChangeType.Fall;
};

const createPlayerValueFromChange = (change: PriceChange, changeDate: string): PlayerValue => ({
  id: `${change.elementId}_${changeDate}` as PlayerValueId,
  elementId: change.elementId,
  elementType: change.elementType,
  eventId: change.eventId,
  value: change.newPrice,
  changeDate,
  changeType: getChangeType(change.newPrice, change.oldPrice),
  lastValue: change.oldPrice,
});

const playerValueServiceOperations = (
  domainOps: PlayerValueOperations,
  playerOps: PlayerOperations,
): PlayerValueServiceOperations => ({
  findAllPlayerValues: () =>
    pipe(domainOps.getPlayerValueByChangeDate(''), TE.mapLeft(mapDomainError)),

  findPlayerValueById: (id: string) =>
    pipe(
      domainOps.getPlayerValueByChangeDate(id),
      TE.mapLeft(mapDomainError),
      TE.map((values) => (values.length > 0 ? values[0] : null)),
    ),

  syncPlayerValuesFromApi: (bootstrapApi: PlayerValueServiceDependencies['bootstrapApi']) =>
    pipe(
      // 1. Fetch current data from API
      bootstrapApi.getBootstrapElements(),
      TE.mapLeft((error) =>
        createServiceIntegrationError({
          message: 'Failed to fetch player values from API',
          cause: error,
        }),
      ),
      // 2. Get current players and detect changes
      TE.chain((elements) =>
        pipe(
          playerOps.getAllPlayers(),
          TE.mapLeft(mapDomainError),
          TE.map((players) => detectPriceChanges(elements, players)),
        ),
      ),
      // 3. Create new value records for changes and update player prices
      TE.chain((changes) => {
        const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const newValues = changes.map((change) => createPlayerValueFromChange(change, today));
        const updatedPlayers: PlayerPriceUpdate[] = changes.map((change) => ({
          id: change.elementId as PlayerId,
          price: change.newPrice,
        }));

        return pipe(
          // First create value records
          domainOps.createPlayerValues(newValues),
          TE.mapLeft(mapDomainError),
          // Then update player prices
          TE.chain(() =>
            pipe(
              playerOps.updatePrices(updatedPlayers),
              TE.mapLeft(mapDomainError),
              TE.map(() => newValues),
            ),
          ),
        );
      }),
    ),
});

export const createPlayerValueService = (
  bootstrapApi: PlayerValueServiceDependencies['bootstrapApi'],
  repository: PlayerValueRepository,
  playerOps: PlayerOperations = {
    getAllPlayers: () => TE.right([]),
    getPlayerById: () => TE.right(null),
    createPlayers: () => TE.right([]),
    updatePrices: () => TE.right(undefined),
    deleteAll: () => TE.right(undefined),
  },
): PlayerValueServiceWithWorkflows => {
  const domainOps = createPlayerValueOperations(repository);
  const ops = playerValueServiceOperations(domainOps, playerOps);

  const service: PlayerValueService = {
    getPlayerValues: () => ops.findAllPlayerValues(),
    getPlayerValue: (id: string) => ops.findPlayerValueById(id),
    savePlayerValues: (values: PlayerValues) =>
      pipe(domainOps.createPlayerValues(values), TE.mapLeft(mapDomainError)),
    syncPlayerValuesFromApi: () => ops.syncPlayerValuesFromApi(bootstrapApi),
  };

  return {
    ...service,
    workflows: playerValueWorkflows(service),
  };
};
