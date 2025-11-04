import { databaseSingleton, getDb } from '../src/db/singleton';
import {
  eventsCache,
  fixturesCache,
  phasesCache,
  playerStatsCache,
  playerValuesCache,
  playersCache,
  teamsCache,
} from '../src/cache/operations';
import { redisSingleton } from '../src/cache/singleton';
import {
  eventFixtures,
  events,
  phases,
  playerStats,
  playerValues,
  players,
  teams,
} from '../src/db/schemas/index.schema';

async function checkEvents() {
  const db = await getDb();
  const rows = await db.select().from(events);
  const cached = await eventsCache.getAll();
  console.log('[Events] DB count:', rows.length);
  console.log('[Events] Cache count:', cached?.length ?? 0);
  console.log('[Events] Current event ID:', cached?.find((e) => e.isCurrent)?.id ?? 'none');
}

async function checkFixtures() {
  const db = await getDb();
  const rows = await db.select().from(eventFixtures);
  const cached = await fixturesCache.getAll();
  console.log('[Fixtures] DB count:', rows.length);
  console.log('[Fixtures] Cache count:', cached?.length ?? 0);
}

async function checkPhases() {
  const db = await getDb();
  const rows = await db.select().from(phases);
  const cached = await phasesCache.getAll();
  console.log('[Phases] DB count:', rows.length);
  console.log('[Phases] Cache count:', cached?.length ?? 0);
}

async function checkPlayers() {
  const db = await getDb();
  const rows = await db.select().from(players);
  const cached = await playersCache.get();
  console.log('[Players] DB count:', rows.length);
  console.log('[Players] Cache count:', cached?.length ?? 0);
}

async function checkPlayerStats() {
  const db = await getDb();
  const rows = await db.select().from(playerStats);
  const latestEventId = await playerStatsCache.getLatestEventId();
  const cached = latestEventId ? await playerStatsCache.getByEvent(latestEventId) : null;
  console.log('[PlayerStats] DB count:', rows.length);
  console.log('[PlayerStats] Latest cached event:', latestEventId ?? 'none');
  console.log('[PlayerStats] Cache count for latest event:', cached?.length ?? 0);
}

async function checkPlayerValues() {
  const db = await getDb();
  const rows = await db.select().from(playerValues);
  const latestDate = rows.reduce<string | null>((acc, row) => {
    if (!acc) return row.changeDate ?? null;
    if (!row.changeDate) return acc;
    return row.changeDate > acc ? row.changeDate : acc;
  }, null);
  const cached = latestDate ? await playerValuesCache.getByDate(latestDate) : null;
  console.log('[PlayerValues] DB count:', rows.length);
  console.log('[PlayerValues] Latest change date:', latestDate ?? 'none');
  console.log('[PlayerValues] Cache count for latest date:', cached?.length ?? 0);
}

async function checkTeams() {
  const db = await getDb();
  const rows = await db.select().from(teams);
  const cached = await teamsCache.getAll();
  console.log('[Teams] DB count:', rows.length);
  console.log('[Teams] Cache count:', cached?.length ?? 0);
}

async function main() {
  const domain = process.argv[2];

  try {
    switch (domain) {
      case 'events':
        await checkEvents();
        break;
      case 'fixtures':
        await checkFixtures();
        break;
      case 'phases':
        await checkPhases();
        break;
      case 'player-stats':
        await checkPlayerStats();
        break;
      case 'player-values':
        await checkPlayerValues();
        break;
      case 'players':
        await checkPlayers();
        break;
      case 'teams':
        await checkTeams();
        break;
      default:
        console.error(
          'Usage: bun run scripts/check-state.ts <events|fixtures|phases|player-stats|player-values|players|teams>',
        );
        process.exitCode = 1;
        return;
    }
  } finally {
    await databaseSingleton.disconnect();
    await redisSingleton.disconnect();
  }
}

main().catch((error) => {
  console.error('Check failed:', error);
  process.exit(1);
});
