import 'dotenv/config';

import { entryInfosCache } from '../src/cache/entry-infos-cache';
import { entryInfoRepository } from '../src/repositories/entry-infos';
import { databaseSingleton } from '../src/db/singleton';
import { redisSingleton } from '../src/cache/singleton';

async function main() {
  try {
    console.log('Initializing entry infos Redis cache...');

    // Fetch all entry infos from database
    const entries = await entryInfoRepository.findAll();
    console.log(`Found ${entries.length} entries in database`);

    if (entries.length === 0) {
      console.log('No entries to cache');
      return;
    }

    // Populate cache with diff-based update
    const result = await entryInfosCache.setEntries(entries);
    console.log('Cache population completed:', {
      total: entries.length,
      added: result.added,
      updated: result.updated,
      skipped: result.skipped,
    });
  } catch (error) {
    console.error('Cache population failed:', error);
    process.exit(1);
  } finally {
    await databaseSingleton.disconnect();
    await redisSingleton.disconnect();
  }
}

main();
