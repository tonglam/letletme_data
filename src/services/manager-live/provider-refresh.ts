import type { ManagerLiveProviderPort } from './ports';

/** Provider calls used by refresh orchestration, with no concrete client. */
export type ManagerLiveProviderRefresh = Pick<
  ManagerLiveProviderPort,
  'getEventLive' | 'getEntrySummary' | 'getLeagueClassicStandings'
>;

/** Compose the provider adapter at the application boundary. */
export const createManagerLiveProviderRefresh = (
  provider: ManagerLiveProviderPort,
): ManagerLiveProviderRefresh => provider;
