import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createValidationError } from '../../infrastructure/http/common/errors';
import { BootStrap, BootStrapResponse, toDomainBootStrap } from '../../types/bootstrap.type';

/**
 * Interface for bootstrap API operations
 * @interface BootstrapApi
 */
export interface BootstrapApi {
  /**
   * Retrieves bootstrap data from the API
   * @async
   * @returns {Promise<BootStrapResponse>} A promise that resolves to bootstrap response data
   */
  getBootstrapData: () => Promise<BootStrapResponse>;
}

/**
 * Fetches and transforms bootstrap data from the API
 * @param {BootstrapApi} api - The bootstrap API instance
 * @returns {TaskEither<Error, BootStrap>} A TaskEither containing either an Error or the transformed BootStrap data
 */
export const fetchBootstrap = (api: BootstrapApi): TE.TaskEither<Error, BootStrap> =>
  pipe(
    TE.tryCatch(
      () => api.getBootstrapData(),
      (error) =>
        createValidationError({ message: 'Failed to fetch bootstrap data', details: { error } }),
    ),
    TE.chain((response) =>
      pipe(
        toDomainBootStrap(response),
        E.mapLeft((msg) => createValidationError({ message: msg })),
        TE.fromEither,
      ),
    ),
  );
