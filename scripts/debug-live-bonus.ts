import { eq } from 'drizzle-orm';
import { liveFixturesCache } from '../src/cache/operations';
import { redisSingleton } from '../src/cache/singleton';
import { eventLive, players } from '../src/db/schemas/index.schema';
import { databaseSingleton, getDb } from '../src/db/singleton';
import { getCurrentEvent } from '../src/services/events.service';

async function main() {
  const db = await getDb();

  try {
    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      console.log('[Debug] No current event found');
      return;
    }

    const eventId = currentEvent.id;
    console.log(`[Debug] Analyzing event ${eventId}...\n`);

    // 1. Get playing fixtures map
    const liveFixtures = await liveFixturesCache.get(eventId);
    if (!liveFixtures) {
      console.log('[Debug] No LiveFixture cache found');
      return;
    }

    // Build playing map
    const playingMap = new Map<number, number>();
    for (const [teamIdStr, statusMap] of Object.entries(liveFixtures)) {
      const teamId = Number.parseInt(teamIdStr, 10);
      if (Number.isNaN(teamId)) continue;

      const playing = statusMap.Playing || [];
      const finished = statusMap.Finished || [];
      const allFixtures = [...playing, ...finished];

      if (allFixtures.length === 0) continue;
      if (playingMap.has(teamId)) continue;

      const firstFixture = allFixtures[0];
      const againstId = firstFixture.againstId;

      playingMap.set(teamId, againstId);
      playingMap.set(againstId, teamId);
    }

    console.log(`[Debug] Playing map: ${playingMap.size} teams (${playingMap.size / 2} matches)`);

    // 2. Get event lives with teamId
    const eventLives = await db
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

    console.log(`[Debug] Total event lives: ${eventLives.length}`);

    // 3. Filter step by step
    const withMinutes = eventLives.filter((el) => (el.minutes ?? 0) > 0);
    console.log(`[Debug] With minutes > 0: ${withMinutes.length}`);

    const inPlayingMap = withMinutes.filter((el) => playingMap.has(el.teamId));
    console.log(`[Debug] In playing map: ${inPlayingMap.length}`);

    const bonusInTeamSet = new Set<number>();
    const teamEventLiveMap = new Map<number, typeof eventLives>();

    for (const eventLive of inPlayingMap) {
      const teamId = eventLive.teamId;
      const againstId = playingMap.get(teamId)!;

      // If bonus > 0, check if we should skip these teams
      if ((eventLive.bonus ?? 0) > 0) {
        if (teamEventLiveMap.has(teamId) && !bonusInTeamSet.has(teamId)) {
          bonusInTeamSet.add(teamId);
          console.log(`[Debug] Skipping team ${teamId} (has bonus > 0, already collected)`);
        }
        if (teamEventLiveMap.has(againstId) && !bonusInTeamSet.has(againstId)) {
          bonusInTeamSet.add(againstId);
          console.log(`[Debug] Skipping team ${againstId} (has bonus > 0, already collected)`);
        }
        continue;
      }

      // Add to home team's list
      const homeList = teamEventLiveMap.get(teamId) || [];
      homeList.push(eventLive);
      teamEventLiveMap.set(teamId, homeList);

      // Add to away team's list
      const awayList = teamEventLiveMap.get(againstId) || [];
      awayList.push(eventLive);
      teamEventLiveMap.set(againstId, awayList);
    }

    console.log(`[Debug] Teams in bonusInTeamSet: ${bonusInTeamSet.size}`);
    console.log(`[Debug] Teams in teamEventLiveMap: ${teamEventLiveMap.size}`);

    // Show which teams will be processed
    const eligibleTeams = Array.from(teamEventLiveMap.keys()).filter(
      (tid) => !bonusInTeamSet.has(tid),
    );
    console.log(`[Debug] Eligible teams (not in skip list): ${eligibleTeams.length}`);
    console.log(`[Debug] Eligible team IDs: ${eligibleTeams.join(', ')}`);

    // Check if teams have BPS > 0
    for (const teamId of eligibleTeams.slice(0, 5)) {
      const teamLives = teamEventLiveMap.get(teamId) || [];
      const withBps = teamLives.filter((el) => (el.bps ?? 0) > 0);
      console.log(
        `[Debug] Team ${teamId}: ${teamLives.length} event lives, ${withBps.length} with BPS > 0`,
      );
    }
  } finally {
    await databaseSingleton.disconnect();
    await redisSingleton.disconnect();
  }
}

main().catch((err) => {
  console.error('debug live bonus failed:', err);
  process.exit(1);
});
