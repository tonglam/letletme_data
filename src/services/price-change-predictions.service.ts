import { createHash, randomUUID } from 'node:crypto';

import {
  prepareDataPublication,
  readActiveDataPublication,
  type DataPublicationReadResult,
} from '../cache/data-publication';
import { redisSingleton } from '../cache/singleton';
import { fplClient, type FPLBootstrapResponse } from '../clients/fpl';
import type { FplSeasonRef } from '../domain/fpl-season';
import {
  dispatchDataPublicationOutbox,
  loadDataPublicationDelivery,
} from '../repositories/data-publication-outbox';
import { seasonRepository } from '../repositories/seasons';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { assertSchedulerLanePublicationFence } from '../repositories/scheduler-lanes';
import { logInfo } from '../utils/logger';
import { withMutationScopes } from '../utils/mutation-scopes';

export const PRICE_CHANGE_READY_MS = 10 * 60 * 1000;
/** Maximum age at which a price-change publication may be served. */
export const PRICE_CHANGE_STALE_MS = 60 * 60 * 1000;
export const PRICE_CHANGE_MAX_AGE_MS = PRICE_CHANGE_STALE_MS;
export const PRICE_CHANGE_DATASET = 'fpl:price-changes' as const;

const PRICE_CHANGE_CACHE_KEY = 'fpl:price-change-predictions:v1';
const PRICE_CHANGE_CONTEXT_SCHEMA_VERSION = 1;
const PRICE_CHANGE_SOURCE_CACHE_BUCKET_MS = 5 * 60 * 1000;

export type PriceChangePredictionStatus =
  | 'VERY_LIKELY_RISE'
  | 'LIKELY_RISE'
  | 'UNLIKELY'
  | 'LIKELY_FALL'
  | 'VERY_LIKELY_FALL'
  | 'LOCKED'
  | 'CALIBRATING';

export type PriceChangeOwnershipTrend = 'UP' | 'DOWN' | 'FLAT';

export type PriceChangeProjection = {
  offset: number;
  projectedPercent: number;
  likelihood: number;
};

export type PriceChangePlayer = {
  playerId: number;
  playerCode: number;
  webName: string;
  teamId: number;
  teamName: string;
  teamShortName: string;
  position: 'GKP' | 'DEF' | 'MID' | 'FWD';
  currentPrice: number;
  selectedByPercent: number;
  progressPercent: number;
  hourlyRate: number;
  status: PriceChangePredictionStatus;
  ownershipTrend: PriceChangeOwnershipTrend;
  transfersInEvent: number;
  transfersOutEvent: number;
  lockedUntil: string | null;
  calibrating: boolean;
  projections: PriceChangeProjection[];
};

export type PriceChangeBoardStatus = 'READY' | 'PARTIAL' | 'STALE' | 'UNAVAILABLE';

export type PriceChangeBoard = {
  status: PriceChangeBoardStatus;
  source: 'FPL_BOOTSTRAP';
  deadline: string | null;
  nextDeadlines: string[];
  fetchedAt: string | null;
  staleAt: string | null;
  revision: string;
  expectedPlayerCount: number;
  observedPlayerCount: number;
  players: PriceChangePlayer[];
};

export type PriceChangePublicationContext = {
  schemaVersion: 1;
  source: 'FPL_BOOTSTRAP';
  fetchedAt: string;
  staleAt: string;
  hardExpiresAt: string;
  deadline: string;
  nextDeadlines: string[];
  expectedPlayerCount: number;
  observedPlayerCount: number;
};

export type PriceChangePublicationDependencies = {
  /**
   * The caller supplies the immutable request-start timestamp so the default
   * client and the publication fence use the same cache bucket/order value.
   */
  readonly getBootstrap: (requestStartedAtMs: number) => Promise<FPLBootstrapResponse>;
};

export type PreparedPriceChangePublication = {
  readonly outcome: 'ready';
  readonly season: FplSeasonRef;
  readonly sourceRunId: string;
  /** Exact freshness window being repaired, carried into the manifest. */
  readonly freshnessWindowId?: number;
  readonly requestStartedAt: Date;
  readonly fetchedAt: Date;
  /** Core publication identity captured with the upstream price response. */
  readonly corePublicationId: string;
  readonly corePublicationRevision: number;
  readonly board: PriceChangeBoard;
  readonly context: PriceChangePublicationContext;
};

export type PriceChangePreparationResult =
  | PreparedPriceChangePublication
  | {
      readonly outcome: 'noop';
      readonly season: string;
      readonly sourceRunId: string;
      readonly reason: 'official_fields_not_open';
    };

export type PriceChangeSyncResult = {
  readonly outcome: 'ready' | 'noop';
  readonly season: string;
  readonly players: number;
  readonly fetchedAt?: string;
  readonly publicationId?: string;
  readonly revision?: number;
};

export class PriceChangeCorePublicationRequiredError extends Error {
  constructor(message = 'An active fpl:core publication is required before price changes') {
    super(message);
    this.name = 'PriceChangeCorePublicationRequiredError';
  }
}

export class PriceChangePredictionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceChangePredictionValidationError';
  }
}

export class PriceChangePredictionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceChangePredictionUnavailableError';
  }
}

function priceRunSkipReason(error: unknown): string | null {
  if (error instanceof PriceChangeCorePublicationRequiredError) {
    return 'core-publication-mismatch';
  }
  if (error instanceof Error && error.message.includes('Scheduler lane target was superseded')) {
    return 'superseded-by-latest-authoritative';
  }
  return null;
}

export function priceChangeBootstrapEdgeCacheKey(nowMs = Date.now()): string {
  if (!Number.isFinite(nowMs)) {
    throw new Error('Price-change bootstrap cache bucket requires a valid timestamp');
  }
  return `price-changes-${Math.floor(nowMs / PRICE_CHANGE_SOURCE_CACHE_BUCKET_MS)}`;
}

const defaultDependencies: PriceChangePublicationDependencies = {
  getBootstrap: (requestStartedAtMs) =>
    fplClient.getBootstrap({ edgeCacheKey: priceChangeBootstrapEdgeCacheKey(requestStartedAtMs) }),
};

export async function requestPriceChangeBootstrap(
  dependencies: PriceChangePublicationDependencies = defaultDependencies,
  now: () => number = Date.now,
): Promise<{
  readonly bootstrap: FPLBootstrapResponse;
  readonly requestStartedAt: Date;
  readonly fetchedAt: Date;
}> {
  const requestStartedAtMs = now();
  const bootstrap = await dependencies.getBootstrap(requestStartedAtMs);
  return {
    bootstrap,
    requestStartedAt: new Date(requestStartedAtMs),
    fetchedAt: new Date(now()),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value)
        : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function positionFromElementType(elementType: number): PriceChangePlayer['position'] | null {
  if (elementType === 1) return 'GKP';
  if (elementType === 2) return 'DEF';
  if (elementType === 3) return 'MID';
  if (elementType === 4) return 'FWD';
  return null;
}

function predictionStatus(
  likelihood: number,
  lockedUntil: string | null,
  calibrating: boolean,
): PriceChangePredictionStatus {
  if (lockedUntil) return 'LOCKED';
  if (calibrating) return 'CALIBRATING';
  if (likelihood === 5) return 'VERY_LIKELY_RISE';
  if (likelihood === 4) return 'LIKELY_RISE';
  if (likelihood === -4) return 'LIKELY_FALL';
  if (likelihood === -5) return 'VERY_LIKELY_FALL';
  return 'UNLIKELY';
}

function ownershipTrend(transfersIn: number, transfersOut: number): PriceChangeOwnershipTrend {
  if (transfersIn > transfersOut) return 'UP';
  if (transfersOut > transfersIn) return 'DOWN';
  return 'FLAT';
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function getDeadlines(bootstrap: FPLBootstrapResponse): string[] {
  const rawDeadlines = bootstrap.game_config?.settings?.price_change_deadlines ?? [];
  const deadlines = rawDeadlines.map((value) => normalizeDate(value));
  if (deadlines.length === 0 || deadlines.some((deadline): deadline is null => deadline === null)) {
    throw new PriceChangePredictionValidationError(
      'FPL bootstrap price-change deadlines are missing or invalid',
    );
  }
  const normalized = deadlines as string[];
  for (let index = 1; index < normalized.length; index += 1) {
    if (Date.parse(normalized[index - 1]) >= Date.parse(normalized[index])) {
      throw new PriceChangePredictionValidationError(
        'FPL bootstrap price-change deadlines must be strictly increasing',
      );
    }
  }
  return normalized;
}

function hasPredictionFields(bootstrap: FPLBootstrapResponse): boolean {
  return bootstrap.elements.some(
    (element) =>
      element.price_change_percent !== undefined ||
      element.price_change_hourly_rate !== undefined ||
      element.price_change_projections !== undefined,
  );
}

function validateProjectionShape(
  projections: unknown,
  deadlineCount: number,
  playerId: number,
): asserts projections is NonNullable<
  FPLBootstrapResponse['elements'][number]['price_change_projections']
> {
  if (
    !Array.isArray(projections) ||
    projections.length === 0 ||
    projections.length !== deadlineCount
  ) {
    throw new PriceChangePredictionValidationError(
      `Player ${playerId} has an incomplete price-change projection horizon`,
    );
  }
  const offsets = new Set<number>();
  for (const projection of projections) {
    if (
      !isRecord(projection) ||
      !Number.isInteger(projection.offset) ||
      Number(projection.offset) < 0 ||
      Number(projection.offset) >= deadlineCount ||
      offsets.has(Number(projection.offset))
    ) {
      throw new PriceChangePredictionValidationError(
        `Player ${playerId} has an invalid or duplicate projection offset`,
      );
    }
    const projectedPercent = finiteNumber(projection.projected_percent);
    const likelihood = finiteNumber(projection.likelihood);
    if (projectedPercent === null || likelihood === null || likelihood < -5 || likelihood > 5) {
      throw new PriceChangePredictionValidationError(
        `Player ${playerId} has an invalid projection value`,
      );
    }
    offsets.add(Number(projection.offset));
  }
}

function validateBootstrap(
  bootstrap: FPLBootstrapResponse,
  fetchedAt: Date,
  expectedPlayerIds?: ReadonlySet<number>,
): {
  readonly deadlines: string[];
  readonly teamsById: ReadonlyMap<number, FPLBootstrapResponse['teams'][number]>;
} {
  if (!Number.isFinite(fetchedAt.getTime())) {
    throw new PriceChangePredictionValidationError('Price-change fetchedAt is invalid');
  }
  if (!Array.isArray(bootstrap.elements) || bootstrap.elements.length === 0) {
    throw new PriceChangePredictionValidationError('FPL bootstrap contains no players');
  }
  if (!Array.isArray(bootstrap.teams) || bootstrap.teams.length === 0) {
    throw new PriceChangePredictionValidationError('FPL bootstrap contains no teams');
  }
  const deadlines = getDeadlines(bootstrap);
  const teamsById = new Map(bootstrap.teams.map((team) => [team.id, team]));
  const playerIds = new Set<number>();
  for (const element of bootstrap.elements) {
    const playerId = finiteNumber(element.id);
    const playerCode = finiteNumber(element.code);
    if (
      playerId === null ||
      !Number.isInteger(playerId) ||
      playerId <= 0 ||
      playerCode === null ||
      !Number.isInteger(playerCode) ||
      playerCode <= 0 ||
      playerIds.has(playerId)
    ) {
      throw new PriceChangePredictionValidationError(
        'FPL bootstrap contains duplicate or invalid player IDs',
      );
    }
    playerIds.add(playerId);

    const team = teamsById.get(element.team);
    const position = positionFromElementType(element.element_type);
    if (!team || !team.name.trim() || !team.short_name.trim() || !position) {
      throw new PriceChangePredictionValidationError(
        `Player ${playerId} has an unknown team or position`,
      );
    }
    const selectedByPercent = finiteNumber(element.selected_by_percent);
    const progressPercent = finiteNumber(element.price_change_percent);
    const hourlyRate = finiteNumber(element.price_change_hourly_rate);
    if (
      selectedByPercent === null ||
      selectedByPercent < 0 ||
      progressPercent === null ||
      hourlyRate === null ||
      !Number.isInteger(element.now_cost) ||
      element.now_cost < 0 ||
      !Number.isInteger(element.transfers_in_event) ||
      element.transfers_in_event < 0 ||
      !Number.isInteger(element.transfers_out_event) ||
      element.transfers_out_event < 0 ||
      typeof element.web_name !== 'string' ||
      element.web_name.trim().length === 0
    ) {
      throw new PriceChangePredictionValidationError(
        `Player ${playerId} has invalid price-change fields`,
      );
    }
    if (
      element.price_change_locked_until !== undefined &&
      element.price_change_locked_until !== null &&
      normalizeDate(element.price_change_locked_until) === null
    ) {
      throw new PriceChangePredictionValidationError(`Player ${playerId} has an invalid lock time`);
    }
    if (
      element.price_change_calibrating !== undefined &&
      typeof element.price_change_calibrating !== 'boolean'
    ) {
      throw new PriceChangePredictionValidationError(
        `Player ${playerId} has an invalid calibrating flag`,
      );
    }
    validateProjectionShape(element.price_change_projections, deadlines.length, playerId);
  }

  if (
    expectedPlayerIds &&
    (expectedPlayerIds.size !== playerIds.size ||
      [...expectedPlayerIds].some((playerId) => !playerIds.has(playerId)))
  ) {
    throw new PriceChangeCorePublicationRequiredError(
      'Price-change player IDs do not exactly match the active fpl:core publication',
    );
  }
  return { deadlines, teamsById };
}

export function normalizePriceChangeBoard(
  bootstrap: FPLBootstrapResponse,
  fetchedAt = new Date(),
  staleAt = new Date(fetchedAt.getTime() + PRICE_CHANGE_READY_MS),
  expectedPlayerIds?: ReadonlySet<number>,
): PriceChangeBoard {
  const { deadlines, teamsById } = validateBootstrap(bootstrap, fetchedAt, expectedPlayerIds);
  const players: PriceChangePlayer[] = bootstrap.elements.map((element) => {
    const team = teamsById.get(element.team);
    const position = positionFromElementType(element.element_type);
    if (!team || !position) {
      throw new PriceChangePredictionValidationError(
        `Player ${element.id} has no canonical team or position`,
      );
    }
    const projections = [...(element.price_change_projections ?? [])]
      .sort((left, right) => left.offset - right.offset)
      .map((projection) => ({
        offset: projection.offset,
        projectedPercent: finiteNumber(projection.projected_percent) as number,
        likelihood: finiteNumber(projection.likelihood) as number,
      }));
    const parsedLock = normalizeDate(element.price_change_locked_until);
    const lockedUntil =
      parsedLock && Date.parse(parsedLock) > fetchedAt.getTime() ? parsedLock : null;
    const firstLikelihood = projections.find((projection) => projection.offset === 0)?.likelihood;
    const calibrating = element.price_change_calibrating === true;
    return {
      playerId: element.id,
      playerCode: element.code,
      webName: element.web_name,
      teamId: element.team,
      teamName: team.name,
      teamShortName: team.short_name,
      position,
      currentPrice: element.now_cost,
      selectedByPercent: finiteNumber(element.selected_by_percent) as number,
      progressPercent: finiteNumber(element.price_change_percent) as number,
      hourlyRate: finiteNumber(element.price_change_hourly_rate) as number,
      status: predictionStatus(firstLikelihood as number, lockedUntil, calibrating),
      ownershipTrend: ownershipTrend(element.transfers_in_event, element.transfers_out_event),
      transfersInEvent: element.transfers_in_event,
      transfersOutEvent: element.transfers_out_event,
      lockedUntil,
      calibrating,
      projections,
    };
  });
  players.sort((left, right) => left.playerId - right.playerId);
  const revision = createHash('sha1')
    .update(JSON.stringify({ deadline: deadlines[0], players }), 'utf8')
    .digest('hex')
    .slice(0, 16);
  const expectedPlayerCount = expectedPlayerIds?.size ?? bootstrap.elements.length;
  return {
    status: 'READY',
    source: 'FPL_BOOTSTRAP',
    deadline: deadlines[0] ?? null,
    nextDeadlines: deadlines,
    fetchedAt: fetchedAt.toISOString(),
    staleAt: staleAt.toISOString(),
    revision,
    expectedPlayerCount,
    observedPlayerCount: players.length,
    players,
  };
}

function contextFromBoard(board: PriceChangeBoard, fetchedAt: Date): PriceChangePublicationContext {
  if (!board.staleAt || !board.deadline || board.nextDeadlines.length === 0) {
    throw new PriceChangePredictionValidationError('Price-change board has no publication horizon');
  }
  return {
    schemaVersion: PRICE_CHANGE_CONTEXT_SCHEMA_VERSION,
    source: 'FPL_BOOTSTRAP',
    fetchedAt: fetchedAt.toISOString(),
    staleAt: new Date(fetchedAt.getTime() + PRICE_CHANGE_READY_MS).toISOString(),
    hardExpiresAt: new Date(fetchedAt.getTime() + PRICE_CHANGE_MAX_AGE_MS).toISOString(),
    deadline: board.deadline,
    nextDeadlines: board.nextDeadlines,
    expectedPlayerCount: board.expectedPlayerCount,
    observedPlayerCount: board.observedPlayerCount,
  };
}

function isPriceChangeProjection(value: unknown): value is PriceChangeProjection {
  return (
    isRecord(value) &&
    Number.isInteger(value.offset) &&
    Number(value.offset) >= 0 &&
    typeof value.projectedPercent === 'number' &&
    Number.isFinite(value.projectedPercent) &&
    typeof value.likelihood === 'number' &&
    Number.isFinite(value.likelihood) &&
    value.likelihood >= -5 &&
    value.likelihood <= 5
  );
}

function isPriceChangePlayer(value: unknown): value is PriceChangePlayer {
  if (!isRecord(value) || !Array.isArray(value.projections) || value.projections.length === 0) {
    return false;
  }
  const projectionOffsets = new Set(
    value.projections.filter(isPriceChangeProjection).map((projection) => projection.offset),
  );
  return (
    Number.isInteger(value.playerId) &&
    Number(value.playerId) > 0 &&
    Number.isInteger(value.playerCode) &&
    Number(value.playerCode) > 0 &&
    typeof value.webName === 'string' &&
    value.webName.trim().length > 0 &&
    Number.isInteger(value.teamId) &&
    Number(value.teamId) > 0 &&
    typeof value.teamName === 'string' &&
    value.teamName.length > 0 &&
    typeof value.teamShortName === 'string' &&
    value.teamShortName.length > 0 &&
    ['GKP', 'DEF', 'MID', 'FWD'].includes(String(value.position)) &&
    typeof value.currentPrice === 'number' &&
    Number.isInteger(value.currentPrice) &&
    value.currentPrice >= 0 &&
    typeof value.selectedByPercent === 'number' &&
    Number.isFinite(value.selectedByPercent) &&
    typeof value.progressPercent === 'number' &&
    Number.isFinite(value.progressPercent) &&
    typeof value.hourlyRate === 'number' &&
    Number.isFinite(value.hourlyRate) &&
    [
      'VERY_LIKELY_RISE',
      'LIKELY_RISE',
      'UNLIKELY',
      'LIKELY_FALL',
      'VERY_LIKELY_FALL',
      'LOCKED',
      'CALIBRATING',
    ].includes(String(value.status)) &&
    ['UP', 'DOWN', 'FLAT'].includes(String(value.ownershipTrend)) &&
    typeof value.transfersInEvent === 'number' &&
    Number.isInteger(value.transfersInEvent) &&
    value.transfersInEvent >= 0 &&
    typeof value.transfersOutEvent === 'number' &&
    Number.isInteger(value.transfersOutEvent) &&
    value.transfersOutEvent >= 0 &&
    (value.lockedUntil === null ||
      (typeof value.lockedUntil === 'string' && normalizeDate(value.lockedUntil) !== null)) &&
    typeof value.calibrating === 'boolean' &&
    value.projections.every(isPriceChangeProjection) &&
    projectionOffsets.size === value.projections.length
  );
}

function unavailableBoard(): PriceChangeBoard {
  return {
    status: 'UNAVAILABLE',
    source: 'FPL_BOOTSTRAP',
    deadline: null,
    nextDeadlines: [],
    fetchedAt: null,
    staleAt: null,
    revision: 'unavailable',
    expectedPlayerCount: 0,
    observedPlayerCount: 0,
    players: [],
  };
}

const CONTEXT_KEYS = [
  'schemaVersion',
  'source',
  'fetchedAt',
  'staleAt',
  'hardExpiresAt',
  'deadline',
  'nextDeadlines',
  'expectedPlayerCount',
  'observedPlayerCount',
] as const;

export function parsePublishedPriceChangeBoard(
  publication: DataPublicationReadResult,
  now = new Date(),
): PriceChangeBoard | null {
  const { manifest, items } = publication;
  if (
    manifest.dataset !== PRICE_CHANGE_DATASET ||
    manifest.eventId !== null ||
    manifest.state !== 'active' ||
    manifest.items.length !== 2 ||
    !manifest.items.some((item) => item.name === 'context') ||
    !manifest.items.some((item) => item.name === 'players')
  ) {
    return null;
  }
  const context = items.context;
  const players = items.players;
  if (!isRecord(context) || !hasExactKeys(context, CONTEXT_KEYS) || !Array.isArray(players)) {
    return null;
  }
  const nextDeadlinesValue = context.nextDeadlines;
  const expectedPlayerCountValue = context.expectedPlayerCount;
  const observedPlayerCountValue = context.observedPlayerCount;
  if (
    context.schemaVersion !== PRICE_CHANGE_CONTEXT_SCHEMA_VERSION ||
    context.source !== 'FPL_BOOTSTRAP' ||
    typeof context.fetchedAt !== 'string' ||
    typeof context.staleAt !== 'string' ||
    typeof context.hardExpiresAt !== 'string' ||
    typeof context.deadline !== 'string' ||
    !Array.isArray(nextDeadlinesValue) ||
    nextDeadlinesValue.length === 0 ||
    !nextDeadlinesValue.every((deadline) => typeof deadline === 'string') ||
    context.deadline !== nextDeadlinesValue[0] ||
    !Number.isInteger(expectedPlayerCountValue) ||
    !Number.isInteger(observedPlayerCountValue) ||
    Number(expectedPlayerCountValue) <= 0 ||
    Number(observedPlayerCountValue) <= 0 ||
    Number(expectedPlayerCountValue) !== Number(observedPlayerCountValue) ||
    players.length !== Number(observedPlayerCountValue)
  ) {
    return null;
  }
  const nextDeadlines = context.nextDeadlines as string[];
  const expectedPlayerCount = context.expectedPlayerCount as number;
  const observedPlayerCount = context.observedPlayerCount as number;
  const fetchedAt = Date.parse(context.fetchedAt);
  const staleAt = Date.parse(context.staleAt);
  const hardExpiresAt = Date.parse(context.hardExpiresAt);
  if (
    !Number.isFinite(fetchedAt) ||
    !Number.isFinite(staleAt) ||
    !Number.isFinite(hardExpiresAt) ||
    staleAt !== fetchedAt + PRICE_CHANGE_READY_MS ||
    hardExpiresAt !== fetchedAt + PRICE_CHANGE_MAX_AGE_MS
  ) {
    return null;
  }
  for (let index = 0; index < nextDeadlines.length; index += 1) {
    const deadline = Date.parse(nextDeadlines[index]);
    if (
      !Number.isFinite(deadline) ||
      (index > 0 && deadline <= Date.parse(nextDeadlines[index - 1]))
    ) {
      return null;
    }
  }
  const playerIds = new Set<number>();
  if (
    !players.every((player) => {
      if (
        !isPriceChangePlayer(player) ||
        player.projections.length !== nextDeadlines.length ||
        player.projections.some(
          (projection) => projection.offset < 0 || projection.offset >= nextDeadlines.length,
        ) ||
        playerIds.has(player.playerId)
      )
        return false;
      playerIds.add(player.playerId);
      return true;
    }) ||
    playerIds.size !== expectedPlayerCount
  ) {
    return null;
  }
  const ageMs = now.getTime() - fetchedAt;
  if (ageMs < 0) return null;
  if (ageMs > PRICE_CHANGE_MAX_AGE_MS) return unavailableBoard();
  const board: PriceChangeBoard = {
    status: ageMs < PRICE_CHANGE_READY_MS ? 'READY' : 'STALE',
    source: 'FPL_BOOTSTRAP',
    deadline: context.deadline,
    nextDeadlines: [...nextDeadlines],
    fetchedAt: new Date(fetchedAt).toISOString(),
    staleAt: new Date(staleAt).toISOString(),
    revision: manifest.publicationId,
    expectedPlayerCount,
    observedPlayerCount,
    players: [...players].sort((left, right) => left.playerId - right.playerId),
  };
  return board;
}

function parseDelivery(
  delivery: Awaited<ReturnType<typeof loadDataPublicationDelivery>>,
): DataPublicationReadResult {
  const items: Record<string, unknown> = {};
  for (const item of delivery.items) {
    try {
      items[item.manifest.name] = JSON.parse(item.payload) as unknown;
    } catch {
      throw new PriceChangePredictionUnavailableError(
        `Price-change publication item ${item.manifest.name} is not JSON`,
      );
    }
  }
  return { manifest: delivery.manifest, items };
}

type CanonicalPriceChangeRead = Readonly<{
  board: PriceChangeBoard | null;
  hasActivePublication: boolean;
}>;

async function readCanonicalPriceChangePublication(
  season: FplSeasonRef,
): Promise<CanonicalPriceChangeRead> {
  const scope = { dataset: PRICE_CHANGE_DATASET, seasonCode: season.seasonCode } as const;
  let active: Awaited<ReturnType<typeof syncOperationsRepository.findActivePublication>> = null;
  let databaseAvailable = true;
  try {
    active = await syncOperationsRepository.findActivePublication(PRICE_CHANGE_DATASET, season);
  } catch {
    databaseAvailable = false;
  }

  const redisPublication = await readActiveDataPublication(scope).catch(() => null);
  if (active) {
    // The DB active pointer is the canonical revision. Redis is only a
    // delivery of that revision; a structurally valid older pointer must not
    // be served while the outbox is catching up.
    if (
      redisPublication &&
      redisPublication.manifest.publicationId === active.publicationId &&
      redisPublication.manifest.revision === active.revision
    ) {
      const board = parsePublishedPriceChangeBoard(redisPublication);
      if (board) return { board, hasActivePublication: true };
    }

    const delivery = await loadDataPublicationDelivery(active.publicationId).catch(() => null);
    if (
      !delivery ||
      delivery.manifest.publicationId !== active.publicationId ||
      delivery.manifest.revision !== active.revision
    ) {
      return { board: null, hasActivePublication: true };
    }
    return {
      board: parsePublishedPriceChangeBoard(parseDelivery(delivery)),
      hasActivePublication: true,
    };
  }

  // If the DB itself is unavailable, retain the read-only Redis resilience
  // path. When the DB is reachable and has no active publication, do not
  // invent a canonical board from an orphaned pointer.
  if (databaseAvailable || !redisPublication) {
    return { board: null, hasActivePublication: false };
  }
  return { board: parsePublishedPriceChangeBoard(redisPublication), hasActivePublication: false };
}

type CorePublicationEvidence = Readonly<{
  publicationId: string;
  revision: number;
  playerIds: ReadonlySet<number>;
}>;

async function readCorePublicationEvidence(season: FplSeasonRef): Promise<CorePublicationEvidence> {
  const active = await syncOperationsRepository.findActivePublication('fpl:core', season);
  if (!active) throw new PriceChangeCorePublicationRequiredError();
  const delivery = await loadDataPublicationDelivery(active.publicationId).catch(() => null);
  if (
    !delivery ||
    delivery.manifest.dataset !== 'fpl:core' ||
    delivery.manifest.publicationId !== active.publicationId ||
    delivery.manifest.revision !== active.revision
  ) {
    throw new PriceChangeCorePublicationRequiredError(
      'The active fpl:core publication proof is invalid',
    );
  }
  const playersItem = delivery.items.find((item) => item.manifest.name === 'players');
  if (!playersItem) throw new PriceChangeCorePublicationRequiredError();
  let payload: unknown;
  try {
    payload = JSON.parse(playersItem.payload) as unknown;
  } catch {
    throw new PriceChangeCorePublicationRequiredError(
      'The active fpl:core players payload is invalid',
    );
  }
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new PriceChangeCorePublicationRequiredError(
      'The active fpl:core players payload is empty',
    );
  }
  const ids = new Set<number>();
  for (const player of payload) {
    if (!isRecord(player) || !Number.isInteger(player.id) || Number(player.id) <= 0) {
      throw new PriceChangeCorePublicationRequiredError(
        'The active fpl:core player IDs are invalid',
      );
    }
    ids.add(Number(player.id));
  }
  if (ids.size !== payload.length) {
    throw new PriceChangeCorePublicationRequiredError(
      'The active fpl:core player IDs are not unique',
    );
  }
  return { publicationId: active.publicationId, revision: active.revision, playerIds: ids };
}

async function readCorePlayerIds(season: FplSeasonRef): Promise<ReadonlySet<number>> {
  return (await readCorePublicationEvidence(season)).playerIds;
}

async function readLegacyPriceChangeBoard(season: FplSeasonRef): Promise<PriceChangeBoard | null> {
  if (!redisSingleton.isHealthy()) return null;
  try {
    const redis = await redisSingleton.getClient();
    const raw = await redis.get(PRICE_CHANGE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    const candidate = isRecord(parsed) && isRecord(parsed.board) ? parsed.board : parsed;
    if (
      !isRecord(candidate) ||
      !Array.isArray(candidate.players) ||
      typeof candidate.fetchedAt !== 'string'
    ) {
      return null;
    }
    const fetchedAt = Date.parse(candidate.fetchedAt);
    if (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt >= PRICE_CHANGE_MAX_AGE_MS)
      return null;
    const ids = await readCorePlayerIds(season);
    const players = candidate.players.filter(isPriceChangePlayer);
    const playerIds = new Set(players.map((player) => player.playerId));
    if (
      players.length !== candidate.players.length ||
      playerIds.size !== ids.size ||
      [...ids].some((id) => !playerIds.has(id))
    ) {
      return null;
    }
    return {
      ...(candidate as unknown as PriceChangeBoard),
      status: 'STALE',
      revision: typeof candidate.revision === 'string' ? candidate.revision : 'legacy',
      expectedPlayerCount: ids.size,
      observedPlayerCount: players.length,
      players: players.sort((left, right) => left.playerId - right.playerId),
    };
  } catch {
    return null;
  }
}

export async function getPriceChangePredictions(): Promise<PriceChangeBoard> {
  const season = await seasonRepository.findCurrent();
  const canonical = await readCanonicalPriceChangePublication(season);
  if (canonical.board) return canonical.board;
  const legacy = canonical.hasActivePublication ? null : await readLegacyPriceChangeBoard(season);
  return legacy ?? unavailableBoard();
}

export async function preparePriceChangePublication(
  season: FplSeasonRef,
  dependencies: PriceChangePublicationDependencies = defaultDependencies,
  trigger: 'cron' | 'manual' | 'queue' = 'queue',
  sourceRunIdOverride?: string,
  freshnessWindowId?: number,
): Promise<PriceChangePreparationResult> {
  const sourceRunId = sourceRunIdOverride ?? randomUUID();
  await syncOperationsRepository.startRun({
    runId: sourceRunId,
    provider: 'fpl',
    lane: 'price-change-predictions',
    scope: 'price-change-predictions',
    season,
    mode: 'publication',
    trigger,
    expectedItems: 2,
  });
  try {
    const { bootstrap, requestStartedAt, fetchedAt } =
      await requestPriceChangeBootstrap(dependencies);
    if (!bootstrap || !Array.isArray(bootstrap.elements) || bootstrap.elements.length === 0) {
      throw new PriceChangePredictionValidationError('FPL bootstrap contains no players');
    }
    if (!hasPredictionFields(bootstrap)) {
      const active = await syncOperationsRepository.findActivePublication(
        PRICE_CHANGE_DATASET,
        season,
      );
      if (active) {
        throw new PriceChangePredictionUnavailableError(
          'Official price-change fields disappeared while an active publication exists',
        );
      }
      await syncOperationsRepository.finishRun(sourceRunId, {
        status: 'skipped',
        completedItems: 0,
        skippedItems: 2,
        dataChanged: false,
        metadata: { reason: 'official_fields_not_open' },
      });
      return {
        outcome: 'noop',
        season: season.seasonCode,
        sourceRunId,
        reason: 'official_fields_not_open',
      };
    }

    const core = await readCorePublicationEvidence(season);
    const board = normalizePriceChangeBoard(bootstrap, fetchedAt, undefined, core.playerIds);
    const context = contextFromBoard(board, fetchedAt);
    return {
      outcome: 'ready',
      season,
      sourceRunId,
      freshnessWindowId,
      requestStartedAt,
      fetchedAt,
      corePublicationId: core.publicationId,
      corePublicationRevision: core.revision,
      board,
      context,
    };
  } catch (error) {
    const skipReason = priceRunSkipReason(error);
    if (skipReason) {
      await syncOperationsRepository
        .finishRun(sourceRunId, {
          status: 'skipped',
          completedItems: 0,
          skippedItems: 2,
          dataChanged: false,
          metadata: { reason: skipReason },
        })
        .catch(() => undefined);
    } else {
      await syncOperationsRepository.failRun(sourceRunId, error).catch(() => undefined);
    }
    throw error;
  }
}

async function ensurePriceChangePublicationDelivered(
  season: FplSeasonRef,
  publicationId: string,
  revision: number,
): Promise<void> {
  const delivered = await dispatchDataPublicationOutbox({ limit: 1, publicationId });
  if (delivered.delivered === 1) return;
  const active = await readActiveDataPublication({
    dataset: PRICE_CHANGE_DATASET,
    seasonCode: season.seasonCode,
  });
  if (active?.manifest.publicationId === publicationId && active.manifest.revision === revision)
    return;
  throw new Error(
    `Price-change publication ${publicationId} is canonical but Redis delivery is pending`,
  );
}

export async function persistPriceChangePublication(
  prepared: PreparedPriceChangePublication,
  options: {
    readonly deferDelivery?: boolean;
    readonly publicationFence?: {
      readonly laneId: string;
      readonly dispatchGeneration: number;
      readonly activeObligationId: string;
    };
  } = {},
): Promise<PriceChangeSyncResult> {
  const {
    season,
    sourceRunId,
    requestStartedAt,
    fetchedAt,
    corePublicationId,
    corePublicationRevision,
    board,
    context,
  } = prepared;
  const publicationId = randomUUID();
  const outboxId = randomUUID();
  let dbActivated = false;
  try {
    const active = await syncOperationsRepository.findActivePublication(
      PRICE_CHANGE_DATASET,
      season,
    );
    if (active) {
      const activeManifest = await syncOperationsRepository.findActivePublicationManifest(
        PRICE_CHANGE_DATASET,
        season,
      );
      if (!activeManifest) {
        throw new PriceChangePredictionUnavailableError(
          'The active fpl:price-changes publication manifest is invalid',
        );
      }
      const activeRequestStartedAt = Date.parse(activeManifest.sourceCheckedAt);
      if (!Number.isFinite(activeRequestStartedAt)) {
        throw new PriceChangePredictionUnavailableError(
          'The active fpl:price-changes source timestamp is invalid',
        );
      }
      const requestStartedAtMs = requestStartedAt.getTime();
      if (!Number.isFinite(requestStartedAtMs)) {
        throw new PriceChangePredictionUnavailableError(
          'The prepared price-change request timestamp is invalid',
        );
      }
      if (requestStartedAtMs < activeRequestStartedAt) {
        throw new PriceChangePredictionUnavailableError(
          'The prepared price-change request started before the active publication',
        );
      }
    }

    const currentCore = await readCorePublicationEvidence(season);
    if (
      currentCore.publicationId !== corePublicationId ||
      currentCore.revision !== corePublicationRevision
    ) {
      throw new PriceChangeCorePublicationRequiredError(
        'The active fpl:core publication changed while price changes were being prepared',
      );
    }
    const currentCorePlayerIds = currentCore.playerIds;
    const publishedPlayerIds = new Set(board.players.map((player) => player.playerId));
    if (
      currentCorePlayerIds.size !== publishedPlayerIds.size ||
      [...currentCorePlayerIds].some((playerId) => !publishedPlayerIds.has(playerId))
    ) {
      throw new PriceChangeCorePublicationRequiredError(
        'The active fpl:core publication changed while price changes were being prepared',
      );
    }
    const publication = await syncOperationsRepository.preparePublication({
      publicationId,
      dataset: PRICE_CHANGE_DATASET,
      season,
      sourceRunId,
      manifest: {
        state: 'staging',
        sourceCheckedAt: requestStartedAt.toISOString(),
        lastSuccessfulFetchAt: fetchedAt.toISOString(),
      },
    });
    const preparedData = prepareDataPublication({
      dataset: PRICE_CHANGE_DATASET,
      seasonCode: season.seasonCode,
      revision: publication.revision,
      publicationId: publication.publicationId,
      sourceCheckedAt: requestStartedAt,
      lastSuccessfulFetchAt: fetchedAt,
      freshnessWindowId: prepared.freshnessWindowId,
      state: 'active',
      items: [
        { name: 'context', value: context },
        { name: 'players', value: board.players },
      ],
    });
    const byName = new Map(preparedData.items.map((item) => [item.manifest.name, item]));
    await syncOperationsRepository.stagePublicationItems(
      publication.publicationId,
      preparedData.manifest.items.map((item) => {
        const staged = byName.get(item.name);
        if (!staged) throw new Error(`Price-change publication item ${item.name} is missing`);
        return {
          name: item.name as 'context' | 'players',
          payload: item.name === 'context' ? context : board.players,
          count: item.count,
          checksum: item.sha256,
        };
      }),
    );
    await syncOperationsRepository.activatePublication({
      publicationId: publication.publicationId,
      dataset: PRICE_CHANGE_DATASET,
      season,
      sourceRunId,
      manifest: preparedData.manifest,
      outbox: { outboxId },
      ...(options.publicationFence
        ? {
            beforeActivate: async (tx) => {
              await assertSchedulerLanePublicationFence(tx, options.publicationFence!);
              const activeCore = await syncOperationsRepository.findActivePublication(
                'fpl:core',
                season,
              );
              if (
                activeCore?.publicationId !== corePublicationId ||
                activeCore.revision !== corePublicationRevision
              ) {
                throw new PriceChangeCorePublicationRequiredError(
                  'The active fpl:core publication changed before price publication activation',
                );
              }
            },
          }
        : {
            beforeActivate: async () => {
              const activeCore = await syncOperationsRepository.findActivePublication(
                'fpl:core',
                season,
              );
              if (
                activeCore?.publicationId !== corePublicationId ||
                activeCore.revision !== corePublicationRevision
              ) {
                throw new PriceChangeCorePublicationRequiredError(
                  'The active fpl:core publication changed before price publication activation',
                );
              }
            },
          }),
    });
    dbActivated = true;
    if (!options.deferDelivery) {
      await ensurePriceChangePublicationDelivered(
        season,
        publication.publicationId,
        publication.revision,
      );
    }
    logInfo('Price-change Data publication activated', {
      season: season.seasonCode,
      publicationId: publication.publicationId,
      revision: publication.revision,
      fetchedAt: fetchedAt.toISOString(),
      players: board.players.length,
    });
    return {
      outcome: 'ready',
      season: season.seasonCode,
      players: board.players.length,
      fetchedAt: fetchedAt.toISOString(),
      publicationId: publication.publicationId,
      revision: publication.revision,
    };
  } catch (error) {
    if (!dbActivated) {
      const skipReason = priceRunSkipReason(error);
      if (skipReason) {
        // Publication-fence and Core-refresh races are expected latest-wins
        // supersessions, not failed source fetches. Retire a staging row with
        // the skip-aware atomic path so its source run is recorded as skipped
        // instead of being made terminally failed first.
        await syncOperationsRepository
          .skipPublication(publicationId, skipReason)
          .catch(() => undefined);
        await syncOperationsRepository
          .finishRun(sourceRunId, {
            status: 'skipped',
            completedItems: 0,
            skippedItems: board.players.length,
            dataChanged: false,
            metadata: { reason: skipReason },
          })
          .catch(() => undefined);
      } else {
        await syncOperationsRepository.failPublication(publicationId, error).catch(() => undefined);
        await syncOperationsRepository.failRun(sourceRunId, error).catch(() => undefined);
      }
    }
    throw error;
  }
}

export async function syncPriceChangePredictions(
  season: FplSeasonRef,
  dependencies: PriceChangePublicationDependencies = defaultDependencies,
  trigger: 'cron' | 'manual' | 'queue' = 'queue',
): Promise<PriceChangeSyncResult> {
  const prepared = await preparePriceChangePublication(season, dependencies, trigger);
  if (prepared.outcome === 'noop') {
    return { outcome: 'noop', season: prepared.season, players: 0 };
  }
  let persisted: PriceChangeSyncResult;
  try {
    persisted = await withMutationScopes(
      {
        queueName: 'data-sync',
        jobName: 'price-change-predictions',
        jobId: `price-change-${prepared.sourceRunId}`,
      },
      () => persistPriceChangePublication(prepared, { deferDelivery: true }),
    );
  } catch (error) {
    // The mutation scope rolls back together with the process on a failed
    // activation. Record the already-created source run after that rollback
    // so invalid input and core races do not remain falsely RUNNING.
    await syncOperationsRepository.failRun(prepared.sourceRunId, error).catch(() => undefined);
    throw error;
  }
  await ensurePriceChangePublicationDelivered(
    prepared.season,
    persisted.publicationId!,
    persisted.revision!,
  );
  return persisted;
}
