import { createHash } from 'node:crypto';

import { redisSingleton } from '../cache/singleton';
import { fplClient, type FPLBootstrapResponse } from '../clients/fpl';

export const PRICE_CHANGE_FRESH_MS = 5 * 60 * 1000;
export const PRICE_CHANGE_STALE_MS = 60 * 60 * 1000;

const PRICE_CHANGE_CACHE_KEY = 'fpl:price-change-predictions:v1';
const STALE_RETRY_MS = 30 * 1000;

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

type CacheEntry = {
  board: PriceChangeBoard;
  freshUntil: number;
  staleUntil: number;
};

let memoryEntry: CacheEntry | null = null;
let inFlight: Promise<PriceChangeBoard> | null = null;
let lastRefreshAttemptAt = 0;

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

function positionFromElementType(elementType: number): PriceChangePlayer['position'] {
  if (elementType === 1) return 'GKP';
  if (elementType === 2) return 'DEF';
  if (elementType === 4) return 'FWD';
  return 'MID';
}

function predictionStatus(
  likelihood: number | null,
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

function getDeadlines(bootstrap: FPLBootstrapResponse): string[] {
  const deadlines = bootstrap.game_config?.settings?.price_change_deadlines ?? [];
  return deadlines
    .map((value) => normalizeDate(value))
    .filter((value): value is string => value !== null);
}

export function normalizePriceChangeBoard(
  bootstrap: FPLBootstrapResponse,
  fetchedAt = new Date(),
  staleAt = new Date(fetchedAt.getTime() + PRICE_CHANGE_STALE_MS),
): PriceChangeBoard {
  const teamsById = new Map(bootstrap.teams.map((team) => [team.id, team]));
  const players: PriceChangePlayer[] = [];

  for (const element of bootstrap.elements) {
    const priceChangePercent = finiteNumber(element.price_change_percent);
    const hourlyRate = finiteNumber(element.price_change_hourly_rate);
    const selectedByPercent = finiteNumber(element.selected_by_percent);
    if (priceChangePercent === null || hourlyRate === null || selectedByPercent === null) {
      continue;
    }

    const team = teamsById.get(element.team);
    const lockedUntil = normalizeDate(element.price_change_locked_until);
    const projections = (element.price_change_projections ?? [])
      .map((projection): PriceChangeProjection | null => {
        const projectedPercent = finiteNumber(projection.projected_percent);
        const likelihood = finiteNumber(projection.likelihood);
        if (projectedPercent === null || likelihood === null) return null;
        return {
          offset: projection.offset,
          projectedPercent,
          likelihood,
        };
      })
      .filter((projection): projection is PriceChangeProjection => projection !== null);
    const firstLikelihood = projections[0]?.likelihood ?? null;
    const calibrating = element.price_change_calibrating === true;
    const transfersInEvent = element.transfers_in_event;
    const transfersOutEvent = element.transfers_out_event;

    players.push({
      playerId: element.id,
      playerCode: element.code,
      webName: element.web_name,
      teamId: element.team,
      teamName: team?.name ?? 'Unknown',
      teamShortName: team?.short_name ?? '—',
      position: positionFromElementType(element.element_type),
      currentPrice: element.now_cost,
      selectedByPercent,
      progressPercent: priceChangePercent,
      hourlyRate,
      status: predictionStatus(firstLikelihood, lockedUntil, calibrating),
      ownershipTrend: ownershipTrend(transfersInEvent, transfersOutEvent),
      transfersInEvent,
      transfersOutEvent,
      lockedUntil,
      calibrating,
      projections,
    });
  }

  const nextDeadlines = getDeadlines(bootstrap);
  const revision = createHash('sha1')
    .update(
      JSON.stringify({
        deadline: nextDeadlines[0] ?? null,
        players,
      }),
    )
    .digest('hex')
    .slice(0, 16);

  return {
    status: players.length === bootstrap.elements.length ? 'READY' : 'PARTIAL',
    source: 'FPL_BOOTSTRAP',
    deadline: nextDeadlines[0] ?? null,
    nextDeadlines,
    fetchedAt: fetchedAt.toISOString(),
    staleAt: staleAt.toISOString(),
    revision,
    expectedPlayerCount: bootstrap.elements.length,
    observedPlayerCount: players.length,
    players,
  };
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

function staleBoard(entry: CacheEntry): PriceChangeBoard {
  return { ...entry.board, status: 'STALE' };
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const board = record.board;
  if (typeof record.freshUntil !== 'number' || typeof record.staleUntil !== 'number') return false;
  if (typeof board !== 'object' || board === null || Array.isArray(board)) return false;
  const boardRecord = board as Record<string, unknown>;
  return (
    typeof boardRecord.revision === 'string' &&
    Array.isArray(boardRecord.players) &&
    typeof boardRecord.expectedPlayerCount === 'number' &&
    typeof boardRecord.observedPlayerCount === 'number'
  );
}

async function readRedisEntry(): Promise<CacheEntry | null> {
  if (!redisSingleton.isHealthy()) return null;
  try {
    const redis = await redisSingleton.getClient();
    const raw = await redis.get(PRICE_CHANGE_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isCacheEntry(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeRedisEntry(entry: CacheEntry): Promise<void> {
  if (!redisSingleton.isHealthy()) return;
  try {
    const redis = await redisSingleton.getClient();
    await redis.set(
      PRICE_CHANGE_CACHE_KEY,
      JSON.stringify(entry),
      'EX',
      Math.ceil(PRICE_CHANGE_STALE_MS / 1000),
    );
  } catch {
    // Redis is an optimization here; the local request cache still protects
    // the FPL endpoint when Redis is unavailable.
  }
}

async function resolvePriceChangePredictions(): Promise<PriceChangeBoard> {
  const now = Date.now();
  let entry = memoryEntry;
  if (!entry) {
    entry = await readRedisEntry();
    if (entry) memoryEntry = entry;
  }

  if (entry && now < entry.freshUntil) return entry.board;
  if (entry && now < entry.staleUntil && now - lastRefreshAttemptAt < STALE_RETRY_MS) {
    return staleBoard(entry);
  }

  lastRefreshAttemptAt = now;
  try {
    const fetchedAt = new Date();
    const board = normalizePriceChangeBoard(
      await fplClient.getBootstrap(),
      fetchedAt,
      new Date(fetchedAt.getTime() + PRICE_CHANGE_STALE_MS),
    );
    const nextEntry: CacheEntry = {
      board,
      freshUntil: fetchedAt.getTime() + PRICE_CHANGE_FRESH_MS,
      staleUntil: fetchedAt.getTime() + PRICE_CHANGE_STALE_MS,
    };
    memoryEntry = nextEntry;
    await writeRedisEntry(nextEntry);
    return board;
  } catch {
    if (entry && now < entry.staleUntil) return staleBoard(entry);
    return unavailableBoard();
  }
}

export function getPriceChangePredictions(): Promise<PriceChangeBoard> {
  if (!inFlight) {
    inFlight = resolvePriceChangePredictions().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}
