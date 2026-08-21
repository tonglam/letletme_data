import { createHash } from 'node:crypto';
import { getDbClient } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { logError, logInfo } from '../utils/logger';

type ScopeAudit = {
  expected_entries: number;
  complete_pick_entries: number;
  transfer_checkpoint_entries: number;
};

type TrendRow = {
  element_id: number;
  selected_count: number;
  effective_selection_count: number;
  captain_count: number;
  vice_captain_count: number;
  transfer_in_count: number | null;
  transfer_out_count: number | null;
  player_name: string;
  player_position: number;
  team_short_name: string;
};

function positiveInteger(value: unknown): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

/**
 * Publish one exact tournament/event scope.  The publication is immutable;
 * only the small active pointer changes.  This keeps reads bounded and makes
 * retries idempotent without refreshing the legacy global materialized view.
 */
export async function publishTournamentTrendScope(
  season: FplSeasonRef,
  tournamentId: number,
  eventId: number,
): Promise<{
  tournamentId: number;
  eventId: number;
  publicationId: number | null;
  revision: number | null;
  state: 'READY' | 'COLLECTING' | 'FAILED' | 'REUSED';
  ownershipState: string;
  transfersState: string;
  rows: number;
}> {
  if (!Number.isInteger(tournamentId) || tournamentId <= 0) {
    throw new Error('tournamentId must be a positive integer');
  }
  if (!Number.isInteger(eventId) || eventId < 1 || eventId > 38) {
    throw new Error('eventId must be between 1 and 38');
  }

  const client = await getDbClient();
  // Audit, checksum and row aggregation must observe one source snapshot. The
  // advisory lock only serializes publishers; source writers do not take it.
  return client.begin(async (tx) => {
    // PostgreSQL requires SET TRANSACTION before every other statement in the
    // transaction. The snapshot is established by the first query below.
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`trends:${season.seasonId}:${tournamentId}:${eventId}`}, 0))`;

    const auditRows = await tx<ScopeAudit[]>`
      SELECT
        count(*)::int AS expected_entries,
        count(*) FILTER (WHERE picks.complete)::int AS complete_pick_entries,
        count(*) FILTER (WHERE entry.transfers_synced_through_event_id >= ${eventId})::int AS transfer_checkpoint_entries
      FROM competition.tournament_entries roster
      JOIN competition.entries entry
        ON entry.season_id = roster.season_id AND entry.entry_id = roster.entry_id
      LEFT JOIN LATERAL (
        SELECT count(*) = 15
          AND min(pick.position) = 1
          AND max(pick.position) = 15
          AND count(*) FILTER (WHERE pick.is_captain) = 1
          AND count(*) FILTER (WHERE pick.is_vice_captain) = 1 AS complete
        FROM competition.entry_event_picks pick
        WHERE pick.season_id = roster.season_id
          AND pick.entry_id = roster.entry_id
          AND pick.event_id = ${eventId}
      ) picks ON true
      WHERE roster.season_id = ${season.seasonId}
        AND roster.tournament_id = ${tournamentId}
        AND (entry.started_event IS NULL OR entry.started_event <= ${eventId})
    `;
    const audit = auditRows[0] ?? {
      expected_entries: 0,
      complete_pick_entries: 0,
      transfer_checkpoint_entries: 0,
    };
    const expectedEntries = positiveInteger(audit.expected_entries);
    const completePickEntries = positiveInteger(audit.complete_pick_entries);
    const transferCheckpointEntries = positiveInteger(audit.transfer_checkpoint_entries);
    // An empty roster is a confirmed absence of a prepared competition, not a
    // complete observation. Keep it collecting so GraphQL cannot present an
    // empty array as a measured zero-population trend.
    const picksReady = expectedEntries > 0 && completePickEntries === expectedEntries;
    const transfersReady = expectedEntries > 0 && transferCheckpointEntries === expectedEntries;

    const sourceRows = await tx<
      Array<{
        source_watermark: Date | string | null;
        roster_checksum: string;
        player_metadata_checksum: string;
      }>
    >`
      SELECT NULLIF(GREATEST(
        COALESCE(max(pick.source_updated_at), '-infinity'::timestamptz),
        COALESCE(max(entry.updated_at), '-infinity'::timestamptz),
        COALESCE(max(transfer.updated_at), '-infinity'::timestamptz)
      ), '-infinity'::timestamptz) AS source_watermark,
      md5(COALESCE(string_agg(roster.entry_id::text, ',' ORDER BY roster.entry_id), '')) AS roster_checksum,
      md5(COALESCE((
        SELECT string_agg(
          format('%s:%s:%s:%s', metadata.element_id, metadata.player_name, metadata.player_position, metadata.team_short_name),
          ',' ORDER BY metadata.element_id
        )
        FROM (
          SELECT DISTINCT elements.element_id,
            COALESCE(NULLIF(concat_ws(' ', player.first_name, player.second_name), ''), player.web_name) AS player_name,
            player.element_type AS player_position,
            team.short_name AS team_short_name
          FROM (
            SELECT pick.element_id
            FROM competition.entry_event_picks pick
            JOIN competition.tournament_entries pick_roster
              ON pick_roster.season_id = pick.season_id AND pick_roster.entry_id = pick.entry_id
            WHERE pick.season_id = ${season.seasonId} AND pick.event_id = ${eventId}
              AND pick_roster.tournament_id = ${tournamentId}
            UNION
            SELECT transfer.element_in_id
            FROM competition.entry_event_transfers transfer
            JOIN competition.tournament_entries in_roster
              ON in_roster.season_id = transfer.season_id AND in_roster.entry_id = transfer.entry_id
            WHERE transfer.season_id = ${season.seasonId} AND transfer.event_id = ${eventId}
              AND in_roster.tournament_id = ${tournamentId} AND transfer.element_in_id IS NOT NULL
            UNION
            SELECT transfer.element_out_id
            FROM competition.entry_event_transfers transfer
            JOIN competition.tournament_entries out_roster
              ON out_roster.season_id = transfer.season_id AND out_roster.entry_id = transfer.entry_id
            WHERE transfer.season_id = ${season.seasonId} AND transfer.event_id = ${eventId}
              AND out_roster.tournament_id = ${tournamentId} AND transfer.element_out_id IS NOT NULL
          ) elements
          JOIN fpl.players player
            ON player.season_id = ${season.seasonId} AND player.element_id = elements.element_id
          JOIN fpl.teams team
            ON team.season_id = player.season_id AND team.team_id = player.team_id
        ) metadata
      ), '')) AS player_metadata_checksum
      FROM competition.tournament_entries roster
      JOIN competition.entries entry
        ON entry.season_id = roster.season_id AND entry.entry_id = roster.entry_id
      LEFT JOIN competition.entry_event_picks pick
        ON pick.season_id = roster.season_id AND pick.entry_id = roster.entry_id AND pick.event_id = ${eventId}
      LEFT JOIN competition.entry_event_transfers transfer
        ON transfer.season_id = roster.season_id AND transfer.entry_id = roster.entry_id AND transfer.event_id = ${eventId}
      WHERE roster.season_id = ${season.seasonId} AND roster.tournament_id = ${tournamentId}
    `;
    const sourceWatermarkValue = sourceRows[0]?.source_watermark ?? new Date(0);
    const sourceWatermark =
      sourceWatermarkValue instanceof Date ? sourceWatermarkValue : new Date(sourceWatermarkValue);
    if (!Number.isFinite(sourceWatermark.getTime())) {
      throw new Error('Tournament Trends source watermark is invalid');
    }
    const rosterChecksum = sourceRows[0]?.roster_checksum ?? 'd41d8cd98f00b204e9800998ecf8427e';
    const playerMetadataChecksum =
      sourceRows[0]?.player_metadata_checksum ?? 'd41d8cd98f00b204e9800998ecf8427e';
    const checksum = createHash('sha256')
      .update(
        `${season.seasonId}:${tournamentId}:${eventId}:${expectedEntries}:${completePickEntries}:${transferCheckpointEntries}:${sourceWatermark.toISOString()}:${rosterChecksum}:${playerMetadataChecksum}`,
      )
      .digest('hex');

    const existing = await tx<
      Array<{ publication_id: number; revision: number; publication_state: string }>
    >`
      SELECT publication_id, revision, publication_state
      FROM reporting.tournament_selection_stat_publications
      WHERE season_id = ${season.seasonId}
        AND tournament_id = ${tournamentId}
        AND event_id = ${eventId}
        AND source_checksum = ${checksum}
      ORDER BY revision DESC
      LIMIT 1
    `;
    if (
      existing[0]?.publication_state === 'READY' ||
      existing[0]?.publication_state === 'COLLECTING'
    ) {
      return {
        tournamentId,
        eventId,
        publicationId: Number(existing[0].publication_id),
        revision: Number(existing[0].revision),
        state: 'REUSED',
        ownershipState: picksReady ? 'READY' : 'NOT_READY',
        transfersState: transfersReady ? 'READY' : 'NOT_READY',
        rows: 0,
      };
    }

    const revisionRows = await tx<Array<{ revision: number }>>`
      SELECT COALESCE(max(revision), 0)::bigint + 1 AS revision
      FROM reporting.tournament_selection_stat_publications
      WHERE season_id = ${season.seasonId} AND tournament_id = ${tournamentId} AND event_id = ${eventId}
    `;
    const revision = Number(revisionRows[0]?.revision ?? 1);
    const publicationState = picksReady ? 'READY' : 'COLLECTING';
    const ownershipState = picksReady ? 'READY' : 'NOT_READY';
    const transfersState = transfersReady ? 'READY' : 'NOT_READY';
    const publishedAt = picksReady ? new Date().toISOString() : null;
    const inserted = await tx<Array<{ publication_id: number }>>`
      INSERT INTO reporting.tournament_selection_stat_publications (
        season_id, tournament_id, event_id, revision, publication_state, is_active,
        source_watermark, source_checksum, expected_entries, complete_pick_entries,
        transfer_checkpoint_entries, ownership_state, captaincy_state,
        vice_captaincy_state, transfers_state, published_at
      ) VALUES (
        ${season.seasonId}, ${tournamentId}, ${eventId}, ${revision}, ${publicationState}, false,
        ${sourceWatermark.toISOString()}::timestamptz, ${checksum}, ${expectedEntries}, ${completePickEntries},
        ${transferCheckpointEntries}, ${ownershipState}, ${ownershipState},
        ${ownershipState}, ${transfersState}, ${publishedAt}::timestamptz
      ) RETURNING publication_id
    `;
    const publicationId = Number(inserted[0].publication_id);
    let rows = 0;
    if (picksReady) {
      const trendRows = await tx<TrendRow[]>`
        WITH eligible AS (
          SELECT roster.entry_id
          FROM competition.tournament_entries roster
          JOIN competition.entries entry
            ON entry.season_id = roster.season_id AND entry.entry_id = roster.entry_id
          WHERE roster.season_id = ${season.seasonId} AND roster.tournament_id = ${tournamentId}
            AND (entry.started_event IS NULL OR entry.started_event <= ${eventId})
        ), transfer_counts AS (
          SELECT element_in_id AS element_id, count(*)::int AS transfer_in_count, 0::int AS transfer_out_count
          FROM competition.entry_event_transfers transfer
          JOIN eligible ON eligible.entry_id = transfer.entry_id
          WHERE transfer.season_id = ${season.seasonId} AND transfer.event_id = ${eventId}
            AND transfer.element_in_id IS NOT NULL
          GROUP BY element_in_id
          UNION ALL
          SELECT element_out_id AS element_id, 0::int, count(*)::int
          FROM competition.entry_event_transfers transfer
          JOIN eligible ON eligible.entry_id = transfer.entry_id
          WHERE transfer.season_id = ${season.seasonId} AND transfer.event_id = ${eventId}
            AND transfer.element_out_id IS NOT NULL
          GROUP BY element_out_id
        ), transfer_totals AS (
          SELECT element_id, sum(transfer_in_count)::int AS transfer_in_count,
            sum(transfer_out_count)::int AS transfer_out_count
          FROM transfer_counts GROUP BY element_id
        ), pick_totals AS (
          SELECT pick.element_id,
            count(*)::int AS selected_count,
            sum(pick.multiplier)::int AS effective_selection_count,
            count(*) FILTER (WHERE pick.is_captain)::int AS captain_count,
            count(*) FILTER (WHERE pick.is_vice_captain)::int AS vice_captain_count
          FROM eligible
          JOIN competition.entry_event_picks pick
            ON pick.season_id = ${season.seasonId} AND pick.entry_id = eligible.entry_id AND pick.event_id = ${eventId}
          GROUP BY pick.element_id
        ), element_ids AS (
          SELECT element_id FROM pick_totals
          UNION
          SELECT element_id FROM transfer_totals
        )
        SELECT element_ids.element_id,
          COALESCE(pick_totals.selected_count, 0)::int AS selected_count,
          COALESCE(pick_totals.effective_selection_count, 0)::int AS effective_selection_count,
          COALESCE(pick_totals.captain_count, 0)::int AS captain_count,
          COALESCE(pick_totals.vice_captain_count, 0)::int AS vice_captain_count,
          CASE WHEN ${transfersReady} THEN COALESCE(max(transfer_totals.transfer_in_count), 0)::int ELSE NULL END AS transfer_in_count,
          CASE WHEN ${transfersReady} THEN COALESCE(max(transfer_totals.transfer_out_count), 0)::int ELSE NULL END AS transfer_out_count,
          COALESCE(NULLIF(concat_ws(' ', player.first_name, player.second_name), ''), player.web_name) AS player_name,
          player.element_type AS player_position,
          team.short_name AS team_short_name
        FROM element_ids
        LEFT JOIN pick_totals ON pick_totals.element_id = element_ids.element_id
        JOIN fpl.players player
          ON player.season_id = ${season.seasonId} AND player.element_id = element_ids.element_id
        JOIN fpl.teams team
          ON team.season_id = player.season_id AND team.team_id = player.team_id
        LEFT JOIN transfer_totals ON transfer_totals.element_id = element_ids.element_id
        GROUP BY element_ids.element_id, pick_totals.selected_count, pick_totals.effective_selection_count,
          pick_totals.captain_count, pick_totals.vice_captain_count,
          player.first_name, player.second_name, player.web_name, player.element_type, team.short_name
        ORDER BY element_ids.element_id
      `;
      for (const row of trendRows) {
        await tx`
          INSERT INTO reporting.tournament_selection_stat_rows (
            publication_id, element_id, selected_count, effective_selection_count,
            captain_count, vice_captain_count, transfer_in_count, transfer_out_count,
            player_name, player_position, team_short_name
          ) VALUES (
            ${publicationId}, ${row.element_id}, ${row.selected_count}, ${row.effective_selection_count},
            ${row.captain_count}, ${row.vice_captain_count}, ${row.transfer_in_count}, ${row.transfer_out_count},
            ${row.player_name}, ${row.player_position}, ${row.team_short_name}
          )
        `;
        rows += 1;
      }
      await tx`
        UPDATE reporting.tournament_selection_stat_publications
        SET is_active = false
        WHERE season_id = ${season.seasonId} AND tournament_id = ${tournamentId} AND event_id = ${eventId}
          AND is_active
      `;
      await tx`
        UPDATE reporting.tournament_selection_stat_publications
        SET is_active = true
        WHERE publication_id = ${publicationId}
      `;
    }

    logInfo('Published tournament trends scope', {
      season: season.seasonCode,
      tournamentId,
      eventId,
      publicationId,
      revision,
      publicationState,
      rows,
      transfersState,
    });
    return {
      tournamentId,
      eventId,
      publicationId,
      revision,
      state: publicationState,
      ownershipState,
      transfersState,
      rows,
    };
  });
}

export async function publishTournamentTrendScopes(
  season: FplSeasonRef,
  eventId: number,
  tournamentIds: readonly number[],
): Promise<{
  succeeded: number;
  failed: number;
  results: Awaited<ReturnType<typeof publishTournamentTrendScope>>[];
}> {
  const results: Awaited<ReturnType<typeof publishTournamentTrendScope>>[] = [];
  let failed = 0;
  for (const tournamentId of [...new Set(tournamentIds)].filter(
    (id) => Number.isInteger(id) && id > 0,
  )) {
    try {
      results.push(await publishTournamentTrendScope(season, tournamentId, eventId));
    } catch (error) {
      failed += 1;
      logError('Tournament trends scope publication failed', error, {
        season: season.seasonCode,
        tournamentId,
        eventId,
      });
    }
  }
  return { succeeded: results.length, failed, results };
}
