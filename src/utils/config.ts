import { z } from 'zod';
import { logError, logInfo } from './logger';

function booleanEnv(defaultValue: boolean) {
  return z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((value) => {
      if (value === undefined) {
        return defaultValue;
      }
      if (typeof value === 'boolean') {
        return value;
      }
      return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
    });
}

function integerEnv(defaultValue: number) {
  return z.coerce.number().int().default(defaultValue);
}

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // API and worker share one Supavisor session-pool login in production. Keep
  // each process bounded so their combined pools leave room for deploy probes.
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(10).default(5),
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
  // HTTP mutation rate limit (fixed window per client IP; 0 disables)
  RATE_LIMIT_MUTATIONS_PER_MINUTE: z.coerce.number().int().min(0).default(60),
  // Mutation conflict guard timing
  TOURNAMENT_OFFICIAL_SYNC_DEFAULT_ENABLED: booleanEnv(false),
  MUTATION_LOCK_TTL_MS: integerEnv(30_000),
  MUTATION_LOCK_WAIT_TIMEOUT_MS: integerEnv(120_000),
  MUTATION_LOCK_RETRY_DELAY_MS: integerEnv(250),
  MUTATION_LOCK_HEARTBEAT_MS: integerEnv(10_000),
  PULSELIVE_COMP_SEASON: z.string().optional(),
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
  TELEGRAM_NOTIFICATION_URL: z.string().url().optional(),
  WECHAT_NOTIFICATION_URL: z.string().url().optional(),
});

export type AppConfig = z.infer<typeof EnvSchema>;

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
