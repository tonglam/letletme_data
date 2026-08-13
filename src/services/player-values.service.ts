import { performance } from 'node:perf_hooks';

import { fplClient } from '../clients/fpl';
import type { PlayerValue } from '../domain/player-values';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { PlayerMarketSnapshot } from '../domain/player-market-snapshots';
import { enqueuePlayerPricesSyncJob } from '../jobs/data-sync-enqueue';
import { playerMarketSnapshotsRepository } from '../repositories/player-market-snapshots';
import type { StoredPlayerValue } from '../repositories/player-values';
import { playerValuesRepository } from '../repositories/player-values';
import { transformPlayerMarketSnapshots } from '../transformers/player-market-snapshots';
import type { RawFPLElement } from '../types';
import { ELEMENT_TYPE_MAP } from '../types/base.type';
import { logError, logInfo } from '../utils/logger';
import { notifyTwoBots } from '../utils/notify';
import { formatCronDateKey } from '../utils/timezone';
import { resolvePlayerSyncEvent } from './player-sync-event.service';

export type PlayerValuesPhaseTimings = {
  bootstrap: number;
  snapshotWrite: number;
  derivedView: number;
};

export type PlayerValuesSyncDependencies = {
  getBootstrap: typeof fplClient.getBootstrap;
  resolvePlayerSyncEvent: typeof resolvePlayerSyncEvent;
  persistMarketSnapshot: (
    season: FplSeasonRef,
    eventId: number,
    snapshots: readonly PlayerMarketSnapshot[],
    expectedCount: number,
  ) => Promise<{ snapshotDate: string; persistedCount: number }>;
  findByChangeDate: (season: FplSeasonRef, changeDate: string) => Promise<StoredPlayerValue[]>;
  enqueuePlayerPrices: typeof enqueuePlayerPricesSyncJob;
  notify: typeof notifyTwoBots;
  getCurrentChangeDate: () => string;
  now: () => Date;
};

const defaultDependencies: PlayerValuesSyncDependencies = {
  getBootstrap: () => fplClient.getBootstrap(),
  resolvePlayerSyncEvent,
  persistMarketSnapshot: (season, eventId, snapshots, expectedCount) =>
    playerMarketSnapshotsRepository.upsertCompleteDay(season, eventId, snapshots, expectedCount),
  findByChangeDate: (season, changeDate) =>
    playerValuesRepository.findByChangeDate(season, changeDate),
  enqueuePlayerPrices: enqueuePlayerPricesSyncJob,
  notify: notifyTwoBots,
  getCurrentChangeDate: () => formatCronDateKey(),
  now: () => new Date(),
};

function formatPlayerValuesNotification(
  changeDate: string,
  playerValues: readonly PlayerValue[],
): string {
  const formatPrice = (value: number) => `£${(value / 10).toFixed(1)}m`;
  const risers = playerValues
    .filter((value) => value.changeType === 'Rise')
    .slice()
    .sort((left, right) => right.value - right.lastValue - (left.value - left.lastValue));
  const fallers = playerValues
    .filter((value) => value.changeType === 'Faller')
    .slice()
    .sort((left, right) => left.value - left.lastValue - (right.value - right.lastValue));
  const lines = [
    `[player-values] ${changeDate}: +${risers.length} -${fallers.length} (total ${playerValues.length})`,
  ];
  const formatLine = (value: PlayerValue) =>
    `${value.webName} (${value.teamShortName}) ${formatPrice(value.lastValue)}-> ${formatPrice(value.value)}`;
  if (risers.length > 0) lines.push('Risers:', ...risers.slice(0, 12).map(formatLine));
  if (fallers.length > 0) lines.push('Fallers:', ...fallers.slice(0, 12).map(formatLine));
  return lines.join('\n');
}

function enrichChangedRows(
  rows: readonly StoredPlayerValue[],
  elements: readonly RawFPLElement[],
  teams: ReadonlyArray<{ id: number; name: string; short_name: string }>,
): PlayerValue[] {
  const elementsById = new Map(elements.map((element) => [element.id, element]));
  const teamsById = new Map(teams.map((team) => [team.id, team]));
  return rows
    .filter((row) => row.changeType === 'Rise' || row.changeType === 'Faller')
    .map((row) => {
      const element = elementsById.get(row.elementId);
      if (!element) throw new Error(`Current player identity missing for ${row.elementId}`);
      const team = teamsById.get(element.team);
      if (!team) throw new Error(`Current team identity missing for ${element.team}`);
      const elementType = row.elementType as 1 | 2 | 3 | 4;
      return {
        ...row,
        webName: element.web_name,
        elementType,
        elementTypeName: ELEMENT_TYPE_MAP[elementType],
        teamId: element.team,
        teamName: team.name,
        teamShortName: team.short_name,
      };
    });
}

async function measurePhase<T>(
  timings: Partial<PlayerValuesPhaseTimings>,
  phase: keyof PlayerValuesPhaseTimings,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    timings[phase] = Math.max(0, Math.round(performance.now() - startedAt));
  }
}

function attachAttemptEvidence(
  error: unknown,
  evidence: {
    requiredUnits: number;
    succeededUnits: number;
    failedUnits: number;
    timings: Partial<PlayerValuesPhaseTimings>;
  },
): void {
  if (typeof error === 'object' && error !== null && Object.isExtensible(error)) {
    Object.assign(error, evidence);
  }
}

/**
 * Capture one complete daily market snapshot. reporting.player_value_changes
 * derives Start/Rise/Faller rows from these snapshots; there is no second
 * writable player-values store.
 */
export function createPlayerValuesSync(dependencies: PlayerValuesSyncDependencies) {
  return async function syncForDate(
    season: FplSeasonRef,
    changeDate: string = dependencies.getCurrentChangeDate(),
    options?: { onTargetEventResolved?: (eventId: number) => void },
  ): Promise<{
    count: number;
    eventId?: number;
    marketSnapshotCount?: number;
    outcome?: 'noop';
    requiredUnits?: number;
    succeededUnits?: number;
    failedUnits?: number;
    timings?: PlayerValuesPhaseTimings;
  }> {
    if (!/^\d{8}$/.test(changeDate)) {
      throw new Error(`Invalid player value change date: ${changeDate}`);
    }
    if (changeDate !== dependencies.getCurrentChangeDate()) {
      logInfo('Skipping market snapshot outside its scheduled date', { changeDate });
      return { count: 0, outcome: 'noop' };
    }

    const syncEvent = await dependencies.resolvePlayerSyncEvent(season);
    if (!syncEvent) throw new Error('No current or next event found for player values');
    options?.onTargetEventResolved?.(syncEvent.event.id);

    const timings: Partial<PlayerValuesPhaseTimings> = {};
    let requiredUnits = 0;
    let succeededUnits = 0;
    try {
      const bootstrap = await measurePhase(timings, 'bootstrap', dependencies.getBootstrap);
      if (!Array.isArray(bootstrap.elements) || bootstrap.elements.length === 0) {
        throw new Error('No player market data returned from FPL API');
      }
      requiredUnits = bootstrap.elements.length;
      const capturedAt = dependencies.now();
      const snapshots = transformPlayerMarketSnapshots(bootstrap, capturedAt);
      const persisted = await measurePhase(timings, 'snapshotWrite', () =>
        dependencies.persistMarketSnapshot(
          season,
          syncEvent.event.id,
          snapshots,
          bootstrap.elements.length,
        ),
      );
      succeededUnits = persisted.persistedCount;
      if (persisted.snapshotDate.replaceAll('-', '') !== changeDate) {
        throw new Error(
          `Market snapshot date ${persisted.snapshotDate} does not match requested date ${changeDate}`,
        );
      }

      const derivedRows = await measurePhase(timings, 'derivedView', () =>
        dependencies.findByChangeDate(season, changeDate),
      );
      const changedRows = enrichChangedRows(derivedRows, bootstrap.elements, bootstrap.teams);
      if (changedRows.length > 0) {
        await dependencies.enqueuePlayerPrices(season, 'cascade', {
          changeDate,
          jobId: `player-prices-${changeDate}-immediate`,
          removeOnSettle: true,
        });
        try {
          await dependencies.notify(formatPlayerValuesNotification(changeDate, changedRows));
        } catch (error) {
          logError('Failed to send player values notification', error, { changeDate });
        }
      }

      const completeTimings = timings as PlayerValuesPhaseTimings;
      logInfo('Daily player market snapshot completed', {
        season: season.seasonCode,
        eventId: syncEvent.event.id,
        changeDate,
        marketSnapshotCount: persisted.persistedCount,
        derivedChanges: changedRows.length,
        requiredUnits,
        succeededUnits,
        timings: completeTimings,
      });
      return {
        count: changedRows.length,
        eventId: syncEvent.event.id,
        marketSnapshotCount: persisted.persistedCount,
        requiredUnits,
        succeededUnits,
        failedUnits: Math.max(0, requiredUnits - succeededUnits),
        timings: completeTimings,
      };
    } catch (error) {
      attachAttemptEvidence(error, {
        requiredUnits,
        succeededUnits,
        failedUnits: Math.max(0, requiredUnits - succeededUnits),
        timings,
      });
      throw error;
    }
  };
}

export const syncCurrentPlayerValues = createPlayerValuesSync(defaultDependencies);
