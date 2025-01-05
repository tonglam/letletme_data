import * as TE from 'fp-ts/TaskEither';
import { BootStrapResponse } from '../../types/bootstrap.type';
import { ElementResponse } from '../../types/elements.type';
import { APIError } from '../../types/errors.type';
import { EventResponse } from '../../types/events.type';
import { PhaseResponse } from '../../types/phases.type';
import { TeamResponse } from '../../types/teams.type';

/**
 * Interface for bootstrap API operations
 */
export interface BootstrapApi {
  /**
   * Retrieves bootstrap data from the API
   */
  getBootstrapData: () => Promise<BootStrapResponse>;
}

/**
 * Extended bootstrap API interface with additional type-safe operations
 */
export interface ExtendedBootstrapApi extends BootstrapApi {
  getBootstrapEvents: () => TE.TaskEither<APIError, readonly EventResponse[]>;
  getBootstrapPhases: () => TE.TaskEither<APIError, readonly PhaseResponse[]>;
  getBootstrapTeams: () => TE.TaskEither<APIError, readonly TeamResponse[]>;
  getBootstrapElements: () => TE.TaskEither<APIError, readonly ElementResponse[]>;
}
