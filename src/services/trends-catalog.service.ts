import { createHash } from 'node:crypto';
import { getDbClient } from '../db/singleton';
import { seasonRepository } from '../repositories/seasons';
import { ValidationError } from '../utils/errors';

export async function getPublicTrendsCatalog(seasonCode: string) {
  const season = await seasonRepository.requireByCode(seasonCode);
  const client = await getDbClient();
  const rows = await client<
    Array<Record<string, unknown>>
  >`SELECT catalog.tournament_id, catalog.display_name, catalog.sort_order, catalog.enabled,
        tournament.setup_status,
        latest.event_id AS latest_event_id, latest.revision, latest.publication_state,
        latest.ownership_state, latest.captaincy_state, latest.vice_captaincy_state,
        latest.transfers_state, latest.published_at
      FROM competition.public_league_trends catalog
      JOIN competition.tournaments tournament
        ON tournament.season_id = catalog.season_id AND tournament.tournament_id = catalog.tournament_id
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
  const revision = createHash('sha256')
    .update(
      JSON.stringify(
        rows.map((row) => ({
          tournamentId: Number(row.tournament_id),
          displayName: String(row.display_name),
          sortOrder: Number(row.sort_order),
          enabled: Boolean(row.enabled) && row.setup_status === 'ready',
          setupStatus: row.setup_status,
          latestEventId: row.latest_event_id == null ? null : Number(row.latest_event_id),
          publicationRevision: row.revision == null ? null : Number(row.revision),
          publicationState: row.publication_state ?? 'NOT_YET_CAPTURED',
          ownershipState: row.ownership_state ?? 'NOT_READY',
          captaincyState: row.captaincy_state ?? 'NOT_READY',
          viceCaptaincyState: row.vice_captaincy_state ?? 'NOT_READY',
          transfersState: row.transfers_state ?? 'NOT_READY',
          publishedAt: row.published_at == null ? null : String(row.published_at),
        })),
      ),
    )
    .digest('hex');
  return {
    season: season.seasonCode,
    revision,
    cohorts: rows.map((row) => ({
      id: `competition:${Number(row.tournament_id)}`,
      tournamentId: Number(row.tournament_id),
      displayName: String(row.display_name),
      sortOrder: Number(row.sort_order),
      enabled: Boolean(row.enabled) && row.setup_status === 'ready',
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
  const requestedDisplayName = values.displayName?.trim();
  if (values.displayName !== undefined && !requestedDisplayName) {
    throw new ValidationError(
      'displayName must contain a non-whitespace character',
      'TRENDS_CATALOG_DISPLAY_NAME_INVALID',
    );
  }

  return client.begin(async (tx) => {
    const tournamentRows = await tx<Array<{ tournament_id: number; setup_status: string }>>`
      SELECT tournament_id, setup_status
      FROM competition.tournaments
      WHERE season_id = ${season.seasonId} AND tournament_id = ${tournamentId}
      FOR SHARE
    `;
    const tournament = tournamentRows[0];
    if (!tournament) return null;

    // Lock an existing catalog row so two partial updates cannot restore stale
    // omitted fields after reading the same prior value.
    const current = await tx<Array<{ display_name: string; sort_order: number; enabled: boolean }>>`
      SELECT display_name, sort_order, enabled
      FROM competition.public_league_trends
      WHERE season_id = ${season.seasonId} AND tournament_id = ${tournamentId}
      FOR UPDATE
    `;
    const existing = current[0];
    const disabling = values.enabled === false;
    if (!existing && tournament.setup_status !== 'ready') return null;
    if (existing && tournament.setup_status !== 'ready' && !disabling) return null;
    if (!existing && !requestedDisplayName) {
      throw new ValidationError(
        'displayName is required for a new catalog entry',
        'TRENDS_CATALOG_DISPLAY_NAME_REQUIRED',
      );
    }

    const result = await tx<Array<Record<string, unknown>>>`
      INSERT INTO competition.public_league_trends
        (season_id, tournament_id, display_name, sort_order, enabled, published_at, created_at, updated_at)
      VALUES (
        ${season.seasonId}, ${tournamentId}, ${requestedDisplayName ?? existing?.display_name},
        ${values.sortOrder ?? existing?.sort_order ?? 0}, ${values.enabled ?? existing?.enabled ?? false},
        now(), now(), now()
      )
      ON CONFLICT (season_id, tournament_id) DO UPDATE SET
        display_name = CASE WHEN ${requestedDisplayName !== undefined} THEN EXCLUDED.display_name ELSE competition.public_league_trends.display_name END,
        sort_order = CASE WHEN ${values.sortOrder !== undefined} THEN EXCLUDED.sort_order ELSE competition.public_league_trends.sort_order END,
        enabled = CASE WHEN ${values.enabled !== undefined} THEN EXCLUDED.enabled ELSE competition.public_league_trends.enabled END,
        updated_at = now()
      RETURNING tournament_id, display_name, sort_order, enabled, updated_at`;
    const row = result[0];
    if (!row) return null;
    return {
      tournamentId: Number(row.tournament_id),
      displayName: String(row.display_name),
      sortOrder: Number(row.sort_order),
      enabled: Boolean(row.enabled),
      updatedAt: row.updated_at == null ? null : String(row.updated_at),
    };
  });
}
