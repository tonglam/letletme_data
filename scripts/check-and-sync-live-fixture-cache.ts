import 'dotenv/config';

import { liveFixturesCache } from '../src/cache/operations';
import { redisSingleton } from '../src/cache/singleton';
import { databaseSingleton } from '../src/db/singleton';
import { getCurrentEvent } from '../src/services/events.service';
import { syncLiveFixtureCache } from '../src/services/live-fixtures.service';

async function main() {
  try {
    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      console.log('[LiveFixture] No current event found');
      return;
    }

    const eventId = currentEvent.id;
    const existing = await liveFixturesCache.get(eventId);
    const existingTeams = existing ? Object.keys(existing).length : 0;

    console.log(`[LiveFixture] Current event: ${eventId}`);
    console.log(`[LiveFixture] Cache teams: ${existingTeams}`);

    if (existingTeams > 0) {
      console.log('[LiveFixture] Cache is not empty, skipping sync');
      return;
    }

    console.log('[LiveFixture] Cache empty, syncing...');
    const synced = await syncLiveFixtureCache(eventId);
    console.log(
      `[LiveFixture] Sync done: eventId=${synced.eventId}, teamCount=${synced.teamCount}`,
    );

    const after = await liveFixturesCache.get(eventId);
    const afterTeams = after ? Object.keys(after).length : 0;
    console.log(`[LiveFixture] Cache teams after sync: ${afterTeams}`);
  } finally {
    await databaseSingleton.disconnect();
    await redisSingleton.disconnect();
  }
}

main().catch((err) => {
  console.error('check-and-sync-live-fixture-cache failed:', err);
  process.exit(1);
});
