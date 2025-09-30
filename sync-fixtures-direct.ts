import { syncFixtures } from './src/services/fixtures.service';
import { logInfo } from './src/utils/logger';

async function main() {
  try {
    logInfo('=== Starting Direct Fixtures Sync ===');
    const result = await syncFixtures();
    logInfo('=== Sync Complete! ===', result);
    logInfo(`✅ Synced ${result.count} fixtures to database and Redis`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Sync failed:', error);
    process.exit(1);
  }
}

main();
