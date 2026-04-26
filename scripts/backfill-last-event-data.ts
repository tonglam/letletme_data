import 'dotenv/config';

import { eq } from 'drizzle-orm';

import { entryInfos } from '../src/db/schemas/index.schema';
import { fplClient } from '../src/clients/fpl';
import { getDb, getDbClient } from '../src/db/singleton';

const EVENT_ID = 33;
const BATCH_SIZE = 20;
const CONCURRENCY = 5;
const DELAY_BETWEEN_BATCHES_MS = 1000;

function parseArgs() {
  const args = process.argv.slice(2);
  let eventId = EVENT_ID;
  let dryRun = false;

  for (const arg of args) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--event=')) {
      eventId = Number(arg.split('=')[1]);
      if (!Number.isFinite(eventId)) {
        throw new Error(`Invalid event ID: ${arg}`);
      }
    }
  }

  return { eventId, dryRun };
}

async function getUniqueEntryIds(): Promise<number[]> {
  const client = await getDbClient();
  const rows = await client<{ entry_id: number }[]>`
    SELECT DISTINCT entry_id FROM tournament_entries ORDER BY entry_id
  `;
  return rows.map((r) => r.entry_id);
}

async function fetchPicksForEntry(
  entryId: number,
  eventId: number,
): Promise<{
  totalPoints: number;
  overallRank: number | null;
  bank: number;
  value: number;
} | null> {
  try {
    const picks = await fplClient.getEntryEventPicks(entryId, eventId);
    const h = picks.entry_history;
    return {
      totalPoints: h.total_points,
      overallRank: h.overall_rank,
      bank: h.bank,
      value: h.value,
    };
  } catch (err) {
    console.error(`  ✗ entry ${entryId}: fetch failed`, err instanceof Error ? err.message : err);
    return null;
  }
}

async function updateEntryInfo(
  entryId: number,
  data: {
    totalPoints: number;
    overallRank: number | null;
    bank: number;
    value: number;
  },
): Promise<void> {
  const db = await getDb();
  await db
    .update(entryInfos)
    .set({
      lastOverallPoints: data.totalPoints,
      lastOverallRank: data.overallRank,
      lastBank: data.bank,
      lastTeamValue: data.value,
    })
    .where(eq(entryInfos.id, entryId));
}

async function processBatch(
  entryIds: number[],
  eventId: number,
  dryRun: boolean,
): Promise<{ updated: number; failed: number }> {
  let updated = 0;
  let failed = 0;

  const chunks: number[][] = [];
  for (let i = 0; i < entryIds.length; i += CONCURRENCY) {
    chunks.push(entryIds.slice(i, i + CONCURRENCY));
  }

  for (const chunk of chunks) {
    const results = await Promise.all(
      chunk.map(async (entryId) => {
        const data = await fetchPicksForEntry(entryId, eventId);
        if (!data) {
          return { entryId, ok: false };
        }
        if (!dryRun) {
          await updateEntryInfo(entryId, data);
        }
        return { entryId, ok: true, data };
      }),
    );

    for (const r of results) {
      if (r.ok && 'data' in r) {
        console.log(
          `  ✓ entry ${r.entryId}: pts=${r.data.totalPoints} rank=${r.data.overallRank} bank=${r.data.bank} value=${r.data.value}`,
        );
        updated++;
      } else {
        failed++;
      }
    }
  }

  return { updated, failed };
}

async function main() {
  const { eventId, dryRun } = parseArgs();

  console.log(`Backfilling entry_infos last_* fields from picks API (event ${eventId})`);
  if (dryRun) {
    console.log('DRY RUN — no DB writes');
  }

  const entryIds = await getUniqueEntryIds();
  console.log(`Found ${entryIds.length} unique entries in tournament_entries`);

  let totalUpdated = 0;
  let totalFailed = 0;

  for (let i = 0; i < entryIds.length; i += BATCH_SIZE) {
    const batch = entryIds.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(entryIds.length / BATCH_SIZE);
    console.log(`\nBatch ${batchNum}/${totalBatches} (${batch.length} entries)`);

    const result = await processBatch(batch, eventId, dryRun);
    totalUpdated += result.updated;
    totalFailed += result.failed;

    if (i + BATCH_SIZE < entryIds.length) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Done. Updated: ${totalUpdated}, Failed: ${totalFailed}, Total: ${entryIds.length}`);
  if (dryRun) {
    console.log('(dry run — no changes written)');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
