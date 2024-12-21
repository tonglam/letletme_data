import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import type { Phase as DomainPhase } from '../../types/phase.type';
import { createError } from '../phases/operations';

export type BootstrapApi = {
  readonly getBootstrapData: () => Promise<DomainPhase[] | null>;
};

export const fetchBootstrapData = (api: BootstrapApi) =>
  pipe(
    TE.tryCatch(
      () => api.getBootstrapData(),
      (error) => createError('Failed to fetch bootstrap data', error),
    ),
    TE.map((phases) => phases ?? []),
  );
