import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { FPLEndpoints } from '../../infrastructure/http/fpl/types';
import { BootStrapResponse } from '../../types/bootstrap.type';
import { ElementResponse } from '../../types/element.type';
import { APIError, APIErrorCode, createAPIError } from '../../types/error.type';
import { EventResponse } from '../../types/event.type';
import { PhaseResponse } from '../../types/phase.type';
import { TeamResponse } from '../../types/teams.type';
import { ExtendedBootstrapApi } from './types';

const createBootstrapError = (message: string, cause?: unknown): APIError =>
  createAPIError({
    code: APIErrorCode.INTERNAL_SERVER_ERROR,
    message,
    cause: cause instanceof Error ? cause : undefined,
  });

const isAPIError = (error: unknown): error is APIError =>
  error !== null &&
  typeof error === 'object' &&
  'code' in error &&
  'message' in error &&
  typeof (error as APIError).code === 'string' &&
  typeof (error as APIError).message === 'string';

export const createBootstrapApiAdapter = (client: FPLEndpoints): ExtendedBootstrapApi => {
  let bootstrapDataPromise: Promise<BootStrapResponse> | null = null;

  const getBootstrapData = async (): Promise<BootStrapResponse> => {
    if (!bootstrapDataPromise) {
      bootstrapDataPromise = client.bootstrap.getBootstrapStatic().then((result) => {
        if (result._tag === 'Left') {
          throw result.left;
        }
        const response = result.right;
        if (!response || typeof response !== 'object') {
          throw createBootstrapError('Invalid bootstrap response format');
        }
        const typedResponse = response as Record<string, unknown>;
        return {
          events: Array.isArray(typedResponse.events) ? typedResponse.events : [],
          phases: Array.isArray(typedResponse.phases) ? typedResponse.phases : [],
          teams: Array.isArray(typedResponse.teams) ? typedResponse.teams : [],
          elements: Array.isArray(typedResponse.elements) ? typedResponse.elements : [],
        };
      });
    }
    return bootstrapDataPromise;
  };

  const getBootstrapEvents = (): TE.TaskEither<APIError, readonly EventResponse[]> =>
    pipe(
      TE.tryCatch(
        () => getBootstrapData(),
        (error): APIError =>
          isAPIError(error) ? error : createBootstrapError('Failed to get bootstrap events', error),
      ),
      TE.chain((data) =>
        pipe(
          O.fromNullable(data.events),
          O.fold(
            () => TE.left(createBootstrapError('No events data in bootstrap response')),
            (events) => TE.right(events as readonly EventResponse[]),
          ),
        ),
      ),
    );

  const getBootstrapPhases = (): TE.TaskEither<APIError, readonly PhaseResponse[]> =>
    pipe(
      TE.tryCatch(
        () => getBootstrapData(),
        (error): APIError =>
          isAPIError(error) ? error : createBootstrapError('Failed to get bootstrap phases', error),
      ),
      TE.chain((data) =>
        pipe(
          O.fromNullable(data.phases),
          O.fold(
            () => TE.left(createBootstrapError('No phases data in bootstrap response')),
            (phases) => TE.right(phases as readonly PhaseResponse[]),
          ),
        ),
      ),
    );

  const getBootstrapTeams = (): TE.TaskEither<APIError, readonly TeamResponse[]> =>
    pipe(
      TE.tryCatch(
        () => getBootstrapData(),
        (error): APIError =>
          isAPIError(error) ? error : createBootstrapError('Failed to get bootstrap teams', error),
      ),
      TE.chain((data) =>
        pipe(
          O.fromNullable(data.teams),
          O.fold(
            () => TE.left(createBootstrapError('No teams data in bootstrap response')),
            (teams) => TE.right(teams as readonly TeamResponse[]),
          ),
        ),
      ),
    );

  const getBootstrapElements = (): TE.TaskEither<APIError, readonly ElementResponse[]> =>
    pipe(
      TE.tryCatch(
        () => getBootstrapData(),
        (error): APIError =>
          isAPIError(error)
            ? error
            : createBootstrapError('Failed to get bootstrap elements', error),
      ),
      TE.chain((data) =>
        pipe(
          O.fromNullable(data.elements),
          O.fold(
            () => TE.left(createBootstrapError('No elements data in bootstrap response')),
            (elements) => TE.right(elements as readonly ElementResponse[]),
          ),
        ),
      ),
    );

  return {
    getBootstrapData,
    getBootstrapEvents,
    getBootstrapPhases,
    getBootstrapTeams,
    getBootstrapElements,
  };
};
