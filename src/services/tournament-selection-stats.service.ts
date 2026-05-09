import { getDbClient } from '../db/singleton';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type TournamentEntrySourceRow = {
  tournamentId: number;
  entryId: number;
};

type PickSourceRow = {
  entryId: number;
  picks: unknown;
};

type TransferSourceRow = {
  entryId: number;
  elementInId: number | null;
  elementOutId: number | null;
};

export type TournamentSelectionStatRow = {
  tournamentId: number;
  eventId: number;
  elementId: number;
  pickCount: number;
  captainCount: number;
  viceCaptainCount: number;
  transferInCount: number;
  transferOutCount: number;
  totalEntries: number;
};

type PickItem = Record<string, unknown>;

function asPositiveInt(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isTrueFlag(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizePicks(raw: unknown): PickItem[] {
  return Array.isArray(raw)
    ? (raw.filter((item) => item && typeof item === 'object') as PickItem[])
    : [];
}

function getPickElementId(pick: PickItem): number | null {
  return asPositiveInt(pick.element ?? pick.element_id ?? pick.elementId);
}

function isCaptainPick(pick: PickItem): boolean {
  return isTrueFlag(pick.is_captain ?? pick.isCaptain ?? pick.captain);
}

function isViceCaptainPick(pick: PickItem): boolean {
  return isTrueFlag(pick.is_vice_captain ?? pick.isViceCaptain ?? pick.viceCaptain);
}

function statKey(tournamentId: number, elementId: number): string {
  return `${tournamentId}:${elementId}`;
}

function getOrCreateStat(
  rowsByKey: Map<string, TournamentSelectionStatRow>,
  tournamentId: number,
  eventId: number,
  elementId: number,
  totalEntries: number,
): TournamentSelectionStatRow {
  const key = statKey(tournamentId, elementId);
  const existing = rowsByKey.get(key);
  if (existing) {
    return existing;
  }

  const row: TournamentSelectionStatRow = {
    tournamentId,
    eventId,
    elementId,
    pickCount: 0,
    captainCount: 0,
    viceCaptainCount: 0,
    transferInCount: 0,
    transferOutCount: 0,
    totalEntries,
  };
  rowsByKey.set(key, row);
  return row;
}

export function aggregateTournamentSelectionStatsRows(params: {
  eventId: number;
  tournamentEntries: TournamentEntrySourceRow[];
  pickRows: PickSourceRow[];
  transferRows: TransferSourceRow[];
}): TournamentSelectionStatRow[] {
  const { eventId, tournamentEntries, pickRows, transferRows } = params;
  const tournamentsByEntry = new Map<number, Set<number>>();
  const entriesByTournament = new Map<number, Set<number>>();

  for (const row of tournamentEntries) {
    if (!Number.isFinite(row.tournamentId) || !Number.isFinite(row.entryId)) continue;

    const tournamentSet = tournamentsByEntry.get(row.entryId) ?? new Set<number>();
    tournamentSet.add(row.tournamentId);
    tournamentsByEntry.set(row.entryId, tournamentSet);

    const entrySet = entriesByTournament.get(row.tournamentId) ?? new Set<number>();
    entrySet.add(row.entryId);
    entriesByTournament.set(row.tournamentId, entrySet);
  }

  const totalEntriesByTournament = new Map<number, number>();
  for (const [tournamentId, entries] of entriesByTournament) {
    totalEntriesByTournament.set(tournamentId, entries.size);
  }

  const rowsByKey = new Map<string, TournamentSelectionStatRow>();

  for (const row of pickRows) {
    const tournamentIds = tournamentsByEntry.get(row.entryId);
    if (!tournamentIds || tournamentIds.size === 0) continue;

    for (const pick of normalizePicks(row.picks)) {
      const elementId = getPickElementId(pick);
      if (!elementId) continue;

      for (const tournamentId of tournamentIds) {
        const stat = getOrCreateStat(
          rowsByKey,
          tournamentId,
          eventId,
          elementId,
          totalEntriesByTournament.get(tournamentId) ?? 0,
        );
        stat.pickCount += 1;
        if (isCaptainPick(pick)) stat.captainCount += 1;
        if (isViceCaptainPick(pick)) stat.viceCaptainCount += 1;
      }
    }
  }

  for (const row of transferRows) {
    const tournamentIds = tournamentsByEntry.get(row.entryId);
    if (!tournamentIds || tournamentIds.size === 0) continue;

    for (const tournamentId of tournamentIds) {
      const totalEntries = totalEntriesByTournament.get(tournamentId) ?? 0;
      if (row.elementInId) {
        getOrCreateStat(
          rowsByKey,
          tournamentId,
          eventId,
          row.elementInId,
          totalEntries,
        ).transferInCount += 1;
      }
      if (row.elementOutId) {
        getOrCreateStat(
          rowsByKey,
          tournamentId,
          eventId,
          row.elementOutId,
          totalEntries,
        ).transferOutCount += 1;
      }
    }
  }

  return [...rowsByKey.values()].sort(
    (a, b) => a.tournamentId - b.tournamentId || a.elementId - b.elementId,
  );
}

async function loadTournamentEntries(tournamentIds: number[]): Promise<TournamentEntrySourceRow[]> {
  if (tournamentIds.length === 0) return [];
  const client = await getDbClient();
  const rows = await client<{ tournament_id: number; entry_id: number }[]>`
    select tournament_id, entry_id
    from tournament_entries
    where tournament_id = any(${tournamentIds}::int[])
  `;
  return rows.map((row) => ({
    tournamentId: Number(row.tournament_id),
    entryId: Number(row.entry_id),
  }));
}

async function loadPickRows(eventId: number, entryIds: number[]): Promise<PickSourceRow[]> {
  if (entryIds.length === 0) return [];
  const client = await getDbClient();
  const rows = await client<{ entry_id: number; picks: unknown }[]>`
    with source_entries as (
      select unnest(${entryIds}::int[]) as entry_id
    )
    select
      source_entries.entry_id,
      coalesce(entry_event_picks.picks, entry_event_results.event_picks) as picks
    from source_entries
    left join entry_event_picks
      on entry_event_picks.entry_id = source_entries.entry_id
     and entry_event_picks.event_id = ${eventId}
    left join entry_event_results
      on entry_event_results.entry_id = source_entries.entry_id
     and entry_event_results.event_id = ${eventId}
    where coalesce(entry_event_picks.picks, entry_event_results.event_picks) is not null
  `;
  return rows.map((row) => ({
    entryId: Number(row.entry_id),
    picks: row.picks,
  }));
}

async function loadTransferRows(eventId: number, entryIds: number[]): Promise<TransferSourceRow[]> {
  if (entryIds.length === 0) return [];
  const client = await getDbClient();
  const rows = await client<
    {
      entry_id: number;
      element_in_id: number | null;
      element_out_id: number | null;
    }[]
  >`
    select entry_id, element_in_id, element_out_id
    from entry_event_transfers
    where event_id = ${eventId}
      and entry_id = any(${entryIds}::int[])
  `;
  return rows.map((row) => ({
    entryId: Number(row.entry_id),
    elementInId: row.element_in_id === null ? null : Number(row.element_in_id),
    elementOutId: row.element_out_id === null ? null : Number(row.element_out_id),
  }));
}

async function upsertSelectionStats(rows: TournamentSelectionStatRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  const client = await getDbClient();
  await client`
    insert into tournament_selection_stats (
      tournament_id,
      event_id,
      element_id,
      pick_count,
      captain_count,
      vice_captain_count,
      transfer_in_count,
      transfer_out_count,
      total_entries,
      created_at,
      updated_at
    )
    select
      data.tournament_id,
      data.event_id,
      data.element_id,
      data.pick_count,
      data.captain_count,
      data.vice_captain_count,
      data.transfer_in_count,
      data.transfer_out_count,
      data.total_entries,
      now(),
      now()
    from (
      select
        unnest(${rows.map((row) => row.tournamentId)}::int[]) as tournament_id,
        unnest(${rows.map((row) => row.eventId)}::int[]) as event_id,
        unnest(${rows.map((row) => row.elementId)}::int[]) as element_id,
        unnest(${rows.map((row) => row.pickCount)}::int[]) as pick_count,
        unnest(${rows.map((row) => row.captainCount)}::int[]) as captain_count,
        unnest(${rows.map((row) => row.viceCaptainCount)}::int[]) as vice_captain_count,
        unnest(${rows.map((row) => row.transferInCount)}::int[]) as transfer_in_count,
        unnest(${rows.map((row) => row.transferOutCount)}::int[]) as transfer_out_count,
        unnest(${rows.map((row) => row.totalEntries)}::int[]) as total_entries
    ) as data
    on conflict (tournament_id, event_id, element_id)
    do update set
      pick_count = excluded.pick_count,
      captain_count = excluded.captain_count,
      vice_captain_count = excluded.vice_captain_count,
      transfer_in_count = excluded.transfer_in_count,
      transfer_out_count = excluded.transfer_out_count,
      total_entries = excluded.total_entries,
      updated_at = now()
  `;

  return rows.length;
}

export async function syncTournamentSelectionStats(eventId: number): Promise<{
  eventId: number;
  tournaments: number;
  sourceEntries: number;
  rows: number;
  upserted: number;
}> {
  if (!Number.isFinite(eventId) || eventId <= 0 || eventId > 38) {
    logInfo('Skipping tournament selection stats sync - invalid event', { eventId });
    return { eventId, tournaments: 0, sourceEntries: 0, rows: 0, upserted: 0 };
  }

  try {
    logInfo('Starting tournament selection stats sync', { eventId });

    const tournaments = await tournamentInfoRepository.findActive();
    const tournamentIds = tournaments.map((tournament) => tournament.id);
    if (tournamentIds.length === 0) {
      logInfo('No active tournaments found for selection stats sync', { eventId });
      return { eventId, tournaments: 0, sourceEntries: 0, rows: 0, upserted: 0 };
    }

    const tournamentEntries = await loadTournamentEntries(tournamentIds);
    const entryIds = [...new Set(tournamentEntries.map((row) => row.entryId))];
    const [pickRows, transferRows] = await Promise.all([
      loadPickRows(eventId, entryIds),
      loadTransferRows(eventId, entryIds),
    ]);

    const rows = aggregateTournamentSelectionStatsRows({
      eventId,
      tournamentEntries,
      pickRows,
      transferRows,
    });
    const upserted = await upsertSelectionStats(rows);

    logInfo('Tournament selection stats sync completed', {
      eventId,
      tournaments: tournamentIds.length,
      sourceEntries: entryIds.length,
      pickRows: pickRows.length,
      transferRows: transferRows.length,
      rows: rows.length,
      upserted,
    });

    return {
      eventId,
      tournaments: tournamentIds.length,
      sourceEntries: entryIds.length,
      rows: rows.length,
      upserted,
    };
  } catch (error) {
    logError('Failed to sync tournament selection stats', error, { eventId });
    throw new DatabaseError(
      'Failed to sync tournament selection stats',
      'TOURNAMENT_SELECTION_STATS_SYNC_ERROR',
      error as Error,
    );
  }
}
