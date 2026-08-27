import type { RawFPLLeagueStandingsResponse, fplClient } from '../../clients/fpl';
import type { ManagerLiveResolveResult, ManagerLiveScoreRow } from './contracts';

/** Clock port used by refresh orchestration and deterministic tests. */
export type ManagerLiveClock = {
  now(): Date;
};

/** Upstream FPL calls required by manager-live refresh. */
export type ManagerLiveProviderPort = Pick<
  typeof fplClient,
  'getEventLive' | 'getEntrySummary' | 'getLeagueClassicStandings'
>;

/** Minimal cache surface; concrete ioredis clients stay in infrastructure. */
export type ManagerLiveCachePort = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, ttl?: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  eval?(script: string, keyCount: number, ...args: string[]): Promise<unknown>;
};

/** Database/checkpoint port kept deliberately free of Drizzle/postgres types. */
export type ManagerLiveCheckpointPort = {
  read(scopeKey: string): Promise<unknown>;
  write(scopeKey: string, value: unknown): Promise<boolean>;
};

/** Publication gate port for cross-replica serialization. */
export type ManagerLivePublicationPort = {
  run<T>(key: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
};

/** Queue port used by orchestration to request bounded background refresh. */
export type ManagerLiveQueuePort = {
  enqueue(input: {
    eventId: number;
    entryIds: readonly number[];
    tournamentId?: number;
  }): Promise<void>;
};

/**
 * Injectable boundary for a complete manager-live refresh. Infrastructure
 * adapters implement this at the composition root; pure unit tests can use
 * small fakes without opening Redis, PostgreSQL, BullMQ or the FPL provider.
 */
export type ManagerLiveRefreshPorts = {
  clock: ManagerLiveClock;
  provider: ManagerLiveProviderPort;
  cache: ManagerLiveCachePort;
  checkpoint: ManagerLiveCheckpointPort;
  publication: ManagerLivePublicationPort;
  queue: ManagerLiveQueuePort;
};

/** Pure result contract used by orchestration adapters and golden fixtures. */
export type ManagerLiveRefreshResult = Pick<
  ManagerLiveResolveResult,
  'managerRevision' | 'rows' | 'missingEntryIds' | 'errorCode' | 'partial'
> & {
  readonly publishedRows: readonly ManagerLiveScoreRow[];
};

export type ClassicStandingsProviderPort = {
  fetchStandings(
    leagueId: number,
    standingsPage: number,
    newEntriesPage?: number,
    requestOptions?: Parameters<typeof fplClient.getLeagueClassicStandings>[3],
  ): Promise<RawFPLLeagueStandingsResponse>;
};
