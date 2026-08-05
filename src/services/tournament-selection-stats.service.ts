import { getActiveCacheSeason } from '../cache/cache-season';
import { getDbClient } from '../db/singleton';
import { isCompleteEntryPicks } from '../domain/entry-picks';
import { entryEventTransfersRepository } from '../repositories/entry-event-transfers';
import { entryInfoRepository } from '../repositories/entry-infos';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { DatabaseError, IncompleteDataSyncError } from '../utils/errors';
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

function isTrueFlag(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizePicks(raw: unknown): PickItem[] {
  return Array.isArray(raw)
    ? (raw.filter((item) => item && typeof item === 'object') as PickItem[])
    : [];
}

function getPickElementId(pick: PickItem): number | null {
  const value = pick.element ?? pick.element_id ?? pick.elementId;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export const hasCompleteTournamentPicks = isCompleteEntryPicks;

export function filterTournamentEntriesForEvent(
  tournamentEntries: TournamentEntrySourceRow[],
  entryStarts: ReadonlyMap<number, number | null | undefined>,
  eventId: number,
): TournamentEntrySourceRow[] {
  return tournamentEntries.filter((row) => {
    const startedEvent = entryStarts.get(row.entryId);
    return startedEvent === undefined || startedEvent === null || eventId >= startedEvent;
  });
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
  const rows = await client<{ entry_id: number; stored_picks: unknown; result_picks: unknown }[]>`
    with source_entries as (
      select unnest(${entryIds}::int[]) as entry_id
    )
    select
      source_entries.entry_id,
      entry_event_picks.picks as stored_picks,
      entry_event_results.event_picks as result_picks
    from source_entries
    left join entry_event_picks
      on entry_event_picks.entry_id = source_entries.entry_id
     and entry_event_picks.event_id = ${eventId}
    left join entry_event_results
      on entry_event_results.entry_id = source_entries.entry_id
     and entry_event_results.event_id = ${eventId}
    where entry_event_picks.picks is not null
       or entry_event_results.event_picks is not null
  `;
  return rows.map((row) => ({
    entryId: Number(row.entry_id),
    picks: isCompleteEntryPicks(row.stored_picks) ? row.stored_picks : row.result_picks,
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

export async function replaceSelectionStats(
  tournamentIds: number[],
  eventId: number,
  rows: TournamentSelectionStatRow[],
): Promise<number> {
  const client = await getDbClient();
  return client.begin(async (tx) => {
    await tx`
      delete from tournament_selection_stats
      where event_id = ${eventId}
        and tournament_id = any(${tournamentIds}::int[])
    `;

    if (rows.length === 0) return 0;

    const inserted = await tx<{ tournament_id: number }[]>`
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
      returning tournament_id
    `;

    return inserted.length;
  });
}

export async function syncTournamentSelectionStats(
  eventId: number,
  options?: { tournamentIds?: number[] },
): Promise<{
  eventId: number;
  tournaments: number;
  sourceEntries: number;
  rows: number;
  upserted: number;
  requiredUnits: number;
  reusedUnits: number;
  succeededUnits: number;
  failedUnits: number;
}> {
  if (!Number.isFinite(eventId) || eventId <= 0 || eventId > 38) {
    logInfo('Skipping tournament selection stats sync - invalid event', { eventId });
    return {
      eventId,
      tournaments: 0,
      sourceEntries: 0,
      rows: 0,
      upserted: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }

  try {
    logInfo('Starting tournament selection stats sync', { eventId });

    const tournamentIds = options?.tournamentIds
      ? [...new Set(options.tournamentIds.filter((id) => Number.isInteger(id) && id > 0))]
      : (await tournamentInfoRepository.findActive()).map((tournament) => tournament.id);
    if (tournamentIds.length === 0) {
      logInfo('No active tournaments found for selection stats sync', { eventId });
      return {
        eventId,
        tournaments: 0,
        sourceEntries: 0,
        rows: 0,
        upserted: 0,
        requiredUnits: 0,
        reusedUnits: 0,
        succeededUnits: 0,
        failedUnits: 0,
      };
    }

    const tournamentEntries = await loadTournamentEntries(tournamentIds);
    const allEntryIds = [...new Set(tournamentEntries.map((row) => row.entryId))];
    const entryInfos = await entryInfoRepository.findByIds(allEntryIds);
    const startedEvents = new Map(
      entryInfos.map((entry) => [entry.id, entry.startedEvent] as const),
    );
    const eligibleTournamentEntries = filterTournamentEntriesForEvent(
      tournamentEntries,
      startedEvents,
      eventId,
    );
    const entryIds = [...new Set(eligibleTournamentEntries.map((row) => row.entryId))];
    const checkpointSeason = await getActiveCacheSeason();
    const [pickRows, transferRows, staleTransferEntryIds] = await Promise.all([
      loadPickRows(eventId, entryIds),
      loadTransferRows(eventId, entryIds),
      entryEventTransfersRepository.findEntryIdsNeedingSync(entryIds, eventId, checkpointSeason),
    ]);

    const pickEntryIds = new Set(
      pickRows.filter((row) => hasCompleteTournamentPicks(row.picks)).map((row) => row.entryId),
    );
    const missingPickEntryIds = entryIds.filter((entryId) => !pickEntryIds.has(entryId));
    const incompleteEntryIds = new Set([...missingPickEntryIds, ...staleTransferEntryIds]);
    if (incompleteEntryIds.size > 0) {
      throw new IncompleteDataSyncError(
        'Tournament selection statistics require complete picks and transfer checkpoints',
        incompleteEntryIds.size,
        entryIds.length - incompleteEntryIds.size,
        0,
        incompleteEntryIds.size,
      );
    }

    const rows = aggregateTournamentSelectionStatsRows({
      eventId,
      tournamentEntries: eligibleTournamentEntries,
      pickRows,
      transferRows,
    });
    const upserted = await replaceSelectionStats(tournamentIds, eventId, rows);
    if (upserted !== rows.length) {
      throw new IncompleteDataSyncError(
        'Tournament selection statistics were not published completely',
        rows.length,
        entryIds.length,
        upserted,
        Math.abs(rows.length - upserted),
      );
    }

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
      requiredUnits: rows.length,
      reusedUnits: 0,
      succeededUnits: upserted,
      failedUnits: 0,
    };
  } catch (error) {
    logError('Failed to sync tournament selection stats', error, { eventId });
    if (error instanceof IncompleteDataSyncError) {
      throw error;
    }
    throw new DatabaseError(
      'Failed to sync tournament selection stats',
      'TOURNAMENT_SELECTION_STATS_SYNC_ERROR',
      error as Error,
    );
  }
}
