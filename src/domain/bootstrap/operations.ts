import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { BootStrap, toDomainBootStrap } from '../../types/bootstrap.type';
import { DomainError, DomainErrorCode } from '../../types/errors.type';
import { createStandardDomainError } from '../utils';
import { BootstrapApi } from './types';

// Fetches and transforms bootstrap data from the API
export const fetchBootstrap = (api: BootstrapApi): TE.TaskEither<DomainError, BootStrap> =>
  pipe(
    TE.tryCatch(
      () => api.getBootstrapData(),
      (error) =>
        createStandardDomainError({
          code: DomainErrorCode.VALIDATION_ERROR,
          message: 'Failed to fetch bootstrap data',
          details: error,
        }),
    ),
    TE.chain((response) =>
      pipe(
        toDomainBootStrap(response),
        E.mapLeft((msg) =>
          createStandardDomainError({
            code: DomainErrorCode.VALIDATION_ERROR,
            message: msg,
          }),
        ),
        TE.fromEither,
      ),
    ),
  );
