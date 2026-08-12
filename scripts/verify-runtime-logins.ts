/* eslint-disable no-console */
import postgres from 'postgres';

import {
  assertRuntimeLoginSnapshot,
  inspectRuntimeLogins,
  requiredEnvironment,
} from './runtime-login-contract';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    throw new Error(`Runtime LOGIN verification does not accept arguments: ${args.join(' ')}`);
  }
  const client = postgres(requiredEnvironment('DATABASE_URL'), { max: 1, prepare: false });
  try {
    const snapshot = await inspectRuntimeLogins(client);
    assertRuntimeLoginSnapshot(snapshot);
    console.log(
      JSON.stringify(
        {
          operation: 'verify-runtime-logins',
          credentialMutated: false,
          roles: snapshot.roles,
          memberships: snapshot.memberships,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[verify-runtime-logins] failed', error);
    process.exitCode = 1;
  });
}
