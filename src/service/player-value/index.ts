/**
 * Player Value Service Module
 * Exports the player value service interface and implementation.
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import {
  APIError,
  APIErrorCode,
  createAPIError,
  createServiceError,
  ServiceError,
  ServiceErrorCode,
} from '../../types/error.type';
import { ServiceKey } from '../index';
import { registry, ServiceFactory } from '../registry';
import { mapDomainError } from '../utils';
import { createPlayerValueService } from './service';
import { PlayerValueService } from './types';

const mapAPIToServiceError = (error: APIError) =>
  createServiceError({
    code: ServiceErrorCode.INTEGRATION_ERROR,
    message: error.message,
    cause: error as unknown as Error,
  });

const mapServiceError = (error: ServiceError) =>
  createAPIError({
    code: APIErrorCode.SERVICE_ERROR,
    message: error.message,
    cause: error as unknown as Error,
  });

export const playerValueServiceFactory: ServiceFactory<PlayerValueService> = {
  create: ({ bootstrapApi, playerValueRepository }) => {
    const wrappedBootstrapApi = {
      getBootstrapElements: () =>
        pipe(bootstrapApi.getBootstrapElements(), TE.mapLeft(mapAPIToServiceError)),
    };

    return pipe(
      TE.right(createPlayerValueService(wrappedBootstrapApi, playerValueRepository)),
      TE.mapLeft(mapDomainError),
      TE.mapLeft(mapServiceError),
    );
  },
  dependencies: ['bootstrapApi', 'playerValueRepository'],
};

registry.register(ServiceKey.PLAYER_VALUE, playerValueServiceFactory);

export * from './service';
export * from './types';
