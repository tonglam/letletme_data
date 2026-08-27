import { z } from 'zod';
import { logError, logInfo } from './logger';

export function parseStrictBooleanEnvValue(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean (true/false, 1/0, yes/no or on/off)`);
}

export function booleanEnv(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || (typeof value === 'string' && value.trim() === '')) {
      return defaultValue;
    }
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return value;
    try {
      return parseStrictBooleanEnvValue(value, defaultValue, 'boolean environment variable');
    } catch {
      return value;
    }
  }, z.boolean());
}

function strictNumericValue(value: unknown): unknown {
  if (value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return undefined;
  }
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  // Do not accept exponent, hexadecimal, Infinity or other Number() coercions
  // for environment configuration.  A typo must fail closed at startup.
  if (!/^[+-]?\d+$/.test(trimmed)) return value;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && Number.isSafeInteger(parsed) ? parsed : value;
}

/** Parse one runtime integer override without coercing malformed input. */
export function parseStrictIntegerEnvValue(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim();
  if (!/^[+-]?\d+$/.test(normalized)) {
    throw new Error(`${name} must be a finite safe integer`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a finite safe integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function integerEnv(
  defaultValue: number,
  minimum = Number.MIN_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER,
): z.ZodType<number, z.ZodTypeDef, unknown> {
  const schema = z
    .number()
    .finite()
    .int()
    .min(minimum)
    .max(maximum)
    .refine(Number.isSafeInteger, { message: 'must be a finite safe integer' });
  return z.preprocess(strictNumericValue, schema).default(defaultValue);
}

function boundedIntegerEnv(defaultValue: number, minimum: number, maximum: number) {
  return integerEnv(defaultValue, minimum, maximum);
}

/** dotenv turns `KEY=` into `""`; treat that as unset for optional secrets/URLs. */
function optionalEnv(schema: z.ZodType<string | undefined>) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }, schema);
}

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // API and worker share one Supavisor session-pool login in production. Keep
  // each process bounded so their combined pools leave room for deploy probes.
  // Supabase session-mode poolers commonly expose a 15-connection project
  // pool. API, worker, scheduler, and content-worker each own a process-level
  // pool, so the default must leave headroom for all four services rather
  // than exhausting the project pool as soon as the standalone scheduler is
  // enabled.
  DATABASE_POOL_MAX: boundedIntegerEnv(3, 1, 5),
  // Rebuildable Data publications only. Queue/coordination state must never use this client.
  CACHE_REDIS_HOST: z.string().default('localhost'),
  CACHE_REDIS_PORT: boundedIntegerEnv(6379, 1, 65535),
  CACHE_REDIS_PASSWORD: z.string().optional(),
  CACHE_REDIS_DB: integerEnv(0, 0),
  // BullMQ and all worker coordination. Defaults remain isolated for local development/tests.
  QUEUE_REDIS_HOST: z.string().default('localhost'),
  QUEUE_REDIS_PORT: boundedIntegerEnv(6379, 1, 65535),
  QUEUE_REDIS_PASSWORD: z.string().optional(),
  QUEUE_REDIS_DB: integerEnv(1, 0),
  // Server
  PORT: boundedIntegerEnv(3000, 1, 65535),
  WORKER_HEARTBEAT_PATH: z.string().optional(),
  WORKER_HEARTBEAT_INTERVAL_MS: boundedIntegerEnv(30_000, 1_000, 24 * 60 * 60_000),
  NODE_ENV: z.enum(['production', 'development', 'test']).optional(),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .optional()
    .default('info'),
  // Internal mutation authentication. Store only SHA-256 digests so a config
  // leak does not disclose a usable service credential.
  ENABLE_AUTH: booleanEnv(process.env.NODE_ENV === 'production'),
  DATA_API_KEY_HASHES: z.string().optional(),
  CORS_ORIGINS: z.string().optional(),
  // Private bug-report screenshot lifecycle. Keep disabled until the bucket
  // and expanded database migration are deployed together.
  BUG_REPORT_SCREENSHOT_STORAGE_ENABLED: booleanEnv(false),
  BUG_REPORT_SCREENSHOT_SUPABASE_URL: optionalEnv(z.string().url().optional()),
  BUG_REPORT_SCREENSHOT_SUPABASE_SECRET_KEY: optionalEnv(z.string().min(1).optional()),
  BUG_REPORT_SCREENSHOT_BUCKET: z.string().min(1).default('bug-report-screenshots'),
  BUG_REPORT_SCREENSHOT_RETENTION_DAYS: boundedIntegerEnv(90, 1, 3650),
  // Exact-byte bootstrap-static archive. Production market capture and every
  // historical replay fail closed unless this private object store is ready.
  FPL_RAW_SNAPSHOT_STORAGE_ENABLED: booleanEnv(false),
  FPL_RAW_SNAPSHOT_SUPABASE_URL: optionalEnv(z.string().url().optional()),
  FPL_RAW_SNAPSHOT_SUPABASE_SECRET_KEY: optionalEnv(z.string().min(1).optional()),
  FPL_RAW_SNAPSHOT_BUCKET: z.string().min(1).default('fpl-raw-snapshots'),
  // HTTP mutation rate limit (fixed window per client IP; 0 disables)
  RATE_LIMIT_MUTATIONS_PER_MINUTE: integerEnv(60, 0),
  DATA_SYNC_ATTEMPT_REPORTING_ENABLED: booleanEnv(true),
  // Keep the latest-wins producer opt-in in production during the first
  // rollout. Development and tests exercise the new lane by default.
  PRICE_CHANGE_SINGLE_FLIGHT_ENABLED: booleanEnv(process.env.NODE_ENV !== 'production'),
  PRICE_CHANGE_HOT_WATCH_ENABLED: booleanEnv(process.env.NODE_ENV !== 'production'),
  FPL_ADMISSION_TEST_MODE: booleanEnv(false),
  TOURNAMENT_OFFICIAL_SYNC_DEFAULT_ENABLED: booleanEnv(true),
  FPL_MAX_INFLIGHT: boundedIntegerEnv(5, 1, 32),
  FPL_REQUESTS_PER_SECOND: boundedIntegerEnv(4, 1, 32),
  FPL_BULK_MAX_INFLIGHT_DURING_LIVE: boundedIntegerEnv(3, 1, 32),
  FPL_ADMISSION_LEASE_MS: boundedIntegerEnv(45_000, 1_000, 2 * 60 * 60_000),
  FPL_REQUEST_TIMEOUT_MS: boundedIntegerEnv(10_000, 1_000, 2 * 60 * 60_000),
  FPL_REQUEST_DEADLINE_MS: boundedIntegerEnv(40_000, 1_000, 2 * 60 * 60_000),
  FPL_RETRY_BASE_DELAY_MS: boundedIntegerEnv(500, 0, 5 * 60_000),
  FPL_RETRY_MAX_DELAY_MS: boundedIntegerEnv(5_000, 0, 5 * 60_000),
  // A scheduler definition is a planning stage, not an unbounded provider
  // request.  Keep one slow definition from holding the 30-second pass (and
  // its progress heartbeat) forever.
  SCHEDULER_RESOLVE_TIMEOUT_MS: boundedIntegerEnv(10_000, 1_000, 2 * 60 * 60_000),
  SCHEDULER_LEASE_MS: boundedIntegerEnv(15 * 60_000, 1_000, 2 * 60 * 60_000),
  // Queue governance rollout switches.  They are deliberately opt-in so a
  // rolling deploy can start the new consumers before routing new work.
  QUEUE_LANES_V2_ENABLED: booleanEnv(false),
  QUEUE_ADMISSION_AUTOMATION_ENABLED: booleanEnv(false),
  OFFICIAL_H2H_INCREMENTAL_ENABLED: booleanEnv(false),
  FRESHNESS_CONSUMER_PROBES_ENABLED: booleanEnv(false),
  FRESHNESS_SLO_MODE: z.enum(['shadow', 'enforced']).default('shadow'),
  QUEUE_HEALTH_SNAPSHOT_INTERVAL_MS: boundedIntegerEnv(15_000, 1_000, 15 * 60_000),
  QUEUE_HEALTH_WINDOW_INTERVAL_MS: boundedIntegerEnv(60_000, 1_000, 60 * 60_000),
  QUEUE_HEALTH_SNAPSHOT_TTL_SECONDS: boundedIntegerEnv(180, 30, 900),
  QUEUE_ADMISSION_GREEN_CLEAR_MS: boundedIntegerEnv(5 * 60_000, 1_000, 24 * 60 * 60_000),
  QUEUE_ADMISSION_GATE_TTL_SECONDS: boundedIntegerEnv(900, 1, 900),
  DATA_GOVERNANCE_WEB_URL: optionalEnv(z.string().url().optional()),
  DATA_GOVERNANCE_PROBE_TOKEN: optionalEnv(z.string().min(16).optional()),
  ENTRY_SYNC_CHUNK_SIZE: boundedIntegerEnv(500, 1, 5_000),
  ENTRY_SYNC_CONCURRENCY: boundedIntegerEnv(5, 1, 32),
  ENTRY_SYNC_THROTTLE_MS: boundedIntegerEnv(200, 0, 60_000),
  TOURNAMENT_SETUP_STUCK_CUTOFF_MINUTES: boundedIntegerEnv(15, 1, 24 * 60),
  TOURNAMENT_SETUP_WATCHDOG_INTERVAL_MS: boundedIntegerEnv(300_000, 1_000, 24 * 60 * 60_000),
  TOURNAMENT_EVENT_LIVE_TIMEOUT_MS: boundedIntegerEnv(45_000, 1_000, 2 * 60 * 60_000),
  TOURNAMENT_ENTRY_FETCH_TIMEOUT_MS: boundedIntegerEnv(45_000, 1_000, 2 * 60 * 60_000),
  TOURNAMENT_ENTRY_PERSIST_TIMEOUT_MS: boundedIntegerEnv(60_000, 1_000, 2 * 60 * 60_000),
  LIVE_POLL_MS: boundedIntegerEnv(30_000, 1_000, 24 * 60 * 60_000),
  PICKS_FIRST_PROBE_OFFSET_MS: boundedIntegerEnv(60 * 60_000, 1_000, 24 * 60 * 60_000),
  PICKS_REFRESH_INTERVAL_MS: boundedIntegerEnv(10 * 60_000, 1_000, 24 * 60 * 60_000),
  PICKS_RETRY_SCHEDULE_MS: z.string().default('120000,180000,300000,600000'),
  BETWEEN_FIXTURES_POLL_MS: boundedIntegerEnv(5 * 60_000, 1_000, 24 * 60 * 60_000),
  DAY_SETTLING_INITIAL_POLL_MS: boundedIntegerEnv(60_000, 1_000, 24 * 60 * 60_000),
  DAY_SETTLING_STABLE_POLL_MS: boundedIntegerEnv(5 * 60_000, 1_000, 24 * 60 * 60_000),
  DAY_SETTLING_STABLE_AFTER_MS: boundedIntegerEnv(10 * 60_000, 1_000, 24 * 60 * 60_000),
  PICKS_PROBE_POLL_MS: boundedIntegerEnv(120_000, 1_000, 24 * 60 * 60_000),
  PRE_DEADLINE_POLL_MS: boundedIntegerEnv(5 * 60_000, 1_000, 24 * 60 * 60_000),
  GW_REVIEW_POLL_MS: boundedIntegerEnv(10 * 60_000, 1_000, 24 * 60 * 60_000),
  GW_REVIEW_FINALIZATION_POLL_MS: boundedIntegerEnv(2 * 60_000, 1_000, 24 * 60 * 60_000),
  FINALIZED_POLL_MS: boundedIntegerEnv(5 * 60_000, 1_000, 24 * 60 * 60_000),
  // Disabled until automated Understat access is explicitly approved.
  UNDERSTAT_ENABLED: booleanEnv(false),
  UNDERSTAT_BASE_URL: z.string().url().default('https://understat.com'),
  UNDERSTAT_LEAGUE: z.string().min(1).default('EPL'),
  UNDERSTAT_MIN_SEASON: z
    .string()
    .regex(/^\d{4}$/)
    .default('2526'),
  UNDERSTAT_SEASON: z
    .string()
    .regex(/^\d{4}$/)
    .default('2627'),
  UNDERSTAT_TIMEOUT_MS: boundedIntegerEnv(10_000, 1_000, 2 * 60 * 60_000),
  UNDERSTAT_MAX_CONCURRENCY: boundedIntegerEnv(4, 1, 32),
  // Telegram notifications (optional)
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  // Bot notification endpoints (optional)
  TELEGRAM_NOTIFICATION_URL: optionalEnv(z.string().url().optional()),
  WECHAT_NOTIFICATION_URL: optionalEnv(z.string().url().optional()),
  WECHAT_NOTIFICATION_API_TOKEN: optionalEnv(z.string().min(32).optional()),
  // Bug-report screenshot cleanup is a production dependency. The legacy
  // origin is validated only by the one-time storage migration command.
  BUG_REPORT_STORAGE_INTERNAL_URL: optionalEnv(z.string().url().optional()),
  BUG_REPORT_CLEANUP_SECRET: optionalEnv(z.string().min(32).optional()),
  BUG_REPORT_STORAGE_LEGACY_ORIGIN: optionalEnv(z.string().url().optional()),
});

type BugReportScreenshotConfigKeys =
  | 'BUG_REPORT_SCREENSHOT_STORAGE_ENABLED'
  | 'BUG_REPORT_SCREENSHOT_SUPABASE_URL'
  | 'BUG_REPORT_SCREENSHOT_SUPABASE_SECRET_KEY'
  | 'BUG_REPORT_SCREENSHOT_BUCKET'
  | 'BUG_REPORT_SCREENSHOT_RETENTION_DAYS';

type FplRawSnapshotConfigKeys =
  | 'FPL_RAW_SNAPSHOT_STORAGE_ENABLED'
  | 'FPL_RAW_SNAPSHOT_SUPABASE_URL'
  | 'FPL_RAW_SNAPSHOT_SUPABASE_SECRET_KEY'
  | 'FPL_RAW_SNAPSHOT_BUCKET';

type OptionalStorageConfigKeys = BugReportScreenshotConfigKeys | FplRawSnapshotConfigKeys;
type OptionalRuntimeConfigKeys = OptionalStorageConfigKeys | 'PRICE_CHANGE_SINGLE_FLIGHT_ENABLED';

export type AppConfig = Omit<z.infer<typeof EnvSchema>, OptionalRuntimeConfigKeys> &
  Partial<Pick<z.infer<typeof EnvSchema>, OptionalRuntimeConfigKeys>>;

export type RedisEndpointConfig = {
  readonly host: string;
  readonly port: number;
  readonly password?: string;
  readonly db: number;
};

export type AuthConfig = {
  ENABLE_AUTH: boolean;
  DATA_API_KEY_HASHES: readonly string[];
  CORS_ORIGINS: string[];
};

let cachedConfig: AppConfig | null = null;

/** Test-only cache reset for suites that exercise environment preflight variants. */
export function resetConfigForTests(): void {
  cachedConfig = null;
}

/** Lightweight environment check for error/logging bootstrap paths. */
export function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function isBugReportScreenshotStorageConfigured(config: AppConfig): boolean {
  return (
    config.BUG_REPORT_SCREENSHOT_STORAGE_ENABLED === true &&
    Boolean(config.BUG_REPORT_SCREENSHOT_SUPABASE_URL) &&
    Boolean(config.BUG_REPORT_SCREENSHOT_SUPABASE_SECRET_KEY) &&
    config.BUG_REPORT_SCREENSHOT_BUCKET === 'bug-report-screenshots' &&
    config.BUG_REPORT_SCREENSHOT_RETENTION_DAYS === 90
  );
}

export function assertBugReportScreenshotStorageConfigured(config: AppConfig): void {
  if (!isBugReportScreenshotStorageConfigured(config)) {
    throw new Error(
      'Production bug-report screenshot storage must be enabled with the private bucket and 90-day retention',
    );
  }
}

export function isFplRawSnapshotStorageConfigured(config: AppConfig): boolean {
  return (
    config.FPL_RAW_SNAPSHOT_STORAGE_ENABLED === true &&
    Boolean(config.FPL_RAW_SNAPSHOT_SUPABASE_URL) &&
    Boolean(config.FPL_RAW_SNAPSHOT_SUPABASE_SECRET_KEY) &&
    config.FPL_RAW_SNAPSHOT_BUCKET === 'fpl-raw-snapshots'
  );
}

export function assertFplRawSnapshotStorageConfigured(config: AppConfig): void {
  if (!isFplRawSnapshotStorageConfigured(config)) {
    throw new Error(
      'Production FPL raw snapshot storage must be enabled with the private fpl-raw-snapshots bucket',
    );
  }
}

function endpointIdentity(endpoint: RedisEndpointConfig): string {
  return `${endpoint.host.trim().toLowerCase()}:${endpoint.port}/${endpoint.db}`;
}

export function resolveCacheRedisConfig(config: AppConfig): RedisEndpointConfig {
  return {
    host: config.CACHE_REDIS_HOST,
    port: config.CACHE_REDIS_PORT,
    password: config.CACHE_REDIS_PASSWORD,
    db: config.CACHE_REDIS_DB,
  };
}

export function resolveQueueRedisConfig(config: AppConfig): RedisEndpointConfig {
  return {
    host: config.QUEUE_REDIS_HOST,
    port: config.QUEUE_REDIS_PORT,
    password: config.QUEUE_REDIS_PASSWORD,
    db: config.QUEUE_REDIS_DB,
  };
}

export function assertRedisEndpointsSeparated(config: AppConfig): void {
  const cache = resolveCacheRedisConfig(config);
  const queue = resolveQueueRedisConfig(config);
  if (endpointIdentity(cache) === endpointIdentity(queue)) {
    throw new Error(
      'CACHE_REDIS_* and QUEUE_REDIS_* must resolve to different host/port/database endpoints',
    );
  }

  if (config.NODE_ENV === 'production') {
    const required = [
      'CACHE_REDIS_HOST',
      'CACHE_REDIS_PORT',
      'CACHE_REDIS_DB',
      'QUEUE_REDIS_HOST',
      'QUEUE_REDIS_PORT',
      'QUEUE_REDIS_DB',
    ] as const;
    const missing = required.filter((key) => !process.env[key]?.trim());
    if (missing.length > 0) {
      throw new Error(`Production Redis configuration must be explicit: ${missing.join(', ')}`);
    }
  }
}

export function getConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  try {
    const parsed = EnvSchema.parse(process.env);
    assertRedisEndpointsSeparated(parsed);

    if (parsed.NODE_ENV === 'production' && !parsed.ENABLE_AUTH) {
      throw new Error('ENABLE_AUTH must be true in production');
    }

    if (parsed.NODE_ENV === 'production') {
      assertBugReportScreenshotStorageConfigured(parsed);
      assertFplRawSnapshotStorageConfigured(parsed);
    }

    if (
      parsed.FRESHNESS_CONSUMER_PROBES_ENABLED &&
      (!parsed.DATA_GOVERNANCE_WEB_URL || !parsed.DATA_GOVERNANCE_PROBE_TOKEN)
    ) {
      throw new Error(
        'DATA_GOVERNANCE_WEB_URL and DATA_GOVERNANCE_PROBE_TOKEN are required when freshness consumer probes are enabled',
      );
    }

    if (
      parsed.NODE_ENV === 'production' &&
      parsed.BUG_REPORT_SCREENSHOT_STORAGE_ENABLED &&
      (!parsed.BUG_REPORT_SCREENSHOT_SUPABASE_URL ||
        !parsed.BUG_REPORT_SCREENSHOT_SUPABASE_SECRET_KEY)
    ) {
      throw new Error(
        'BUG_REPORT_SCREENSHOT_SUPABASE_URL and BUG_REPORT_SCREENSHOT_SUPABASE_SECRET_KEY are required when screenshot storage is enabled',
      );
    }

    if (
      parsed.NODE_ENV === 'production' &&
      parsed.WECHAT_NOTIFICATION_URL &&
      !parsed.WECHAT_NOTIFICATION_API_TOKEN
    ) {
      throw new Error(
        'WECHAT_NOTIFICATION_API_TOKEN is required when WECHAT_NOTIFICATION_URL is configured in production',
      );
    }

    if (
      parsed.NODE_ENV === 'production' &&
      (!parsed.BUG_REPORT_STORAGE_INTERNAL_URL || !parsed.BUG_REPORT_CLEANUP_SECRET)
    ) {
      throw new Error(
        'BUG_REPORT_STORAGE_INTERNAL_URL and BUG_REPORT_CLEANUP_SECRET are required in production',
      );
    }

    if (parsed.FPL_ADMISSION_LEASE_MS < parsed.FPL_REQUEST_DEADLINE_MS + 5_000) {
      throw new Error('FPL_ADMISSION_LEASE_MS must exceed the FPL request deadline by 5 seconds');
    }

    if (parsed.FPL_RETRY_MAX_DELAY_MS < parsed.FPL_RETRY_BASE_DELAY_MS) {
      throw new Error('FPL_RETRY_MAX_DELAY_MS must be greater than or equal to the base delay');
    }

    const retrySchedule = parsed.PICKS_RETRY_SCHEDULE_MS.split(',').map((value) => value.trim());
    if (
      retrySchedule.length === 0 ||
      retrySchedule.some((value) => !/^\d+$/.test(value) || Number(value) > 24 * 60 * 60_000)
    ) {
      throw new Error(
        'PICKS_RETRY_SCHEDULE_MS must contain integer delays between 0 and 86400000ms',
      );
    }

    resolveAuthConfig(parsed);

    if (Number(parsed.UNDERSTAT_MIN_SEASON) > Number(parsed.UNDERSTAT_SEASON)) {
      throw new Error('UNDERSTAT_MIN_SEASON cannot be newer than UNDERSTAT_SEASON');
    }

    cachedConfig = parsed;
    logInfo('Environment validated', {
      port: parsed.PORT,
      databasePoolMax: parsed.DATABASE_POOL_MAX,
      cacheRedisHost: parsed.CACHE_REDIS_HOST,
      cacheRedisPort: parsed.CACHE_REDIS_PORT,
      cacheRedisDb: parsed.CACHE_REDIS_DB,
      queueRedisHost: parsed.QUEUE_REDIS_HOST,
      queueRedisPort: parsed.QUEUE_REDIS_PORT,
      queueRedisDb: parsed.QUEUE_REDIS_DB,
    });
    return parsed;
  } catch (error) {
    if (error instanceof z.ZodError) {
      logError('Environment validation failed', error.format());
    } else {
      logError('Environment validation error', error);
    }
    throw error;
  }
}

// CLI-friendly validator
export function validateEnvForCli(): { ok: boolean; errors?: unknown } {
  try {
    const conf = getConfig();
    resolveAuthConfig(conf);
    if (conf.NODE_ENV === 'production') {
      assertBugReportScreenshotStorageConfigured(conf);
      assertFplRawSnapshotStorageConfigured(conf);
    }
    logInfo('[env] OK', {
      PORT: conf.PORT,
      DATABASE_URL: conf.DATABASE_URL ? 'set' : 'missing',
      DATABASE_POOL_MAX: conf.DATABASE_POOL_MAX,
      CACHE_REDIS: `${conf.CACHE_REDIS_HOST}:${conf.CACHE_REDIS_PORT}/${conf.CACHE_REDIS_DB}`,
      QUEUE_REDIS: `${conf.QUEUE_REDIS_HOST}:${conf.QUEUE_REDIS_PORT}/${conf.QUEUE_REDIS_DB}`,
    });
    return { ok: true };
  } catch (error) {
    logError('[env] FAILED', error);
    return { ok: false, errors: error };
  }
}

function resolveAuthConfig(parsed: AppConfig): AuthConfig {
  const enableAuth = parsed.ENABLE_AUTH ?? parsed.NODE_ENV === 'production';
  const keyHashes = (parsed.DATA_API_KEY_HASHES ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  const invalidHash = keyHashes.find((value) => !/^[a-f0-9]{64}$/.test(value));
  if (invalidHash) {
    throw new Error('DATA_API_KEY_HASHES must contain comma-separated SHA-256 hex digests');
  }

  if (!enableAuth) {
    return {
      ENABLE_AUTH: false,
      DATA_API_KEY_HASHES: keyHashes,
      CORS_ORIGINS: parseCorsOrigins(parsed.CORS_ORIGINS),
    };
  }

  if (keyHashes.length === 0) {
    throw new Error('DATA_API_KEY_HASHES requires at least one digest when ENABLE_AUTH=true');
  }

  return {
    ENABLE_AUTH: true,
    DATA_API_KEY_HASHES: keyHashes,
    CORS_ORIGINS: parseCorsOrigins(parsed.CORS_ORIGINS),
  };
}

function parseCorsOrigins(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function getAuthConfig(): AuthConfig {
  const parsed = getConfig();
  return resolveAuthConfig(parsed);
}
