/* eslint-disable no-console */
import postgres from 'postgres';

import {
  assertRuntimeDatabaseTarget,
  assertRuntimeDatabaseUrl,
  assertRuntimePasswordSeparated,
  bootstrapRuntimeLogin,
  parseRuntimeLoginBootstrapArgs,
  requiredEnvironment,
  runtimeLoginContract,
  verifyRuntimeLoginConnection,
} from './runtime-login-contract';

async function main(): Promise<void> {
  const target = parseRuntimeLoginBootstrapArgs(process.argv.slice(2));
  const databaseUrl = requiredEnvironment('DATABASE_URL');
  const runtimeDatabaseUrl = requiredEnvironment('RUNTIME_DATABASE_URL');
  const contract = runtimeLoginContract(target);
  const { password } = assertRuntimeDatabaseUrl(
    runtimeDatabaseUrl,
    contract.login,
    'RUNTIME_DATABASE_URL',
  );
  assertRuntimeDatabaseTarget(databaseUrl, runtimeDatabaseUrl, 'RUNTIME_DATABASE_URL');

  const client = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    await assertRuntimePasswordSeparated(client, runtimeDatabaseUrl, target);
    const credentialMutated = await client.begin((transaction) =>
      bootstrapRuntimeLogin(transaction, target, password),
    );
    await verifyRuntimeLoginConnection(runtimeDatabaseUrl, target, credentialMutated);
    console.log(
      JSON.stringify(
        {
          operation: 'bootstrap-runtime-login',
          target,
          runtimeLogin: contract.login,
          credentialMutated,
          runtimeConnectionVerified: true,
          outcome: credentialMutated ? 'created' : 'verified-existing',
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
    console.error('[bootstrap-runtime-login] failed', error);
    process.exitCode = 1;
  });
}
