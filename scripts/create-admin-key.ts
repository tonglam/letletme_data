import { eq } from 'drizzle-orm';

import { auth } from '../src/auth';
import { user } from '../src/db/schemas/auth.schema';
import { getDb } from '../src/db/singleton';
import { getConfig } from '../src/utils/config';
import { logError, logInfo } from '../src/utils/logger';

type CreateAdminKeyOptions = {
  email: string;
  name: string;
  keyName: string;
};

function parseArgs(argv: string[]): CreateAdminKeyOptions {
  const emailArg = argv.find((arg) => arg.startsWith('--email='));
  const nameArg = argv.find((arg) => arg.startsWith('--name='));
  const keyNameArg = argv.find((arg) => arg.startsWith('--key-name='));

  return {
    email: emailArg?.split('=')[1] ?? 'admin@letletme.local',
    name: nameArg?.split('=')[1] ?? 'Letletme Admin',
    keyName: keyNameArg?.split('=')[1] ?? 'admin-bootstrap',
  };
}

function assertEnvironment() {
  const config = getConfig();
  if (!config.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to create an admin API key');
  }
  if (!config.BETTER_AUTH_SECRET || config.BETTER_AUTH_SECRET.length < 32) {
    throw new Error('BETTER_AUTH_SECRET (min 32 chars) is required to create an admin API key');
  }
  if (config.NODE_ENV === 'production' && !process.argv.includes('--allow-prod')) {
    throw new Error(
      'Refusing to create an admin key in production without --allow-prod. This command prints a secret to stdout.',
    );
  }
}

async function findUserIdByEmail(email: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  return rows[0]?.id ?? null;
}

async function ensureAdminUser(options: CreateAdminKeyOptions): Promise<string> {
  const existingUserId = await findUserIdByEmail(options.email);
  if (existingUserId) {
    logInfo('Admin user already exists', { email: options.email, userId: existingUserId });
    return existingUserId;
  }

  const db = await getDb();
  const userId = crypto.randomUUID();
  const now = new Date();

  await db.insert(user).values({
    id: userId,
    name: options.name,
    email: options.email,
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
  });

  logInfo('Admin user created', { email: options.email, userId });
  return userId;
}

async function main() {
  assertEnvironment();
  const options = parseArgs(process.argv.slice(2));
  const userId = await ensureAdminUser(options);

  const created = await auth.api.createApiKey({
    body: {
      name: options.keyName,
      userId,
    },
  });

  if (!created.key) {
    throw new Error('Better Auth did not return an API key');
  }

  logInfo('Admin API key created', {
    keyName: options.keyName,
    userId,
    prefix: created.prefix,
    start: created.start,
  });

  console.log('\nStore this key securely — it will not be shown again.');
  console.log('DO NOT paste it into chat, logs, screenshots, or tickets.\n');
  console.log(created.key);
  console.log('');
}

main().catch((error) => {
  logError('Failed to create admin API key', error);
  process.exit(1);
});
