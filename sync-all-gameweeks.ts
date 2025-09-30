import { syncAllGameweeks } from './src/services/fixtures.service';

async function main() {
  try {
    console.log('\n🚀 Starting comprehensive fixtures sync for all 38 gameweeks...\n');

    const result = await syncAllGameweeks();

    console.log('\n===========================================');
    console.log('✅ SYNC COMPLETE!');
    console.log('===========================================');
    console.log(`Total fixtures synced: ${result.totalCount}`);
    console.log(`Total errors: ${result.totalErrors}`);
    console.log(`Gameweeks processed: ${result.perGameweek.length}\n`);

    // Show summary
    console.log('Summary by gameweek:');
    result.perGameweek.forEach((gw) => {
      const status = gw.errors > 0 ? '❌' : '✅';
      console.log(`  ${status} GW ${gw.eventId}: ${gw.count} fixtures`);
    });

    console.log('\n===========================================\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Sync failed:', error);
    process.exit(1);
  }
}

main();
