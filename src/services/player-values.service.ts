import { performance } from 'node:perf_hooks';

import type { FPLBootstrapResponse } from '../clients/fpl';
import type { PlayerValue } from '../domain/player-values';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { PlayerMarketSnapshot } from '../domain/player-market-snapshots';
import { enqueuePlayerPricesSyncJob } from '../jobs/data-sync-enqueue';
import { playerMarketSnapshotsRepository } from '../repositories/player-market-snapshots';
import { ensureMarketPublication } from './market-publication.service';
import type { StoredPlayerValue } from '../repositories/player-values';
import { playerValuesRepository } from '../repositories/player-values';
import { transformPlayerMarketSnapshots } from '../transformers/player-market-snapshots';
import type { RawFPLElement } from '../types';
import { ELEMENT_TYPE_MAP } from '../types/base.type';
import { logError, logInfo } from '../utils/logger';
import { notifyTwoBots } from '../utils/notify';
import { formatCronDateKey } from '../utils/timezone';
import { resolvePlayerSyncEvent } from './player-sync-event.service';
import {
  resolveFplBootstrapSourceArtifact,
  type ResolvedFplBootstrapArtifact,
} from './fpl-bootstrap-source-artifact.service';

export type PlayerValuesPhaseTimings = {
  bootstrap: number;
  snapshotWrite: number;
  derivedView: number;
  publication?: number;
};

export type PlayerValuesSyncDependencies = {
  resolveBootstrapSourceArtifact: typeof resolveFplBootstrapSourceArtifact;
  resolvePlayerSyncEvent: typeof resolvePlayerSyncEvent;
  persistMarketSnapshot: (
    season: FplSeasonRef,
    eventId: number,
    snapshots: readonly PlayerMarketSnapshot[],
    expectedCount: number,
    sourceArtifactId: string,
  ) => Promise<{ snapshotDate: string; persistedCount: number }>;
  findByChangeDate: (season: FplSeasonRef, changeDate: string) => Promise<StoredPlayerValue[]>;
  enqueuePlayerPrices: typeof enqueuePlayerPricesSyncJob;
  notify: typeof notifyTwoBots;
  publishMarketPublication?: typeof ensureMarketPublication;
  getCurrentChangeDate: () => string;
};

export type PlayerValuesSyncResult = {
  count: number;
  eventId?: number;
  sourceArtifactId?: string;
  sourceProvenance?: ResolvedFplBootstrapArtifact['provenance'];
  marketSnapshotCount?: number;
  outcome?: 'noop';
  requiredUnits?: number;
  succeededUnits?: number;
  failedUnits?: number;
  timings?: PlayerValuesPhaseTimings;
  /** Set only when notification delivery must happen after the caller commits. */
  notificationMessage?: string;
};

/**
 * The upstream market payload is immutable after this point.  Keeping this
 * value separate from the persistence step lets the worker perform network
 * I/O before acquiring the short canonical-write mutation scope.
 */
export type PreparedPlayerValuesSync = Readonly<{
  season: FplSeasonRef;
  changeDate: string;
  eventId: number;
  bootstrap: FPLBootstrapResponse;
  sourceArtifactId: string;
  sourceProvenance: ResolvedFplBootstrapArtifact['provenance'];
  snapshots: readonly PlayerMarketSnapshot[];
  capturedAt: Date;
  requiredUnits: number;
  timings: PlayerValuesPhaseTimings;
}>;

const defaultDependencies: PlayerValuesSyncDependencies = {
  resolveBootstrapSourceArtifact: resolveFplBootstrapSourceArtifact,
  resolvePlayerSyncEvent,
  persistMarketSnapshot: (season, eventId, snapshots, expectedCount, sourceArtifactId) =>
    playerMarketSnapshotsRepository.upsertCompleteDay(
      season,
      eventId,
      snapshots,
      expectedCount,
      sourceArtifactId,
    ),
  findByChangeDate: (season, changeDate) =>
    playerValuesRepository.findByChangeDate(season, changeDate),
  enqueuePlayerPrices: enqueuePlayerPricesSyncJob,
  notify: notifyTwoBots,
  publishMarketPublication: ensureMarketPublication,
  getCurrentChangeDate: () => formatCronDateKey(),
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

function assertChangeDate(changeDate: string): void {
  if (!/^\d{8}$/.test(changeDate)) {
    throw new Error(`Invalid player value change date: ${changeDate}`);
  }
}

function resolveArchivedMarketEventId(bootstrap: FPLBootstrapResponse): number {
  for (const events of [
    bootstrap.events.filter((event) => event.is_current),
    bootstrap.events.filter((event) => event.is_next),
    bootstrap.events.filter((event) => event.is_previous),
  ]) {
    if (events.length === 1 && events[0]!.id > 0) return events[0]!.id;
    if (events.length > 1) {
      throw new Error('Archived FPL bootstrap has ambiguous market event flags');
    }
  }
  throw new Error('Archived FPL bootstrap has no current, next, or previous market event');
}

export async function preparePlayerValuesSync(
  season: FplSeasonRef,
  changeDate: string,
  dependencies: PlayerValuesSyncDependencies = defaultDependencies,
  options?: { onTargetEventResolved?: (eventId: number) => void },
): Promise<PreparedPlayerValuesSync | null> {
  assertChangeDate(changeDate);

  const timings: Partial<PlayerValuesPhaseTimings> = {};
  let requiredUnits = 0;
  try {
    const currentChangeDate = dependencies.getCurrentChangeDate();
    const currentSyncEvent =
      changeDate === currentChangeDate ? await dependencies.resolvePlayerSyncEvent(season) : null;
    if (changeDate === currentChangeDate && !currentSyncEvent) {
      throw new Error('No current or next event found for player values');
    }
    if (currentSyncEvent) options?.onTargetEventResolved?.(currentSyncEvent.event.id);

    const resolvedArtifact = await measurePhase(timings, 'bootstrap', () =>
      dependencies.resolveBootstrapSourceArtifact(season, changeDate),
    );
    const bootstrap = resolvedArtifact.bootstrap;
    if (!Array.isArray(bootstrap.elements) || bootstrap.elements.length === 0) {
      throw new Error('No player market data returned from FPL API');
    }
    requiredUnits = bootstrap.elements.length;
    // A current-day capture can reuse an existing content-addressed manifest
    // when FPL returns identical bytes. The snapshot timestamp must still
    // represent this observation, not the first manifest insertion time.
    const capturedAt = resolvedArtifact.observedAt ?? resolvedArtifact.artifact.retrievedAt;
    if (formatCronDateKey(capturedAt) !== changeDate) {
      throw new Error(
        `Bootstrap artifact ${resolvedArtifact.artifact.artifactId} is outside source day ${changeDate}`,
      );
    }
    const eventId = currentSyncEvent?.event.id ?? resolveArchivedMarketEventId(bootstrap);
    if (!currentSyncEvent) options?.onTargetEventResolved?.(eventId);
    const snapshots = transformPlayerMarketSnapshots(bootstrap, capturedAt);
    return {
      season,
      changeDate,
      eventId,
      bootstrap,
      sourceArtifactId: resolvedArtifact.artifact.artifactId,
      sourceProvenance: resolvedArtifact.provenance,
      snapshots,
      capturedAt,
      requiredUnits,
      timings: timings as PlayerValuesPhaseTimings,
    };
  } catch (error) {
    attachAttemptEvidence(error, {
      requiredUnits,
      succeededUnits: 0,
      failedUnits: Math.max(0, requiredUnits),
      timings,
    });
    throw error;
  }
}

export async function persistPreparedPlayerValuesSync(
  prepared: PreparedPlayerValuesSync,
  dependencies: PlayerValuesSyncDependencies = defaultDependencies,
  options?: {
    deferPriceSyncEnqueue?: boolean;
    deferMarketPublication?: boolean;
    deferNotification?: boolean;
  },
): Promise<PlayerValuesSyncResult> {
  const timings: Partial<PlayerValuesPhaseTimings> = { ...prepared.timings };
  let succeededUnits = 0;
  try {
    assertChangeDate(prepared.changeDate);
    if (formatCronDateKey(prepared.capturedAt) !== prepared.changeDate) {
      throw new Error(
        `Bootstrap artifact ${prepared.sourceArtifactId} is outside source day ${prepared.changeDate}`,
      );
    }
    const persisted = await measurePhase(timings, 'snapshotWrite', () =>
      dependencies.persistMarketSnapshot(
        prepared.season,
        prepared.eventId,
        prepared.snapshots,
        prepared.requiredUnits,
        prepared.sourceArtifactId,
      ),
    );
    succeededUnits = persisted.persistedCount;
    if (persisted.snapshotDate.replaceAll('-', '') !== prepared.changeDate) {
      throw new Error(
        `Market snapshot date ${persisted.snapshotDate} does not match requested date ${prepared.changeDate}`,
      );
    }

    const derivedRows = await measurePhase(timings, 'derivedView', () =>
      dependencies.findByChangeDate(prepared.season, prepared.changeDate),
    );
    const changedRows = enrichChangedRows(
      derivedRows,
      prepared.bootstrap.elements,
      prepared.bootstrap.teams,
    );
    let publicationId: string | undefined;
    if (dependencies.publishMarketPublication && !options?.deferMarketPublication) {
      const publication = await measurePhase(timings, 'publication', () =>
        dependencies.publishMarketPublication!(prepared.season),
      );
      publicationId = publication.publicationId;
    }
    const notificationMessage =
      changedRows.length > 0 && prepared.sourceProvenance !== 'archive'
        ? formatPlayerValuesNotification(prepared.changeDate, changedRows)
        : undefined;
    if (changedRows.length > 0) {
      if (!options?.deferPriceSyncEnqueue) {
        await dependencies.enqueuePlayerPrices(prepared.season, 'cascade', {
          changeDate: prepared.changeDate,
          jobId: `player-prices-${prepared.changeDate}-immediate`,
          removeOnSettle: false,
        });
      }
      if (notificationMessage && !options?.deferNotification) {
        try {
          await dependencies.notify(notificationMessage, {
            // The publication/snapshot identity, rather than the wall-clock
            // minute, is the notification's idempotency boundary. A worker
            // retry may happen in a later minute but must not duplicate the
            // same successfully committed market publication.
            idempotencyKey: `market:${prepared.season.seasonCode}:${prepared.changeDate}:${publicationId ?? 'snapshot'}`,
          });
        } catch (error) {
          logError('Failed to send player values notification', error, {
            changeDate: prepared.changeDate,
          });
        }
      }
    }

    const completeTimings = timings as PlayerValuesPhaseTimings;
    logInfo('Daily player market snapshot completed', {
      season: prepared.season.seasonCode,
      eventId: prepared.eventId,
      changeDate: prepared.changeDate,
      sourceArtifactId: prepared.sourceArtifactId,
      sourceProvenance: prepared.sourceProvenance,
      marketSnapshotCount: persisted.persistedCount,
      derivedChanges: changedRows.length,
      requiredUnits: prepared.requiredUnits,
      succeededUnits,
      timings: completeTimings,
    });
    return {
      count: changedRows.length,
      eventId: prepared.eventId,
      sourceArtifactId: prepared.sourceArtifactId,
      sourceProvenance: prepared.sourceProvenance,
      marketSnapshotCount: persisted.persistedCount,
      requiredUnits: prepared.requiredUnits,
      succeededUnits,
      failedUnits: Math.max(0, prepared.requiredUnits - succeededUnits),
      timings: completeTimings,
      ...(options?.deferNotification && notificationMessage ? { notificationMessage } : {}),
    };
  } catch (error) {
    attachAttemptEvidence(error, {
      requiredUnits: prepared.requiredUnits,
      succeededUnits,
      failedUnits: Math.max(0, prepared.requiredUnits - succeededUnits),
      timings,
    });
    throw error;
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
    options?: {
      onTargetEventResolved?: (eventId: number) => void;
      deferPriceSyncEnqueue?: boolean;
      /** Publish only after the caller's canonical mutation transaction commits. */
      deferMarketPublication?: boolean;
      /** Deliver bot notifications only after the caller confirms publication. */
      deferNotification?: boolean;
    },
  ): Promise<PlayerValuesSyncResult> {
    const prepared = await preparePlayerValuesSync(season, changeDate, dependencies, options);
    if (!prepared) return { count: 0, outcome: 'noop' };
    return persistPreparedPlayerValuesSync(prepared, dependencies, options);
  };
}

export const syncCurrentPlayerValues = createPlayerValuesSync(defaultDependencies);
