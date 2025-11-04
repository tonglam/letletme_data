import { and, eq } from 'drizzle-orm';
import { databaseSingleton, getDb } from '../src/db/singleton';
import { redisSingleton } from '../src/cache/singleton';
import { eventLiveExplains, events } from '../src/db/schemas/index.schema';

async function main() {
  const db = await getDb();
  try {
    // Determine eventId: prefer CLI arg, else current event from DB
    const arg = process.argv[2];
    let eventId: number | null = null;
    if (arg) {
      const parsed = Number(arg);
      if (!Number.isFinite(parsed)) throw new Error(`Invalid eventId: ${arg}`);
      eventId = parsed;
    } else {
      const cur = await db.select().from(events).where(eq(events.isCurrent, true));
      eventId = cur[0]?.id ?? null;
    }

    if (!eventId) {
      console.log('[Explains] No current event found and no eventId provided');
      return;
    }

    const rows = await db
      .select()
      .from(eventLiveExplains)
      .where(eq(eventLiveExplains.eventId, eventId));

    console.log(`[Explains] Event ${eventId} rows:`, rows.length);
    if (rows.length > 0) {
      const sample = rows[0];
      console.log('[Explains] Sample row:', {
        eventId: sample.eventId,
        elementId: sample.elementId,
        minutes: sample.minutes,
        minutesPoints: sample.minutesPoints,
        goalsScored: sample.goalsScored,
        goalsScoredPoints: sample.goalsScoredPoints,
        assists: sample.assists,
        assistsPoints: sample.assistsPoints,
        bonus: sample.bonus,
      });
    }
  } finally {
    await databaseSingleton.disconnect();
    await redisSingleton.disconnect();
  }
}

main().catch((err) => {
  console.error('check explains failed:', err);
  process.exit(1);
});

