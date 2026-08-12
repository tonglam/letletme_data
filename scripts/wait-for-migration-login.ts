/* eslint-disable no-console */

const MAX_WAIT_MS = 120_000;
const RETRY_DELAYS_MS = [0, 5_000, 10_000, 20_000, 30_000, 30_000, 25_000] as const;

export type MigrationProbeFailure = 'authentication' | 'transient' | 'configuration';

export function classifyMigrationProbeFailure(output: string): MigrationProbeFailure {
  if (/28P01|password authentication failed|invalid authorization specification/i.test(output)) {
    return 'authentication';
  }
  if (
    /ECIRCUITBREAKER|CONNECT_TIMEOUT|ETIMEDOUT|ECONN(?:RESET|REFUSED|ABORTED)|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|connection terminated unexpectedly|server closed the connection unexpectedly|cannot connect now|remaining connection slots|timeout expired/i.test(
      output,
    )
  ) {
    return 'transient';
  }
  return 'configuration';
}

async function delay(milliseconds: number): Promise<void> {
  if (milliseconds === 0) return;
  await Bun.sleep(milliseconds);
}

async function runProbe(remainingMs: number): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}> {
  const child = Bun.spawn(['bun', 'scripts/migration-login-contract.ts', '--preflight'], {
    cwd: process.cwd(),
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, remainingMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    throw new Error(
      `Migration LOGIN wait does not accept arguments: ${process.argv.slice(2).join(' ')}`,
    );
  }
  const startedAt = performance.now();
  let attempt = 0;
  for (const retryDelayMs of RETRY_DELAYS_MS) {
    const elapsedBeforeDelay = performance.now() - startedAt;
    if (elapsedBeforeDelay + retryDelayMs >= MAX_WAIT_MS) break;
    await delay(retryDelayMs);
    attempt += 1;
    const remainingMs = Math.max(1, MAX_WAIT_MS - (performance.now() - startedAt));
    const result = await runProbe(remainingMs);
    const elapsedMs = Math.round(performance.now() - startedAt);
    if (result.exitCode === 0) {
      process.stdout.write(result.stdout);
      console.log(
        JSON.stringify({
          event: 'migration_login_probe',
          outcome: 'ready',
          attempt,
          elapsedMs,
        }),
      );
      return;
    }
    const failure = result.timedOut
      ? 'transient'
      : classifyMigrationProbeFailure(`${result.stdout}\n${result.stderr}`);
    console.log(
      JSON.stringify({
        event: 'migration_login_probe',
        outcome: 'failed',
        failure,
        attempt,
        elapsedMs,
      }),
    );
    if (failure !== 'transient') {
      throw new Error(`Migration LOGIN probe failed without retry: ${failure}`);
    }
  }
  throw new Error(`Migration LOGIN remained unavailable for ${MAX_WAIT_MS}ms`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[wait-for-migration-login] failed', error);
    process.exitCode = 1;
  });
}
