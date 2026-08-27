import type { ManagerLiveCachePort, ManagerLiveCheckpointPort } from './ports';
import type { ManagerLiveScoreRow } from './contracts';

/**
 * Storage boundary for manager-live publication.
 *
 * The service layer depends on this contract rather than a concrete Redis or
 * Drizzle client. Implementations may combine a cache read with a checkpoint
 * fallback, but the orchestration contract stays deterministic and testable.
 */
export type ManagerLivePublicationStore = {
  read(input: {
    season: string;
    eventId: number;
    entryIds: readonly number[];
  }): Promise<readonly ManagerLiveScoreRow[]>;
  write(input: {
    season: string;
    eventId: number;
    rows: readonly ManagerLiveScoreRow[];
  }): Promise<void>;
  reconcile(input: {
    season: string;
    eventId: number;
    rows: readonly ManagerLiveScoreRow[];
  }): Promise<void>;
};

/** Minimal constructor dependencies exposed to infrastructure adapters. */
export type ManagerLivePublicationStorePorts = {
  cache: ManagerLiveCachePort;
  checkpoint: ManagerLiveCheckpointPort;
};
