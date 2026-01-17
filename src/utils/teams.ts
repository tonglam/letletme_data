import { getDb } from '../db/singleton';
import { teams } from '../db/schemas/index.schema';

export type TeamIdentity = { id: number; name: string; shortName: string };

export async function loadTeamsBasicInfo(): Promise<TeamIdentity[]> {
  const db = await getDb();
  const rows = await db
    .select({ id: teams.id, name: teams.name, shortName: teams.shortName })
    .from(teams);
  return rows;
}
