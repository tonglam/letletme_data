import { eq } from 'drizzle-orm';

import { teamsInFpl } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';

export type TeamIdentity = { id: number; name: string; shortName: string; pulseId: number };

export async function loadTeamsBasicInfo(season: FplSeasonRef): Promise<TeamIdentity[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: teamsInFpl.teamId,
      name: teamsInFpl.name,
      shortName: teamsInFpl.shortName,
      pulseId: teamsInFpl.pulseId,
    })
    .from(teamsInFpl)
    .where(eq(teamsInFpl.seasonId, season.seasonId));
  return rows;
}
