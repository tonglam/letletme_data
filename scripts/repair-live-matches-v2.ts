import { databaseSingleton } from '../src/db/singleton';
import {
  LIVE_MATCHES_V2_REPAIR_CONFIRMATION,
  parseLiveMatchesV2RepairRequest,
  runLiveMatchesV2Repair,
  type LiveMatchesV2RepairRequest,
} from '../src/services/live-match-v2-repair.service';
import { redisSingleton } from '../src/cache/singleton';

const CLI_FLAGS = new Set(['action', 'season', 'event-id', 'kind', 'reason']);

function usage(): never {
  throw new Error(
    'usage: bun scripts/repair-live-matches-v2.ts --action inspect|promote-previous|rebuild-current|replay-checkpoint --season YYYY --event-id N [--kind desk|detail] [--reason text]',
  );
}

function parseCliArguments(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): LiveMatchesV2RepairRequest {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) usage();
    const separator = token.indexOf('=');
    const key = separator > 2 ? token.slice(2, separator) : token.slice(2);
    if (!CLI_FLAGS.has(key) || values.has(key)) usage();
    if (separator > 2) {
      values.set(key, token.slice(separator + 1));
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) usage();
    values.set(key, value);
    index += 1;
  }

  const action = values.get('action');
  const season = values.get('season');
  const eventIdValue = values.get('event-id');
  if (!action || !season || !eventIdValue) usage();

  const eventId = Number(eventIdValue);
  return parseLiveMatchesV2RepairRequest({
    action,
    season,
    eventId,
    kind: values.get('kind') ?? null,
    reason: values.get('reason') ?? null,
    confirmation:
      environment.LIVE_MATCHES_REPAIR_CONFIRM === LIVE_MATCHES_V2_REPAIR_CONFIRMATION
        ? LIVE_MATCHES_V2_REPAIR_CONFIRMATION
        : null,
  });
}

export const parseLiveMatchesV2RepairCliArguments = parseCliArguments;

async function main(): Promise<void> {
  const request = parseCliArguments(process.argv.slice(2));
  const result = await runLiveMatchesV2Repair(request);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([redisSingleton.disconnect(), databaseSingleton.disconnect()]);
  }
}
