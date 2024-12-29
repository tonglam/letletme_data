import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { BootStrap, BootStrapResponse, toDomainBootStrap } from '../../types/bootstrap.type';
import { APIError, createValidationError } from '../../types/errors.type';

// Interface for bootstrap API operations
export interface BootstrapApi {
  // Retrieves bootstrap data from the API
  getBootstrapData: () => Promise<BootStrapResponse>;
}

// Fetches and transforms bootstrap data from the API
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
