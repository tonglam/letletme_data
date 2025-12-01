import { syncEntryInfo } from '../src/services/entries.service';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { entryInfos } from '../src/db/schemas/index.schema';
import { eq } from 'drizzle-orm';

const entryId = Number(process.argv[2] || '15702');

async function main() {
  await syncEntryInfo(entryId);
  const conn = postgres(process.env.DATABASE_URL || 'postgres://localhost:5432/letletme_data');
  const db = drizzle(conn);
  const rows = await db.select().from(entryInfos).where(eq(entryInfos.id, entryId));
  console.log(rows[0] || null);
  await conn.end();
}

main().catch((e) => {
  console.error('sync+inspect failed', e);
  process.exit(1);
});
