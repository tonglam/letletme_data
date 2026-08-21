import { z } from 'zod';
import { logError, logInfo } from './logger';

function booleanEnv(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined) return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return value;
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    return value;
  }, z.boolean());
}

function integerEnv(defaultValue: number) {
  return z.coerce.number().int().default(defaultValue);
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
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(5).default(5),
  // Rebuildable Data publications only. Queue/coordination state must never use this client.
  CACHE_REDIS_HOST: z.string().default('localhost'),
  CACHE_REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
  CACHE_REDIS_PASSWORD: z.string().optional(),
  CACHE_REDIS_DB: z.coerce.number().int().min(0).default(0),
  // BullMQ and all worker coordination. Defaults remain isolated for local development/tests.
  QUEUE_REDIS_HOST: z.string().default('localhost'),
  QUEUE_REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
  QUEUE_REDIS_PASSWORD: z.string().optional(),
  QUEUE_REDIS_DB: z.coerce.number().int().min(0).default(1),
  // Server
  PORT: z.coerce.number().default(3000),
  WORKER_HEARTBEAT_PATH: z.string().optional(),
  WORKER_HEARTBEAT_INTERVAL_MS: integerEnv(30_000),
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
  BUG_REPORT_SCREENSHOT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  // HTTP mutation rate limit (fixed window per client IP; 0 disables)
  RATE_LIMIT_MUTATIONS_PER_MINUTE: z.coerce.number().int().min(0).default(60),
  DATA_SYNC_ATTEMPT_REPORTING_ENABLED: booleanEnv(true),
  TOURNAMENT_OFFICIAL_SYNC_DEFAULT_ENABLED: booleanEnv(false),
  FPL_MAX_INFLIGHT: z.coerce.number().int().min(1).max(32).default(5),
  FPL_REQUESTS_PER_SECOND: z.coerce.number().int().min(1).max(20).default(4),
  FPL_BULK_MAX_INFLIGHT_DURING_LIVE: z.coerce.number().int().min(1).max(32).default(3),
  FPL_ADMISSION_LEASE_MS: integerEnv(45_000),
  FPL_REQUEST_TIMEOUT_MS: integerEnv(10_000),
  FPL_REQUEST_DEADLINE_MS: integerEnv(40_000),
  FPL_RETRY_BASE_DELAY_MS: integerEnv(500),
  FPL_RETRY_MAX_DELAY_MS: integerEnv(5_000),
  ENTRY_SYNC_CHUNK_SIZE: integerEnv(500),
  ENTRY_SYNC_CONCURRENCY: integerEnv(5),
  ENTRY_SYNC_THROTTLE_MS: integerEnv(200),
  TOURNAMENT_SETUP_STUCK_CUTOFF_MINUTES: integerEnv(15),
  TOURNAMENT_SETUP_WATCHDOG_INTERVAL_MS: integerEnv(300_000),
  TOURNAMENT_EVENT_LIVE_TIMEOUT_MS: integerEnv(45_000),
  TOURNAMENT_ENTRY_FETCH_TIMEOUT_MS: integerEnv(45_000),
  TOURNAMENT_ENTRY_PERSIST_TIMEOUT_MS: integerEnv(60_000),
  LIVE_POLL_MS: integerEnv(30_000),
  PICKS_FIRST_PROBE_OFFSET_MS: integerEnv(90 * 60_000),
  PICKS_RETRY_SCHEDULE_MS: z.string().default('120000,180000,300000,600000'),
  BETWEEN_FIXTURES_POLL_MS: integerEnv(5 * 60_000),
  DAY_SETTLING_INITIAL_POLL_MS: integerEnv(60_000),
  DAY_SETTLING_STABLE_POLL_MS: integerEnv(5 * 60_000),
  DAY_SETTLING_STABLE_AFTER_MS: integerEnv(10 * 60_000),
  PICKS_PROBE_POLL_MS: integerEnv(120_000),
  PRE_DEADLINE_POLL_MS: integerEnv(5 * 60_000),
  GW_REVIEW_POLL_MS: integerEnv(10 * 60_000),
  GW_REVIEW_FINALIZATION_POLL_MS: integerEnv(2 * 60_000),
  FINALIZED_POLL_MS: integerEnv(5 * 60_000),
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
  UNDERSTAT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  UNDERSTAT_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(4),
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

export type AppConfig = Omit<z.infer<typeof EnvSchema>, BugReportScreenshotConfigKeys> &
  Partial<Pick<z.infer<typeof EnvSchema>, BugReportScreenshotConfigKeys>>;

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
