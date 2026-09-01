import { databaseSingleton } from '../src/db/singleton';
import {
  getTournamentReviewV2OperationalStatus,
  processTournamentReviewObligations,
} from '../src/services/tournament-review-publication.service';
import { seasonRepository } from '../src/repositories/seasons';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_BATCHES = 10_000;

export type TournamentReviewBackfillArguments = Readonly<{
  season: string;
  batchSize: number;
  maxBatches: number;
}>;

function usage(): never {
  throw new Error(
    'usage: bun scripts/backfill-tournament-review-v2.ts --season YYYY [--batch-size N] [--max-batches N]',
  );
}

export function parseBackfillArguments(argv: readonly string[]): TournamentReviewBackfillArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) usage();
    const separator = token.indexOf('=');
    if (separator > 2) {
      values.set(token.slice(2, separator), token.slice(separator + 1));
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) usage();
    values.set(key, value);
    index += 1;
  }
  const season = values.get('season') ?? '';
  if (!/^\d{4}$/.test(season)) throw new Error('--season must be a four-digit season code');
  const batchSize = Number(values.get('batch-size') ?? DEFAULT_BATCH_SIZE);
  const maxBatches = Number(values.get('max-batches') ?? DEFAULT_MAX_BATCHES);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error('--batch-size must be an integer from 1 to 100');
  }
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > DEFAULT_MAX_BATCHES) {
    throw new Error(`--max-batches must be an integer from 1 to ${DEFAULT_MAX_BATCHES}`);
  }
  return { season, batchSize, maxBatches };
}

export function assertBackfillAuthorization(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.MY_TOURNAMENT_REVIEW_BACKFILL_CONFIRM !== 'YES') {
    throw new Error(
      'V2.1 review backfill refused: set MY_TOURNAMENT_REVIEW_BACKFILL_CONFIRM=YES for this exact command',
    );
  }
}

export async function runTournamentReviewBackfill(
  args: TournamentReviewBackfillArguments,
): Promise<Record<string, unknown>> {
  assertBackfillAuthorization();
  const season = await seasonRepository.requireByCode(args.season);
  const currentSeason = await seasonRepository.findCurrent();
  if (!season.isCurrent || season.seasonId !== currentSeason.seasonId) {
    throw new Error(
      `V2.1 review backfill refused: --season ${args.season} is not the current FPL season`,
    );
  }
  let batches = 0;
  let reconciled = 0;
  let claimed = 0;
  let published = 0;
  let failed = 0;

  while (batches < args.maxBatches) {
    batches += 1;
    const result = await processTournamentReviewObligations(season, {
      limit: args.batchSize,
    });
    reconciled += result.reconciled;
    claimed += result.claimed;
    published += result.published;
    failed += result.failed;
    if (result.claimed === 0) break;
  }

  const status = await getTournamentReviewV2OperationalStatus(season);
  const counts = status.stateCounts;
  const incoherent = status.publication.readyWithIncoherentHead;
  const complete =
    counts.pending === 0 &&
    counts.waitingSource === 0 &&
    counts.processing === 0 &&
    counts.degraded === 0 &&
    counts.ready === status.eligibleCount &&
    incoherent === 0 &&
    status.publication.readyWithIncompleteChunks === 0;
  if (!complete) {
    throw new Error(
      `V2.1 review backfill incomplete: eligible=${status.eligibleCount} ready=${counts.ready} pending=${counts.pending} waitingSource=${counts.waitingSource} processing=${counts.processing} degraded=${counts.degraded} incoherent=${incoherent} incompleteChunks=${status.publication.readyWithIncompleteChunks}`,
    );
  }
  return {
    contractVersion: 'my-tournament-review-v2.1',
    metricVersion: 'settled-review-v2',
    season: args.season,
    batches,
    batchSize: args.batchSize,
    reconciled,
    claimed,
    published,
    failed,
    status,
  };
}

if (import.meta.main) {
  try {
    const args = parseBackfillArguments(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(await runTournamentReviewBackfill(args), null, 2)}\n`);
  } finally {
    await databaseSingleton.disconnect();
  }
}
