import { z } from 'zod';

import { getConfig } from '../utils/config';
import { logDebug, logWarn } from '../utils/logger';
import { acquireUnderstatRequestPermit } from '../utils/understat-rate-limit';

const NUMERIC_STRING = /^-?(?:\d+\.?\d*|\.\d+)$/;

const numericString = z
  .string()
  .trim()
  .min(1)
  .regex(NUMERIC_STRING)
  .transform((value) => Number(value));

export const UnderstatNumberSchema = z
  .union([z.number(), numericString])
  .refine(Number.isFinite, 'Expected a finite number');

export const UnderstatIntegerSchema = UnderstatNumberSchema.refine(Number.isInteger, {
  message: 'Expected an integer',
});

export const UnderstatIdSchema = UnderstatIntegerSchema.refine((value) => value > 0, {
  message: 'Expected a positive identifier',
});

const nullableNumber = UnderstatNumberSchema.nullable();
const nullableInteger = UnderstatIntegerSchema.nullable();

export const UnderstatTeamReferenceSchema = z
  .object({
    id: UnderstatIdSchema,
    title: z.string().min(1),
    short_title: z.string().min(1).optional(),
  })
  .passthrough();

export const UnderstatMatchDateSchema = z
  .object({
    id: UnderstatIdSchema,
    isResult: z.boolean(),
    h: UnderstatTeamReferenceSchema,
    a: UnderstatTeamReferenceSchema,
    goals: z.object({ h: nullableInteger, a: nullableInteger }).passthrough(),
    xG: z.object({ h: nullableNumber, a: nullableNumber }).passthrough(),
    datetime: z.string().min(1),
    forecast: z
      .object({
        w: nullableNumber,
        d: nullableNumber,
        l: nullableNumber,
      })
      .passthrough(),
    side: z.enum(['h', 'a']).optional(),
    result: z.enum(['w', 'd', 'l']).optional(),
  })
  .passthrough();

export const UnderstatTeamHistorySchema = z
  .object({
    h_a: z.enum(['h', 'a']),
    xG: UnderstatNumberSchema,
    xGA: UnderstatNumberSchema,
    npxG: UnderstatNumberSchema,
    npxGA: UnderstatNumberSchema,
    npxGD: UnderstatNumberSchema,
    ppda: z.object({ att: UnderstatIntegerSchema, def: UnderstatIntegerSchema }).passthrough(),
    ppda_allowed: z
      .object({ att: UnderstatIntegerSchema, def: UnderstatIntegerSchema })
      .passthrough(),
    deep: UnderstatIntegerSchema,
    deep_allowed: UnderstatIntegerSchema,
    scored: UnderstatIntegerSchema,
    missed: UnderstatIntegerSchema,
    xpts: UnderstatNumberSchema,
    result: z.enum(['w', 'd', 'l']),
    date: z.string().min(1),
    wins: UnderstatIntegerSchema,
    draws: UnderstatIntegerSchema,
    loses: UnderstatIntegerSchema,
    pts: UnderstatIntegerSchema,
  })
  .passthrough();

export const UnderstatLeagueTeamSchema = z
  .object({
    id: UnderstatIdSchema,
    title: z.string().min(1),
    history: z.array(UnderstatTeamHistorySchema),
  })
  .passthrough();

export const UnderstatPlayerSummarySchema = z
  .object({
    id: UnderstatIdSchema,
    player_name: z.string().min(1),
    games: UnderstatIntegerSchema,
    time: UnderstatIntegerSchema,
    goals: UnderstatIntegerSchema,
    npg: UnderstatIntegerSchema,
    assists: UnderstatIntegerSchema,
    shots: UnderstatIntegerSchema,
    key_passes: UnderstatIntegerSchema,
    yellow_cards: UnderstatIntegerSchema,
    red_cards: UnderstatIntegerSchema,
    xG: UnderstatNumberSchema,
    npxG: UnderstatNumberSchema,
    xA: UnderstatNumberSchema,
    xGChain: UnderstatNumberSchema,
    xGBuildup: UnderstatNumberSchema,
    position: z.string(),
    team_title: z.string(),
  })
  .passthrough();

export const UnderstatLeagueResponseSchema = z
  .object({
    dates: z.array(UnderstatMatchDateSchema),
    teams: z.record(UnderstatLeagueTeamSchema),
    players: z.array(UnderstatPlayerSummarySchema),
  })
  .passthrough();

const UnderstatSplitValueSchema = z
  .object({
    stat: z.string().optional(),
    time: UnderstatIntegerSchema.optional(),
    shots: UnderstatIntegerSchema,
    goals: UnderstatIntegerSchema,
    xG: UnderstatNumberSchema,
    against: z
      .object({
        shots: UnderstatIntegerSchema,
        goals: UnderstatIntegerSchema,
        xG: UnderstatNumberSchema,
      })
      .passthrough(),
  })
  .passthrough();

const UnderstatSplitRecordSchema = z.record(UnderstatSplitValueSchema);

export const UnderstatTeamResponseSchema = z
  .object({
    dates: z.array(UnderstatMatchDateSchema),
    players: z.array(UnderstatPlayerSummarySchema),
    statistics: z
      .object({
        situation: UnderstatSplitRecordSchema,
        formation: UnderstatSplitRecordSchema,
        gameState: UnderstatSplitRecordSchema,
        timing: UnderstatSplitRecordSchema,
        shotZone: UnderstatSplitRecordSchema,
        attackSpeed: UnderstatSplitRecordSchema,
        result: UnderstatSplitRecordSchema,
      })
      .passthrough(),
  })
  .passthrough();

export const UnderstatRosterEntrySchema = z
  .object({
    id: UnderstatIdSchema,
    goals: UnderstatIntegerSchema,
    own_goals: UnderstatIntegerSchema,
    shots: UnderstatIntegerSchema,
    xG: UnderstatNumberSchema,
    time: UnderstatIntegerSchema,
    player_id: UnderstatIdSchema,
    team_id: UnderstatIdSchema,
    position: z.string().min(1),
    player: z.string().min(1),
    h_a: z.enum(['h', 'a']),
    yellow_card: UnderstatIntegerSchema,
    red_card: UnderstatIntegerSchema,
    roster_in: z.union([z.literal(0), UnderstatIntegerSchema]),
    roster_out: z.union([z.literal(0), UnderstatIntegerSchema]),
    key_passes: UnderstatIntegerSchema,
    assists: UnderstatIntegerSchema,
    xA: UnderstatNumberSchema,
    xGChain: UnderstatNumberSchema,
    xGBuildup: UnderstatNumberSchema,
    positionOrder: UnderstatIntegerSchema,
  })
  .passthrough();

export const UnderstatShotSchema = z
  .object({
    id: UnderstatIdSchema,
    minute: UnderstatIntegerSchema,
    result: z.string().min(1),
    X: UnderstatNumberSchema,
    Y: UnderstatNumberSchema,
    xG: UnderstatNumberSchema,
    player: z.string().min(1),
    h_a: z.enum(['h', 'a']),
    player_id: UnderstatIdSchema,
    situation: z.string().min(1),
    season: UnderstatIntegerSchema,
    shotType: z.string().min(1),
    match_id: UnderstatIdSchema,
    h_team: z.string().min(1),
    a_team: z.string().min(1),
    h_goals: UnderstatIntegerSchema,
    a_goals: UnderstatIntegerSchema,
    date: z.string().min(1),
    player_assisted: z.string().nullable(),
    lastAction: z.string(),
  })
  .passthrough();

export const UnderstatMatchResponseSchema = z
  .object({
    rosters: z.object({
      h: z.record(UnderstatRosterEntrySchema),
      a: z.record(UnderstatRosterEntrySchema),
    }),
    shots: z.object({
      h: z.array(UnderstatShotSchema),
      a: z.array(UnderstatShotSchema),
    }),
    tmpl: z.record(z.unknown()),
  })
  .passthrough();

const UnderstatPlayerMatchSchema = z
  .object({
    id: UnderstatIdSchema,
    roster_id: UnderstatIdSchema,
    date: z.string().min(1),
    season: UnderstatIntegerSchema,
    h_team: z.string().min(1),
    a_team: z.string().min(1),
    h_goals: UnderstatIntegerSchema,
    a_goals: UnderstatIntegerSchema,
    goals: UnderstatIntegerSchema,
    assists: UnderstatIntegerSchema,
    shots: UnderstatIntegerSchema,
    key_passes: UnderstatIntegerSchema,
    xG: UnderstatNumberSchema,
    npxG: UnderstatNumberSchema,
    xA: UnderstatNumberSchema,
    xGChain: UnderstatNumberSchema,
    xGBuildup: UnderstatNumberSchema,
    time: UnderstatIntegerSchema,
    position: z.string(),
    npg: UnderstatIntegerSchema,
  })
  .passthrough();

export const UnderstatPlayerResponseSchema = z
  .object({
    player: z
      .object({
        id: UnderstatIdSchema,
        name: z.string().min(1),
        favorite_position: z.string().nullable(),
      })
      .passthrough(),
    matches: z.array(UnderstatPlayerMatchSchema),
    groups: z.record(z.unknown()),
    positionsList: z.array(z.unknown()),
    minMaxPlayerStats: z.unknown(),
    shots: z.array(UnderstatShotSchema),
    lastMatch: z.unknown(),
  })
  .passthrough();

export type UnderstatLeagueResponse = z.infer<typeof UnderstatLeagueResponseSchema>;
export type UnderstatTeamResponse = z.infer<typeof UnderstatTeamResponseSchema>;
export type UnderstatMatchResponse = z.infer<typeof UnderstatMatchResponseSchema>;
export type UnderstatPlayerResponse = z.infer<typeof UnderstatPlayerResponseSchema>;
export type UnderstatMatchDate = z.infer<typeof UnderstatMatchDateSchema>;
export type UnderstatTeamHistory = z.infer<typeof UnderstatTeamHistorySchema>;
export type UnderstatPlayerSummary = z.infer<typeof UnderstatPlayerSummarySchema>;
export type UnderstatRosterEntry = z.infer<typeof UnderstatRosterEntrySchema>;

export class UnderstatClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly cause?: Error,
    readonly retryable = false,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'UnderstatClientError';
  }
}

export interface UnderstatClientOptions {
  baseUrl?: string;
  enabled?: boolean;
  timeoutMs?: number;
  maxConcurrency?: number;
  acquirePermit?: () => Promise<() => Promise<void>>;
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function parseRetryAfterMs(response: Response): number | null {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(date - Date.now(), 0);
}

export class UnderstatClient {
  private readonly baseUrl: string;
  private readonly enabled: boolean;
  private readonly timeoutMs: number;
  private readonly maxConcurrency: number;
  private readonly acquirePermit?: () => Promise<() => Promise<void>>;
  private readonly fetchFn: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  private activeRequests = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(options: UnderstatClientOptions = {}) {
    const config = getConfig();
    this.baseUrl = (options.baseUrl ?? config.UNDERSTAT_BASE_URL).replace(/\/$/, '');
    this.enabled = options.enabled ?? config.UNDERSTAT_ENABLED;
    this.timeoutMs = options.timeoutMs ?? config.UNDERSTAT_TIMEOUT_MS;
    this.maxConcurrency = options.maxConcurrency ?? config.UNDERSTAT_MAX_CONCURRENCY;
    this.acquirePermit = options.acquirePermit;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  private async acquire(): Promise<void> {
    if (this.activeRequests < this.maxConcurrency) {
      this.activeRequests += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter();
    else this.activeRequests -= 1;
  }

  private async request<Schema extends z.ZodTypeAny>(
    path: string,
    schema: Schema,
    expectedRootKeys: readonly string[],
  ): Promise<z.output<Schema>> {
    if (!this.enabled) {
      throw new UnderstatClientError(
        'Understat access is disabled by UNDERSTAT_ENABLED',
        'DISABLED',
      );
    }

    await this.acquire();
    let releasePermit: (() => Promise<void>) | undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      releasePermit = await this.acquirePermit?.();
      const url = `${this.baseUrl}${path}`;
      logDebug('Fetching Understat resource', { url });
      const response = await this.fetchFn(url, {
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': 'letletme-data/1.0.0 (+https://github.com/tonglam/letletme_data)',
          Accept: 'application/json,text/javascript;q=0.9,*/*;q=0.1',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new UnderstatClientError(
          `Understat returned HTTP ${response.status}`,
          'HTTP_ERROR',
          response.status,
          undefined,
          retryableStatus(response.status),
          parseRetryAfterMs(response),
        );
      }

      const text = await response.text();
      if (text.trim().length === 0) {
        throw new UnderstatClientError('Understat returned an empty response', 'EMPTY_RESPONSE');
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (error) {
        throw new UnderstatClientError(
          'Understat returned invalid JSON',
          'INVALID_JSON',
          response.status,
          error instanceof Error ? error : undefined,
        );
      }

      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        logWarn('Understat response validation failed', {
          path,
          issues: parsed.error.issues.slice(0, 10),
        });
        throw new UnderstatClientError(
          'Understat response failed validation',
          'VALIDATION_ERROR',
          response.status,
          parsed.error,
        );
      }
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        const unknownKeys = Object.keys(json).filter((key) => !expectedRootKeys.includes(key));
        if (unknownKeys.length > 0) {
          logWarn('Understat response contains unknown top-level fields', { path, unknownKeys });
        }
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof UnderstatClientError) throw error;
      const cause = error instanceof Error ? error : new Error(String(error));
      const timedOut = cause.name === 'AbortError';
      throw new UnderstatClientError(
        timedOut ? 'Understat request timed out' : 'Understat network request failed',
        timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
        undefined,
        cause,
        true,
      );
    } finally {
      clearTimeout(timeout);
      if (releasePermit) {
        await releasePermit().catch((error) =>
          logWarn('Failed to release Understat request permit; lease will expire', {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      this.release();
    }
  }

  getLeagueData(league: string, sourceYear: number): Promise<UnderstatLeagueResponse> {
    return this.request(
      `/getLeagueData/${encodeURIComponent(league)}/${sourceYear}`,
      UnderstatLeagueResponseSchema,
      ['dates', 'teams', 'players'],
    );
  }

  getTeamData(teamTitle: string, sourceYear: number): Promise<UnderstatTeamResponse> {
    return this.request(
      `/getTeamData/${encodeURIComponent(teamTitle)}/${sourceYear}`,
      UnderstatTeamResponseSchema,
      ['dates', 'players', 'statistics'],
    );
  }

  getMatchData(matchId: number): Promise<UnderstatMatchResponse> {
    return this.request(`/getMatchData/${matchId}`, UnderstatMatchResponseSchema, [
      'rosters',
      'shots',
      'tmpl',
    ]);
  }

  getPlayerData(playerId: number): Promise<UnderstatPlayerResponse> {
    return this.request(`/getPlayerData/${playerId}`, UnderstatPlayerResponseSchema, [
      'player',
      'matches',
      'groups',
      'positionsList',
      'minMaxPlayerStats',
      'shots',
      'lastMatch',
    ]);
  }
}

export const understatClient = new UnderstatClient({
  acquirePermit: acquireUnderstatRequestPermit,
});
