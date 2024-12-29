import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { BootStrap, BootStrapResponse, toDomainBootStrap } from 'src/types/domain/bootstrap.type';
import { APIError, createValidationError } from 'src/types/errors.type';

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
 * @returns {TaskEither<APIError, BootStrap>} A TaskEither containing either an APIError or the transformed BootStrap data
 */
export const fetchBootstrap = (api: BootstrapApi): TE.TaskEither<APIError, BootStrap> =>
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
