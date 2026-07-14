import { deriveSeasonFromEvents, deriveSeasonFromFixtures } from '../cache/cache-season';
import { fplClient } from '../clients/fpl';
import { logWarn } from '../utils/logger';

import type { RawFPLEvent } from '../types';

export async function resolvePublishedSeasonFromEvents(
  events: readonly RawFPLEvent[],
): Promise<string | undefined> {
  const eventSeason = deriveSeasonFromEvents(events);
  if (eventSeason) {
    return eventSeason;
  }

  try {
    const fixtures = await fplClient.getFixtures();
    return deriveSeasonFromFixtures(fixtures) ?? undefined;
  } catch (error) {
    logWarn('Failed to resolve published season from fixtures fallback', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
