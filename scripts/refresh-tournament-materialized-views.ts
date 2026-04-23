import 'dotenv/config';

import { databaseSingleton } from '../src/db/singleton';
import { refreshTournamentMaterializedViews } from '../src/services/tournament-materialized-views.service';

async function main() {
  try {
    console.log('Refreshing tournament materialized views...');
    const result = await refreshTournamentMaterializedViews();
    console.log('Refresh completed:', result);
  } catch (error) {
    console.error('Refresh failed:', error);
    process.exit(1);
  } finally {
    await databaseSingleton.disconnect();
  }
}

main();
