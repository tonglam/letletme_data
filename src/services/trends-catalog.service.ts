import { getDbClient } from '../db/singleton';
import { seasonRepository } from '../repositories/seasons';

export async function getPublicTrendsCatalog(seasonCode: string) {
  const season = await seasonRepository.requireByCode(seasonCode);
  const client = await getDbClient();
  const rows = await client<
    Array<Record<string, unknown>>
  >`SELECT catalog.tournament_id, catalog.display_name, catalog.sort_order, catalog.enabled,
        latest.event_id AS latest_event_id, latest.revision, latest.publication_state,
        latest.ownership_state, latest.captaincy_state, latest.vice_captaincy_state,
        latest.transfers_state, latest.published_at
      FROM competition.public_league_trends catalog
      LEFT JOIN LATERAL (
        SELECT publication.event_id, publication.revision, publication.publication_state,
          publication.ownership_state, publication.captaincy_state,
          publication.vice_captaincy_state, publication.transfers_state, publication.published_at
        FROM reporting.tournament_selection_stat_publications publication
        WHERE publication.season_id = catalog.season_id
          AND publication.tournament_id = catalog.tournament_id
          AND publication.is_active
        ORDER BY publication.event_id DESC, publication.revision DESC
        LIMIT 1
      ) latest ON true
      WHERE catalog.season_id = ${season.seasonId}
      ORDER BY catalog.sort_order, catalog.tournament_id`;
  return {
    season: season.seasonCode,
    revision: rows.map((row) => `${row.tournament_id}:${row.revision ?? 'none'}`).join('|'),
    cohorts: rows.map((row) => ({
      id: `competition:${Number(row.tournament_id)}`,
      tournamentId: Number(row.tournament_id),
      displayName: String(row.display_name),
      sortOrder: Number(row.sort_order),
      enabled: Boolean(row.enabled),
      latestEventId: row.latest_event_id == null ? null : Number(row.latest_event_id),
      revision: row.revision == null ? null : Number(row.revision),
      publicationState: row.publication_state ?? 'NOT_YET_CAPTURED',
      capabilities: {
        ownership: row.ownership_state ?? 'NOT_READY',
        captaincy: row.captaincy_state ?? 'NOT_READY',
        viceCaptaincy: row.vice_captaincy_state ?? 'NOT_READY',
        transfers: row.transfers_state ?? 'NOT_READY',
      },
      access: 'PUBLIC' as const,
      kind: 'TRACKED_OFFICIAL_COMPETITION' as const,
      exact: true,
    })),
  };
}

export async function updatePublicTrendsCatalog(
  seasonCode: string,
  tournamentId: number,
  values: { displayName?: string; sortOrder?: number; enabled?: boolean },
) {
  const season = await seasonRepository.requireByCode(seasonCode);
  const client = await getDbClient();
  const tournaments = await client<Array<{ tournament_id: number }>>`
    SELECT tournament_id FROM competition.tournaments
    WHERE season_id = ${season.seasonId} AND tournament_id = ${tournamentId} AND setup_status = 'ready'
  `;
  if (tournaments.length === 0) return null;
  const current = await client<
    Array<{ display_name: string; sort_order: number; enabled: boolean }>
  >`
    SELECT display_name, sort_order, enabled FROM competition.public_league_trends
    WHERE season_id = ${season.seasonId} AND tournament_id = ${tournamentId}
  `;
  const existing = current[0];
  if (!existing && !values.displayName)
    throw new Error('displayName is required for a new catalog entry');
  const result = await client<
    Array<Record<string, unknown>>
  >`INSERT INTO competition.public_league_trends
      (season_id, tournament_id, display_name, sort_order, enabled, published_at, created_at, updated_at)
     VALUES (${season.seasonId}, ${tournamentId}, ${values.displayName ?? existing?.display_name},
       ${values.sortOrder ?? existing?.sort_order ?? 0}, ${values.enabled ?? existing?.enabled ?? false}, now(), now(), now())
     ON CONFLICT (season_id, tournament_id) DO UPDATE SET
       display_name = EXCLUDED.display_name, sort_order = EXCLUDED.sort_order,
       enabled = EXCLUDED.enabled, updated_at = now()
     RETURNING tournament_id, display_name, sort_order, enabled, updated_at`;
  return result[0] ?? null;
}
