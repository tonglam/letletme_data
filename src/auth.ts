import { apiKey } from '@better-auth/api-key';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as authSchema from './db/schemas/auth.schema';
import { getAuthConfig } from './utils/config';

function createAuthDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for Better Auth');
  }

  const client = postgres(databaseUrl, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  return drizzle(client, { schema: authSchema });
}

const authDb = createAuthDatabase();
const { BETTER_AUTH_SECRET, BETTER_AUTH_URL } = getAuthConfig();

export const auth = betterAuth({
  secret: BETTER_AUTH_SECRET,
  baseURL: BETTER_AUTH_URL,
  database: drizzleAdapter(authDb, {
    provider: 'pg',
    schema: authSchema,
  }),
  emailAndPassword: {
    enabled: false,
  },
  plugins: [
    apiKey({
      defaultPrefix: 'llm_',
      rateLimit: {
        enabled: true,
        timeWindow: 60_000,
        maxRequests: 100,
      },
    }),
  ],
});

export type Auth = typeof auth;
