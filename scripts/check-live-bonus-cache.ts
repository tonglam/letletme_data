import { eq } from 'drizzle-orm';
import { liveBonusCache, liveFixturesCache } from '../src/cache/operations';
import { redisSingleton } from '../src/cache/singleton';
import { eventLive, players } from '../src/db/schemas/index.schema';
import { databaseSingleton, getDb } from '../src/db/singleton';
import { getCurrentEvent } from '../src/services/events.service';
import { getCurrentSeason } from '../src/utils/conditions';

async function main() {
  const db = await getDb();
  const redis = await redisSingleton.getClient();

  try {
    // Get current event
    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      console.log('[LiveBonus] No current event found');
      return;
    }

    const eventId = currentEvent.id;
    const season = getCurrentSeason();
    const key = `LiveBonus:${season}:${eventId}`;

    console.log(`[LiveBonus] Checking cache for event ${eventId}, season ${season}`);
    console.log(`[LiveBonus] Cache key: ${key}`);

    // Check if key exists
    const exists = await redis.exists(key);
    console.log(`[LiveBonus] Key exists: ${exists === 1}`);

    if (exists === 1) {
      const ttl = await redis.ttl(key);
      console.log(`[LiveBonus] TTL: ${ttl} (${ttl === -1 ? 'no expiration' : `${ttl}s`})`);

      const hashSize = await redis.hlen(key);
      console.log(`[LiveBonus] Hash size (teams): ${hashSize}`);

      if (hashSize > 0) {
        const allFields = await redis.hgetall(key);
        console.log(`[LiveBonus] Teams in cache: ${Object.keys(allFields).join(', ')}`);

        // Show sample data for first team
        const firstTeamId = Object.keys(allFields)[0];
        const firstTeamData = JSON.parse(allFields[firstTeamId]);
        console.log(
          `[LiveBonus] Sample team ${firstTeamId}:`,
          JSON.stringify(firstTeamData, null, 2),
        );
      }
    } else {
      console.log('[LiveBonus] Cache key does not exist');
    }

    // Check via cache get method
    const cached = await liveBonusCache.get(eventId);
    console.log(
      `[LiveBonus] Cache get() result: ${cached ? `${Object.keys(cached).length} teams` : 'null'}`,
    );

    // Check prerequisites
    console.log('\n[LiveBonus] Checking prerequisites...');

    // 1. Check LiveFixture cache
    const liveFixtures = await liveFixturesCache.get(eventId);
    if (liveFixtures) {
      const teamCount = Object.keys(liveFixtures).length;
      console.log(`[LiveBonus] LiveFixture cache: ${teamCount} teams`);

      // Count playing/finished fixtures
      let playingCount = 0;
      let finishedCount = 0;
      for (const statusMap of Object.values(liveFixtures)) {
        playingCount += (statusMap.Playing || []).length;
        finishedCount += (statusMap.Finished || []).length;
      }
      console.log(`[LiveBonus] LiveFixture: ${playingCount} Playing, ${finishedCount} Finished`);
    } else {
      console.log('[LiveBonus] LiveFixture cache: MISSING (required for bonus calculation)');
    }

    // 2. Check event lives with teamId
    const eventLivesWithTeam = await db
      .select({
        elementId: eventLive.elementId,
        teamId: players.teamId,
        minutes: eventLive.minutes,
        bonus: eventLive.bonus,
        bps: eventLive.bps,
      })
      .from(eventLive)
      .innerJoin(players, eq(eventLive.elementId, players.id))
      .where(eq(eventLive.eventId, eventId));

    console.log(`[LiveBonus] Event lives with teamId: ${eventLivesWithTeam.length} records`);

    if (eventLivesWithTeam.length > 0) {
      const withMinutes = eventLivesWithTeam.filter((el) => (el.minutes ?? 0) > 0);
      const withBps = eventLivesWithTeam.filter((el) => (el.bps ?? 0) > 0);
      const withBonus = eventLivesWithTeam.filter((el) => (el.bonus ?? 0) > 0);

      console.log(
        `[LiveBonus] Event lives: ${withMinutes.length} with minutes > 0, ${withBps.length} with BPS > 0, ${withBonus.length} with bonus > 0`,
      );

      // Show sample
      const sample = eventLivesWithTeam[0];
      console.log(`[LiveBonus] Sample event live:`, {
        elementId: sample.elementId,
        teamId: sample.teamId,
        minutes: sample.minutes,
        bonus: sample.bonus,
        bps: sample.bps,
      });
    }
  } finally {
    await databaseSingleton.disconnect();
    await redisSingleton.disconnect();
  }
}

main().catch((err) => {
  console.error('check live bonus cache failed:', err);
  process.exit(1);
});
