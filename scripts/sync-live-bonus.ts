import { redisSingleton } from '../src/cache/singleton';
import { databaseSingleton } from '../src/db/singleton';
import { getCurrentEvent } from '../src/services/events.service';
import { syncLiveBonusCache } from '../src/services/live-bonus.service';

async function main() {
  try {
    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      console.log('[LiveBonus] No current event found');
      return;
    }

    console.log(`[LiveBonus] Syncing for event ${currentEvent.id}...`);
    const result = await syncLiveBonusCache(currentEvent.id);
    console.log(`[LiveBonus] Sync completed:`, result);
  } catch (error) {
    console.error('[LiveBonus] Sync failed:', error);
    throw error;
  } finally {
    await databaseSingleton.disconnect();
    await redisSingleton.disconnect();
  }
}

main().catch((err) => {
  console.error('sync live bonus failed:', err);
  process.exit(1);
});
