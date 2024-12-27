import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { BootStrap, BootStrapResponse, toDomainBootStrap } from '../../types/bootstrap.type';
import { createError } from '../phases/operations';

export interface BootstrapApi {
  getBootstrapData: () => Promise<BootStrapResponse>;
}

export const fetchBootstrap = (api: BootstrapApi): TE.TaskEither<Error, BootStrap> =>
  pipe(
    TE.tryCatch(
      () => api.getBootstrapData(),
      (error) => createError('Failed to fetch bootstrap data', error),
    ),
    TE.chain((response) =>
      pipe(
        toDomainBootStrap(response),
        E.mapLeft((msg) => new Error(msg)),
        TE.fromEither,
      ),
    ),
  );
