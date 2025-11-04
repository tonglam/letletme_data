import * as dotenv from 'dotenv';
import { syncEntryEventResults } from '../src/services/entries.service';

dotenv.config();

async function main() {
  const [entryArg, eventArg] = process.argv.slice(2);
  if (!entryArg) {
    console.error('Usage: bun scripts/sync-entry-results.ts <entryId> [eventId]');
    process.exit(1);
  }
  const entryId = Number(entryArg);
  if (!Number.isFinite(entryId)) {
    console.error('Invalid entryId:', entryArg);
    process.exit(1);
  }
  const eventId = eventArg ? Number(eventArg) : undefined;
  if (eventArg && !Number.isFinite(Number(eventArg))) {
    console.error('Invalid eventId:', eventArg);
    process.exit(1);
  }

  try {
    const res = await syncEntryEventResults(entryId, eventId);
    console.log('✅ Synced entry event results', res);
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to sync entry event results:', err);
    process.exit(1);
  }
}

main();

