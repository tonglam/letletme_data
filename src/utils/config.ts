import { z } from 'zod';
import { logError, logInfo, logWarn } from './logger';

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
  // Optional Supabase hints (DB provider)
  SUPABASE_URL: z.string().optional(),
  SUPABASE_KEY: z.string().optional(),
  PULSELIVE_COMP_SEASON: z.string().optional(),
});

export type AppConfig = z.infer<typeof EnvSchema>;

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
    // eslint-disable-next-line no-console
    console.log('[env] OK', {
      PORT: conf.PORT,
      DATABASE_URL: conf.DATABASE_URL ? 'set' : 'missing',
      REDIS: `${conf.REDIS_HOST}:${conf.REDIS_PORT}`,
    });
    return { ok: true };
  } catch (error) {
    console.error('[env] FAILED', error);
    return { ok: false, errors: error };
  }
}
