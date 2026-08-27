import type {
  ManagerLiveReadMode,
  ManagerLiveResolveResult,
  ManagerLiveCalculationMode,
} from './contracts';
import type { ManagerLiveRefreshPorts } from './ports';

export type ManagerLiveResolveRequest = {
  eventId: number;
  entryIds: readonly number[];
  tournamentId?: number;
  readMode?: ManagerLiveReadMode;
  includeEffectiveLineup?: boolean;
  liveRef?: { publicationId: string; revision: number | string };
  requestedCalculationMode?: Exclude<ManagerLiveCalculationMode, 'FINAL_RESULT'>;
};

export type ManagerLiveRefreshRequest = {
  eventId: number;
  entryIds: readonly number[];
  tournamentId?: number;
  classicStandingsStartPage?: number;
  summaryRotationCursor?: number;
};

export type ManagerLiveOrchestration = {
  resolve(request: ManagerLiveResolveRequest): Promise<ManagerLiveResolveResult>;
  refresh(request: ManagerLiveRefreshRequest): Promise<ManagerLiveResolveResult>;
};

/**
 * Bind pure orchestration handlers to explicit ports. The production facade
 * supplies adapters here; unit tests can provide fakes without importing the
 * manager-live service or opening infrastructure connections.
 */
export const createManagerLiveOrchestration = (input: {
  ports: ManagerLiveRefreshPorts;
  resolve: (
    request: ManagerLiveResolveRequest,
    ports: ManagerLiveRefreshPorts,
  ) => Promise<ManagerLiveResolveResult>;
  refresh: (
    request: ManagerLiveRefreshRequest,
    ports: ManagerLiveRefreshPorts,
  ) => Promise<ManagerLiveResolveResult>;
}): ManagerLiveOrchestration => ({
  resolve: (request) => input.resolve(request, input.ports),
  refresh: (request) => input.refresh(request, input.ports),
});
