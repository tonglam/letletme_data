import { z } from 'zod';
import { logError, logInfo, logWarn } from './logger';

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
  // Redis
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().optional().default(0),
  // Queue Redis (falls back to cache Redis)
  QUEUE_REDIS_HOST: z.string().optional(),
  QUEUE_REDIS_PORT: z.coerce.number().optional(),
  QUEUE_REDIS_PASSWORD: z.string().optional(),
  QUEUE_REDIS_DB: z.coerce.number().optional(),
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
  // Mutation conflict guard + tiered mutation queues (feature flags)
  ENABLE_TIERED_MUTATION_QUEUES: booleanEnv(false),
  ENABLE_MUTATION_CONFLICT_GUARD: booleanEnv(true),
  TRANSFER_SYNC_MODE: z.enum(['latest', 'all']).default('latest'),
  MUTATION_LOCK_TTL_MS: integerEnv(30_000),
  MUTATION_LOCK_WAIT_TIMEOUT_MS: integerEnv(120_000),
  MUTATION_LOCK_RETRY_DELAY_MS: integerEnv(250),
  MUTATION_LOCK_HEARTBEAT_MS: integerEnv(10_000),
  // Optional Supabase hints (DB provider)
  SUPABASE_URL: z.string().optional(),
  SUPABASE_KEY: z.string().optional(),
  PULSELIVE_COMP_SEASON: z.string().optional(),
  // Telegram notifications (optional)
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  // Bot notification endpoints (optional)
  TELEGRAM_NOTIFICATION_URL: z.string().url().optional(),
  WECHAT_NOTIFICATION_URL: z.string().url().optional(),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export type AuthConfig = {
  ENABLE_AUTH: boolean;
  DATA_API_KEY_HASHES: readonly string[];
  CORS_ORIGINS: string[];
};

let cachedConfig: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  try {
    const parsed = EnvSchema.parse(process.env);

    // Helpful warnings (non-fatal)
    if (!parsed.SUPABASE_URL || !parsed.SUPABASE_KEY) {
      logWarn('Supabase env not fully set (optional)');
    }

    cachedConfig = parsed;
    logInfo('Environment validated', {
      port: parsed.PORT,
      redisHost: parsed.REDIS_HOST,
      redisPort: parsed.REDIS_PORT,
      queueRedisHost: parsed.QUEUE_REDIS_HOST || parsed.REDIS_HOST,
      queueRedisPort: parsed.QUEUE_REDIS_PORT || parsed.REDIS_PORT,
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
    logInfo('[env] OK', {
      PORT: conf.PORT,
      DATABASE_URL: conf.DATABASE_URL ? 'set' : 'missing',
      REDIS: `${conf.REDIS_HOST}:${conf.REDIS_PORT}`,
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
