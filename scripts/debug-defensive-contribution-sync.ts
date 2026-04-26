import { databaseSingleton } from '../src/db/singleton';
import { redisSingleton } from '../src/cache/singleton';
import { fplClient } from '../src/clients/fpl';
import { transformEventLives } from '../src/transformers/event-lives';
import { getCurrentEvent } from '../src/services/events.service';

async function main() {
  try {
    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      console.log('No current event found');
      return;
    }

    console.log(`Fetching event live data for event ${currentEvent.id}...\n`);

    // 1. Fetch raw data from API
    const liveData = await fplClient.getEventLive(currentEvent.id);
    console.log(`Fetched ${liveData.elements?.length ?? 0} elements from API\n`);

    // 2. Check a sample element for defensive_contribution
    if (liveData.elements && liveData.elements.length > 0) {
      const sample = liveData.elements[0];
      console.log('Sample raw element from API:');
      console.log(`  ID: ${sample.id}`);
      console.log(`  Stats keys: ${Object.keys(sample.stats).join(', ')}`);
      console.log(`  defensive_contribution in stats: ${'defensive_contribution' in sample.stats}`);
      console.log(
        `  defensive_contribution value: ${(sample.stats as { defensive_contribution?: number }).defensive_contribution ?? 'undefined'}`,
      );

      // Show full stats object
      console.log('\n  Full stats object:');
      console.log(JSON.stringify(sample.stats, null, 2));

      // 3. Transform and check
      const transformed = transformEventLives(currentEvent.id, [sample]);
      console.log(
        `\nTransformed defensive_contribution: ${transformed[0]?.defensiveContribution ?? 'undefined'}`,
      );

      // 4. Find elements with defensive_contribution > 0
      const withDc = liveData.elements.filter(
        (el) =>
          (el.stats as { defensive_contribution?: number }).defensive_contribution &&
          (el.stats as { defensive_contribution?: number }).defensive_contribution! > 0,
      );
      console.log(`\nElements with defensive_contribution > 0: ${withDc.length}`);
      if (withDc.length > 0) {
        console.log('\nSample elements with defensive_contribution:');
        withDc.slice(0, 5).forEach((el) => {
          const dc = (el.stats as { defensive_contribution?: number }).defensive_contribution;
          console.log(`  Element ${el.id}: defensive_contribution = ${dc}`);
        });
      }
    }
  } catch (error) {
    console.error('Debug failed:', error);
    throw error;
  } finally {
    await databaseSingleton.disconnect();
    await redisSingleton.disconnect();
  }
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
