import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, getDbClient, type DbOrTransaction } from '../db/singleton';
import { seasonRepository } from '../repositories/seasons';
import { ValidationError } from '../utils/errors';

export type PublicTrendFreshnessEvidence = Readonly<{
  revision: string;
  catalogRevision: string;
  expectedCohortCount: number;
  observedCohortCount: number;
  expectedEntryCount: number;
  observedRowCount: number;
  pgPublishedAt: Date | null;
  sourceCheckedAt: Date | null;
  complete: boolean;
  cohorts: readonly Readonly<{
    tournamentId: number;
    displayName: string;
    sortOrder: number;
    publicationId: number | null;
    publicationRevision: number | null;
    sourceChecksum: string | null;
    publicationState: string;
    ownershipState: string;
    captaincyState: string;
    viceCaptaincyState: string;
    transfersState: string;
    expectedEntries: number;
    completePickEntries: number;
    transferCheckpointEntries: number;
    rowCount: number;
    sourceWatermark: Date | null;
    publishedAt: Date | null;
    setupStatus: string;
  }>[];
}>;

function timestampOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const timestamp = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(timestamp.getTime()) ? timestamp : null;
}

function buildPublicTrendFreshnessEvidence(
  rows: readonly Record<string, unknown>[],
): PublicTrendFreshnessEvidence {
  const cohorts = rows.map((row) => ({
    tournamentId: Number(row.tournament_id),
    displayName: String(row.display_name),
    sortOrder: Number(row.sort_order),
    publicationId: row.publication_id == null ? null : Number(row.publication_id),
    publicationRevision: row.revision == null ? null : Number(row.revision),
    sourceChecksum:
      typeof row.source_checksum === 'string' && /^[0-9a-f]{64}$/.test(row.source_checksum)
        ? row.source_checksum
        : null,
    publicationState: String(row.publication_state ?? 'NOT_READY'),
    ownershipState: String(row.ownership_state ?? 'NOT_READY'),
    captaincyState: String(row.captaincy_state ?? 'NOT_READY'),
    viceCaptaincyState: String(row.vice_captaincy_state ?? 'NOT_READY'),
    transfersState: String(row.transfers_state ?? 'NOT_READY'),
    expectedEntries: Number(row.expected_entries ?? 0),
    completePickEntries: Number(row.complete_pick_entries ?? 0),
    transferCheckpointEntries: Number(row.transfer_checkpoint_entries ?? 0),
    rowCount: Number(row.row_count ?? 0),
    sourceWatermark: timestampOrNull(row.source_watermark),
    publishedAt: timestampOrNull(row.published_at),
    setupStatus: String(row.setup_status),
  }));
  const catalogRevision = createHash('sha256')
    .update(
      cohorts
        .map((cohort) => `${cohort.tournamentId}:${cohort.displayName}:${cohort.sortOrder}`)
        .join('|'),
    )
    .digest('hex');
  const revision = `public-trends-v1:${createHash('sha256')
    .update(
      cohorts
        .map(
          (cohort) =>
            `${cohort.tournamentId}:${cohort.publicationId ?? ''}:${cohort.publicationRevision ?? ''}:${cohort.sourceChecksum ?? ''}:${cohort.publicationState}:${cohort.ownershipState}:${cohort.captaincyState}:${cohort.viceCaptaincyState}:${cohort.transfersState}:${cohort.expectedEntries}:${cohort.completePickEntries}:${cohort.transferCheckpointEntries}:${cohort.rowCount}:${cohort.sourceWatermark?.toISOString() ?? ''}:${cohort.publishedAt?.toISOString() ?? ''}`,
        )
        .join('|'),
    )
    .digest('hex')}`;
  const complete =
    cohorts.length > 0 &&
    cohorts.every(
      (cohort) =>
        cohort.setupStatus === 'ready' &&
        cohort.publicationId !== null &&
        cohort.sourceChecksum !== null &&
        cohort.sourceWatermark !== null &&
        cohort.publicationState === 'READY' &&
        cohort.ownershipState === 'READY' &&
        cohort.captaincyState === 'READY' &&
        cohort.viceCaptaincyState === 'READY' &&
        cohort.transfersState === 'READY' &&
        cohort.expectedEntries > 0 &&
        cohort.completePickEntries === cohort.expectedEntries &&
        cohort.transferCheckpointEntries === cohort.expectedEntries &&
        cohort.rowCount > 0,
    );
  const publishedAt = cohorts.reduce<Date | null>(
    (latest, cohort) =>
      cohort.publishedAt && (!latest || cohort.publishedAt > latest) ? cohort.publishedAt : latest,
    null,
  );
  // A multi-cohort contract is only as fresh as its oldest source input.
  // Publication time remains a separate PostgreSQL milestone and must never
  // be substituted for the provider-derived watermark.
  const sourceWatermark = cohorts.reduce<Date | null>(
    (oldest, cohort) =>
      cohort.sourceWatermark && (!oldest || cohort.sourceWatermark < oldest)
        ? cohort.sourceWatermark
        : oldest,
    null,
  );
  return {
    revision,
    catalogRevision,
    expectedCohortCount: cohorts.length,
    observedCohortCount: cohorts.filter((cohort) => cohort.publicationState === 'READY').length,
    expectedEntryCount: cohorts.reduce((sum, cohort) => sum + cohort.expectedEntries, 0),
    observedRowCount: cohorts.reduce((sum, cohort) => sum + cohort.rowCount, 0),
    pgPublishedAt: publishedAt,
    sourceCheckedAt: sourceWatermark,
    complete,
    cohorts,
  };
}

/**
 * Transaction-aware form used by the governance terminal transition. With
 * `lock=true`, catalog enablement and immutable publication evidence cannot
 * change between validation and the caller's update.
 */
export async function readPublicTrendFreshnessEvidenceBySeasonId(
  seasonId: number,
  eventId: number,
  options: Readonly<{ db?: DbOrTransaction; lock?: boolean }> = {},
): Promise<PublicTrendFreshnessEvidence> {
  if (!Number.isSafeInteger(seasonId) || seasonId <= 0) {
    throw new ValidationError('Public Trends season id is invalid', 'PUBLIC_TRENDS_SEASON_INVALID');
  }
  if (!Number.isSafeInteger(eventId) || eventId <= 0 || eventId > 38) {
    throw new ValidationError('Public Trends event id is invalid', 'PUBLIC_TRENDS_EVENT_INVALID');
  }
  const db = options.db ?? (await getDb());
  if (options.lock) {
    await db.execute(sql`
      LOCK TABLE fpl.events,
        competition.public_league_trends,
        competition.tournaments,
        reporting.tournament_selection_stat_publications,
        reporting.tournament_selection_stat_rows
      IN SHARE MODE
    `);
  }
  const rows = (await db.execute(sql`
    SELECT catalog.tournament_id, catalog.display_name, catalog.sort_order,
      tournament.setup_status,
      latest.publication_id, latest.revision, latest.source_checksum, latest.publication_state,
      latest.ownership_state, latest.captaincy_state, latest.vice_captaincy_state,
      latest.transfers_state, latest.expected_entries, latest.complete_pick_entries,
      latest.transfer_checkpoint_entries, latest.source_watermark, latest.published_at,
      COALESCE(snapshot.row_count, 0)::int AS row_count
    FROM competition.public_league_trends catalog
    JOIN competition.tournaments tournament
      ON tournament.season_id = catalog.season_id
      AND tournament.tournament_id = catalog.tournament_id
    LEFT JOIN LATERAL (
      SELECT publication.publication_id, publication.revision, publication.source_checksum,
        publication.publication_state,
        publication.ownership_state, publication.captaincy_state,
        publication.vice_captaincy_state, publication.transfers_state,
        publication.expected_entries, publication.complete_pick_entries,
        publication.transfer_checkpoint_entries, publication.source_watermark,
        publication.published_at
      FROM reporting.tournament_selection_stat_publications publication
      WHERE publication.season_id = catalog.season_id
        AND publication.tournament_id = catalog.tournament_id
        AND publication.event_id = ${eventId}
        AND publication.is_active
      ORDER BY publication.revision DESC
      LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS row_count
      FROM reporting.tournament_selection_stat_rows snapshot_row
      WHERE snapshot_row.publication_id = latest.publication_id
    ) snapshot ON true
    WHERE catalog.season_id = ${seasonId}
      AND catalog.enabled
    ORDER BY catalog.sort_order, catalog.tournament_id
  `)) as unknown as readonly Record<string, unknown>[];
  return buildPublicTrendFreshnessEvidence(rows);
}

/**
 * Read the public-trends publication window from PostgreSQL. The result is a
 * stable producer revision and deliberately contains counts/checksums only;
 * participant rows and identities never leave this authority boundary.
 */
export async function readPublicTrendFreshnessEvidence(
  seasonCode: string,
  eventId: number,
): Promise<PublicTrendFreshnessEvidence> {
  const season = await seasonRepository.requireByCode(seasonCode);
  return readPublicTrendFreshnessEvidenceBySeasonId(season.seasonId, eventId);
}

/**
 * Select every configured, setup-complete catalog scope that the repair lane
 * may prepublish. Disabled rows are included deliberately so a cohort can be
 * made durable before the public enablement transaction checks it.
 */
export async function findPublicTrendRepairTournamentIds(seasonCode: string): Promise<number[]> {
  const season = await seasonRepository.requireByCode(seasonCode);
  const client = await getDbClient();
  const rows = await client<Array<{ tournament_id: number }>>`
    SELECT catalog.tournament_id
    FROM competition.public_league_trends catalog
    JOIN competition.tournaments tournament
      ON tournament.season_id = catalog.season_id
      AND tournament.tournament_id = catalog.tournament_id
    WHERE catalog.season_id = ${season.seasonId}
      AND tournament.setup_status = 'ready'
    ORDER BY catalog.sort_order, catalog.tournament_id
  `;
  return rows.map((row) => Number(row.tournament_id));
}

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

    // Public visibility is a publication boundary. Do not let a catalog row
    // become visible before the current event has a complete, checksummed
    // publication for this exact tournament. The repair job can publish an
    // explicitly selected disabled cohort first, after which this API enables
    // it without exposing a partial snapshot.
    if (values.enabled === true) {
      const readyCurrentEvent = await tx<Array<{ event_id: number }>>`
        SELECT event.event_id
        FROM fpl.events event
        JOIN reporting.tournament_selection_stat_publications publication
          ON publication.season_id = event.season_id
          AND publication.tournament_id = ${tournamentId}
          AND publication.event_id = event.event_id
          AND publication.is_active
        WHERE event.season_id = ${season.seasonId}
          AND event.is_current
          AND publication.publication_state = 'READY'
          AND publication.source_checksum ~ '^[0-9a-f]{64}$'
          AND publication.expected_entries > 0
          AND publication.complete_pick_entries = publication.expected_entries
          AND publication.transfer_checkpoint_entries = publication.expected_entries
          AND publication.ownership_state = 'READY'
          AND publication.captaincy_state = 'READY'
          AND publication.vice_captaincy_state = 'READY'
          AND publication.transfers_state = 'READY'
          AND EXISTS (
            SELECT 1
            FROM reporting.tournament_selection_stat_rows snapshot_row
            WHERE snapshot_row.publication_id = publication.publication_id
          )
        LIMIT 1
        FOR SHARE OF event, publication
      `;
      if (!readyCurrentEvent[0]) {
        throw new ValidationError(
          'current event publication is not complete for this public cohort',
          'TRENDS_CATALOG_PUBLICATION_NOT_READY',
        );
      }
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
