import * as path from 'path';

import * as schema from '@app/schemas/tables/index.schema';
import * as dotenv from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL environment variable is not set.');
}

const client = postgres(databaseUrl, { prepare: false });

export const db = drizzle(client, { schema, casing: 'snake_case' });
