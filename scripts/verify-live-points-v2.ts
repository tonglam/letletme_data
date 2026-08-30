import { and, eq } from 'drizzle-orm';

import {
  type EntryLivePublicationRead,
  readEntryLiveInputV2,
  readLivePublicationV2Pointer,
  type LivePublicationRead,
} from '../src/cache/live-publication-v2';
import { redisSingleton } from '../src/cache/singleton';
import { databaseSingleton, getDb } from '../src/db/singleton';
import { entryEventPickHeadsInCompetition } from '../src/db/schemas/index.schema';
import { seasonRepository } from '../src/repositories/seasons';
import { readLivePublicationV2Checkpoint } from '../src/services/live-publication-v2-checkpoint.service';

type VerifyArguments = {
  readonly season: string;
  readonly eventId: number;
  readonly entryId: number | null;
};

function usage(): never {
  throw new Error(
    'usage: bun scripts/verify-live-points-v2.ts --season YYYY --event-id N [--entry-id N]',
  );
}

export function parseVerifyArguments(argv: readonly string[]): VerifyArguments {
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
    if (!value || value.startsWith('--') || values.has(key)) usage();
    values.set(key, value);
    index += 1;
  }

  const season = values.get('season') ?? '';
  if (!/^\d{4}$/.test(season)) throw new Error('--season must be a four-digit season code');
  const eventId = Number(values.get('event-id'));
  const entryIdValue = values.get('entry-id');
  const entryId = entryIdValue === undefined ? null : Number(entryIdValue);
  if (!Number.isSafeInteger(eventId) || eventId <= 0)
    throw new Error('--event-id must be a positive integer');
  if (entryId !== null && (!Number.isSafeInteger(entryId) || entryId <= 0))
    throw new Error('--entry-id must be a positive integer');
  return { season, eventId, entryId };
}

function publicationSummary(read: LivePublicationRead | null) {
  if (!read) return null;
  return {
    servedFrom: read.servedFrom,
    publicationId: read.publication.publicationId,
    generation: read.publication.generation,
    contractVersion: read.publication.contractVersion,
    season: read.publication.season,
    eventId: read.publication.eventId,
    state: read.publication.state,
    sourceCheckedAt: read.publication.sourceCheckedAt,
    publishedAt: read.publication.publishedAt,
    checkpointedAt: read.publication.checkpointedAt,
    eventLiveCount: read.eventLives.length,
    fixtureCount: read.fixtures.length,
    eventLiveSha256: read.publication.items.eventLive.sha256,
    fixturesSha256: read.publication.items.fixtures.sha256,
  };
}

function entrySummary(read: EntryLivePublicationRead | null) {
  if (!read) return null;
  return {
    servedFrom: read.servedFrom,
    publicationId: read.publication.publicationId,
    generation: read.publication.generation,
    contractVersion: read.publication.contractVersion,
    season: read.publication.season,
    eventId: read.publication.eventId,
    entryId: read.publication.entryId,
    state: read.publication.state,
    sourceCheckedAt: read.publication.sourceCheckedAt,
    publishedAt: read.publication.publishedAt,
    checkpointedAt: read.publication.checkpointedAt,
    picksCount: read.input.picksBase.picks.length,
    uniqueElements: new Set(read.input.picksBase.picks.map((pick) => pick.element)).size,
    picksBaseRevision: read.input.picksBase.revision,
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await operation(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function main(): Promise<void> {
  const args = parseVerifyArguments(process.argv.slice(2));
  const season = await seasonRepository.requireByCode(args.season);
  const [redis, db] = await Promise.all([redisSingleton.getClient(), getDb()]);
  const scope = { season: args.season, eventId: args.eventId } as const;

  try {
    const headRows = await db
      .select({
        entryId: entryEventPickHeadsInCompetition.entryId,
        publicationId: entryEventPickHeadsInCompetition.publicationId,
        generation: entryEventPickHeadsInCompetition.generation,
        picksBaseRevision: entryEventPickHeadsInCompetition.picksBaseRevision,
        contentSha256: entryEventPickHeadsInCompetition.contentSha256,
        rowCount: entryEventPickHeadsInCompetition.rowCount,
        state: entryEventPickHeadsInCompetition.state,
      })
      .from(entryEventPickHeadsInCompetition)
      .where(
        and(
          eq(entryEventPickHeadsInCompetition.seasonId, season.seasonId),
          eq(entryEventPickHeadsInCompetition.eventId, args.eventId),
        ),
      )
      .orderBy(entryEventPickHeadsInCompetition.entryId);
    const headByEntry = new Map(headRows.map((head) => [head.entryId, head] as const));
    const completeEntryIds = headRows
      .filter((head) => head.rowCount === 15 && head.state === 'COMPLETE')
      .map((head) => head.entryId);
    const entryIds = args.entryId === null ? completeEntryIds : [args.entryId];
    if (entryIds.length === 0)
      throw new Error('No complete V2 entry pick head exists for this scope');

    const [active, previous, checkpoint, entryResults] = await Promise.all([
      readLivePublicationV2Pointer(scope, 'active', redis),
      readLivePublicationV2Pointer(scope, 'previous', redis),
      readLivePublicationV2Checkpoint(season, args.eventId),
      mapWithConcurrency(entryIds, 32, async (entryId) => {
        const entry = await readEntryLiveInputV2({ ...scope, entryId }, redis);
        const head = headByEntry.get(entryId) ?? null;
        const failures: string[] = [];

        if (!entry) failures.push('REDIS_ENTRY_INPUT_MISSING_OR_INVALID');
        if (entry && entry.servedFrom !== 'REDIS_CURRENT')
          failures.push('REDIS_ENTRY_INPUT_NOT_CURRENT');
        if (entry && entry.input.picksBase.picks.length !== 15)
          failures.push('REDIS_ENTRY_INPUT_NOT_EXACTLY_15');
        if (entry && new Set(entry.input.picksBase.picks.map((pick) => pick.element)).size !== 15)
          failures.push('REDIS_ENTRY_INPUT_ELEMENTS_NOT_UNIQUE');
        if (!head) failures.push('POSTGRES_ENTRY_PICK_HEAD_MISSING');
        if (head && (head.rowCount !== 15 || head.state !== 'COMPLETE'))
          failures.push('POSTGRES_ENTRY_PICK_HEAD_INCOMPLETE');
        if (entry && head && head.publicationId !== entry.publication.publicationId)
          failures.push('POSTGRES_ENTRY_HEAD_PUBLICATION_MISMATCH');
        if (entry && head && head.generation !== entry.publication.generation)
          failures.push('POSTGRES_ENTRY_HEAD_GENERATION_MISMATCH');
        if (entry && head && head.picksBaseRevision !== entry.input.picksBase.revision)
          failures.push('POSTGRES_ENTRY_HEAD_REVISION_MISMATCH');

        return {
          entryId,
          failures,
          redis: { entryInput: entrySummary(entry) },
          postgres: { entryPickHead: head },
        };
      }),
    ]);

    const globalFailures: string[] = [];

    if (!active) globalFailures.push('REDIS_GLOBAL_CURRENT_MISSING_OR_INVALID');
    if (!checkpoint) globalFailures.push('POSTGRES_GLOBAL_CHECKPOINT_MISSING_OR_INVALID');
    if (active && checkpoint) {
      if (checkpoint.publication.publicationId !== active.publication.publicationId)
        globalFailures.push('POSTGRES_GLOBAL_CHECKPOINT_PUBLICATION_MISMATCH');
      if (checkpoint.publication.generation !== active.publication.generation)
        globalFailures.push('POSTGRES_GLOBAL_CHECKPOINT_GENERATION_MISMATCH');
    }
    const failures = [
      ...globalFailures,
      ...entryResults.flatMap((entryResult) =>
        entryResult.failures.map((failure) => `ENTRY_${entryResult.entryId}:${failure}`),
      ),
    ];
    const failedEntryIds = entryResults
      .filter((entryResult) => entryResult.failures.length > 0)
      .map((entryResult) => entryResult.entryId);

    const result = {
      operation: 'verify-live-points-v2',
      write: false,
      season: args.season,
      eventId: args.eventId,
      entryId: args.entryId,
      entryCount: entryIds.length,
      ok: failures.length === 0,
      failures,
      failedEntryIds,
      redis: {
        globalCurrent: publicationSummary(active),
        globalPrevious: publicationSummary(previous),
      },
      postgres: {
        globalCheckpoint: publicationSummary(checkpoint),
      },
      entryResults,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await Promise.allSettled([redisSingleton.disconnect(), databaseSingleton.disconnect()]);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[verify-live-points-v2] failed', error);
    process.exitCode = 1;
  });
}
