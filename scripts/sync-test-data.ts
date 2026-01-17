#!/usr/bin/env bun
/**
 * Script to sync prerequisite test data
 */

import { syncEventLives } from '../src/services/event-lives.service';
import { getCurrentEvent, syncEvents } from '../src/services/events.service';
import { syncPlayers } from '../src/services/players.service';
import { syncTeams } from '../src/services/teams.service';

async function syncTestData() {
  console.log('🔄 Syncing prerequisite test data...\n');

  try {
    // 1. Sync events (needed to get current event)
    console.log('1️⃣ Syncing events...');
    await syncEvents();
    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      throw new Error('No current event found');
    }
    console.log(`✅ Events synced (current: GW${currentEvent.id})\n`);

    // 2. Sync teams
    console.log('2️⃣ Syncing teams...');
    await syncTeams();
    console.log('✅ Teams synced\n');

    // 3. Sync players (needed for live data)
    console.log('3️⃣ Syncing players...');
    const playersResult = await syncPlayers();
    console.log(`✅ Players synced (${playersResult.count} players)\n`);

    // 4. Sync event lives (needed for summaries)
    console.log('4️⃣ Syncing event lives...');
    const livesResult = await syncEventLives(currentEvent.id);
    console.log(`✅ Event lives synced (${livesResult.count} records)\n`);

    console.log('🎉 All test data synced successfully!');
    console.log('\nYou can now run:');
    console.log('  bun test tests/integration/event-live-summaries.test.ts');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error syncing test data:', error);
    process.exit(1);
  }
}

syncTestData();
