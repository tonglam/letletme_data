import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import type { Event as DomainEvent } from '../../types/events.type';
import type { Phase as DomainPhase } from '../../types/phases.type';
import { createError } from '../phases/operations';

export type BootstrapApi = {
  readonly getBootstrapData: () => Promise<DomainPhase[] | null>;
  readonly getBootstrapEvents: () => Promise<DomainEvent[] | null>;
};

export const fetchBootstrapData = (api: BootstrapApi) =>
  pipe(
    TE.tryCatch(
      () => api.getBootstrapData(),
      (error) => createError('Failed to fetch bootstrap data', error),
    ),
    TE.map((phases) => phases ?? []),
  );

export const fetchBootstrapEvents = (api: BootstrapApi) =>
  pipe(
    TE.tryCatch(
      () => api.getBootstrapEvents(),
      (error) => createError('Failed to fetch bootstrap events', error),
    ),
    TE.map((events) => events ?? []),
  );
