import * as dotenv from 'dotenv';
import { syncEntryInfo } from '../src/services/entries.service';

dotenv.config();

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: bun scripts/sync-entry.ts <entryId>');
    process.exit(1);
  }
  const entryId = Number(arg);
  if (!Number.isFinite(entryId)) {
    console.error('Invalid entryId:', arg);
    process.exit(1);
  }

  try {
    const res = await syncEntryInfo(entryId);
    console.log('✅ Synced entry', res);
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to sync entry:', err);
    process.exit(1);
  }
}

main();

