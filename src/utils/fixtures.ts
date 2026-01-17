import { eq } from 'drizzle-orm';

import { getDb } from '../db/singleton';
import { eventFixtures } from '../db/schemas/index.schema';
import type { Fixture } from '../types';

function mapRowToFixture(row: typeof eventFixtures.$inferSelect): Fixture {
  return {
    id: row.id,
    code: row.code,
    event: row.eventId,
    finished: row.finished,
    finishedProvisional: row.finishedProvisional,
    kickoffTime: row.kickoffTime,
    minutes: row.minutes,
    provisionalStartTime: row.provisionalStartTime,
    started: row.started,
    teamA: row.teamAId,
    teamAScore: row.teamAScore,
    teamH: row.teamHId,
    teamHScore: row.teamHScore,
    stats: row.stats,
    teamHDifficulty: row.teamHDifficulty,
    teamADifficulty: row.teamADifficulty,
    pulseId: row.pulseId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function loadFixturesByEvent(eventId: number): Promise<Fixture[]> {
  const db = await getDb();
  const rows = await db.select().from(eventFixtures).where(eq(eventFixtures.eventId, eventId));
  return rows.map(mapRowToFixture);
}

export async function loadAllFixtures(): Promise<Fixture[]> {
  const db = await getDb();
  const rows = await db.select().from(eventFixtures).orderBy(eventFixtures.id);
  return rows.map(mapRowToFixture);
}
