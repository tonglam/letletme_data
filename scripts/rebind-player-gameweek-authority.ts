import { and, eq, sql } from 'drizzle-orm';

import { databaseSingleton, getDb } from '../src/db/singleton';
import { playerGameweekStatsInFpl } from '../src/db/schemas/index.schema';
import { explicitSeasonRef } from '../src/domain/fpl-season';
import {
  createEventLiveRepository,
  eventLiveRepository,
  type EventLiveRepository,
} from '../src/repositories/event-lives';
import { seasonRepository } from '../src/repositories/seasons';
import { readLivePublicationV2Checkpoint } from '../src/services/live-publication-v2-checkpoint.service';
import { contentHash } from '../src/utils/content-hash';
import type { EventLive } from '../src/domain/event-lives';

type Arguments = Readonly<{ season: string; events: number[]; apply: boolean }>;
type ScopeReport = Readonly<{
  season: string;
  eventId: number;
  publicationId: string;
  generation: number;
  eventLiveSha256: string;
  rowCount: number;
  write: boolean;
}>;

const usage = (): never => {
  throw new Error(
    'usage: bun scripts/rebind-player-gameweek-authority.ts --season YYYY --events 1,2,3 [--apply]',
  );
};

function parseArguments(argv: readonly string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) usage();
    const equals = token.indexOf('=');
    if (equals > 2) values.set(token.slice(2, equals), token.slice(equals + 1));
    else {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) usage();
      values.set(token.slice(2), value);
      index += 1;
    }
  }
  const season = values.get('season') ?? '';
  if (!/^\d{4}$/.test(season)) throw new Error('--season must be a four-digit season code');
  const events = [...new Set((values.get('events') ?? '').split(',').map(Number))].sort(
    (left, right) => left - right,
  );
  if (!events.length || events.some((eventId) => !Number.isSafeInteger(eventId) || eventId <= 0)) {
    throw new Error('--events must contain positive integer event IDs');
  }
  return { season, events, apply: values.has('apply') };
}

const comparable = (row: EventLive) => [
  row.eventId,
  row.elementId,
  row.minutes,
  row.goalsScored,
  row.assists,
  row.cleanSheets,
  row.goalsConceded,
  row.ownGoals,
  row.penaltiesSaved,
  row.penaltiesMissed,
  row.yellowCards,
  row.redCards,
  row.saves,
  row.bonus,
  row.bps,
  row.defensiveContribution ?? 0,
  row.starts,
  row.expectedGoals,
  row.expectedAssists,
  row.expectedGoalInvolvements,
  row.expectedGoalsConceded,
  row.inDreamTeam,
  row.totalPoints,
];

const comparableDb = (row: typeof playerGameweekStatsInFpl.$inferSelect) => [
  row.eventId,
  row.elementId,
  row.minutes,
  row.goalsScored,
  row.assists,
  row.cleanSheets,
  row.goalsConceded,
  row.ownGoals,
  row.penaltiesSaved,
  row.penaltiesMissed,
  row.yellowCards,
  row.redCards,
  row.saves,
  row.bonus,
  row.bps,
  row.defensiveContribution,
  row.starts,
  row.expectedGoals,
  row.expectedAssists,
  row.expectedGoalInvolvements,
  row.expectedGoalsConceded,
  row.inDreamTeam,
  row.totalPoints,
];

function sameValues(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function validateScope(
  season: Awaited<ReturnType<typeof seasonRepository.requireByCode>>,
  seasonRef: ReturnType<typeof explicitSeasonRef>,
  eventId: number,
  repository: EventLiveRepository,
  db?: Parameters<typeof readLivePublicationV2Checkpoint>[2],
): Promise<{
  checkpoint: NonNullable<Awaited<ReturnType<typeof readLivePublicationV2Checkpoint>>>;
  report: ScopeReport;
}> {
  const checkpoint = await readLivePublicationV2Checkpoint(season, eventId, db);
  if (!checkpoint) throw new Error(`event ${eventId}: no complete durable checkpoint`);
  if (
    checkpoint.publication.items.eventLive.count !== checkpoint.eventLives.length ||
    checkpoint.publication.items.eventLive.sha256 !== contentHash(checkpoint.eventLives)
  ) {
    throw new Error(`event ${eventId}: checkpoint event-live hash/count proof failed`);
  }
  const rows = await repository.findByEventId(seasonRef, eventId);
  if (rows.length !== checkpoint.eventLives.length) {
    throw new Error(
      `event ${eventId}: row count ${rows.length} does not match checkpoint ${checkpoint.eventLives.length}`,
    );
  }
  const byPlayer = new Map(rows.map((row) => [row.elementId, row]));
  const expectedBinding = [
    checkpoint.publication.publicationId,
    checkpoint.publication.generation,
    checkpoint.publication.items.eventLive.sha256,
  ];
  for (const expected of checkpoint.eventLives) {
    const actual = byPlayer.get(expected.elementId);
    if (!actual || !sameValues(comparable(expected), comparableDb(actual))) {
      throw new Error(`event ${eventId}: player ${expected.elementId} differs from checkpoint`);
    }
    const binding = [
      actual.publicationId,
      actual.publicationGeneration,
      actual.publicationEventLiveSha256,
    ];
    if (!binding.every((value) => value === null) && !sameValues(binding, expectedBinding)) {
      throw new Error(`event ${eventId}: player ${expected.elementId} has a conflicting binding`);
    }
  }
  return {
    checkpoint,
    report: {
      season: season.seasonCode,
      eventId,
      publicationId: checkpoint.publication.publicationId,
      generation: checkpoint.publication.generation,
      eventLiveSha256: checkpoint.publication.items.eventLive.sha256,
      rowCount: rows.length,
      write: false,
    },
  };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const season = await seasonRepository.requireByCode(args.season);
  const seasonRef = explicitSeasonRef(args.season);
  const db = await getDb();
  const reports: ScopeReport[] = [];

  // Every requested scope is validated before any mutation is allowed. This
  // makes --apply all-or-nothing for the selected season/event range.
  for (const eventId of args.events) {
    const { report } = await validateScope(season, seasonRef, eventId, eventLiveRepository);
    reports.push({ ...report, write: args.apply });
  }

  if (args.apply) {
    await db.transaction(async (tx) => {
      for (const eventId of args.events) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${args.season}:${eventId}`}, 0))`,
        );
      }
      for (const report of reports) {
        const eventId = Number(report.eventId);
        const { checkpoint, report: lockedReport } = await validateScope(
          season,
          seasonRef,
          eventId,
          createEventLiveRepository(tx),
          tx,
        );
        if (
          lockedReport.publicationId !== report.publicationId ||
          lockedReport.generation !== report.generation ||
          lockedReport.eventLiveSha256 !== report.eventLiveSha256 ||
          lockedReport.rowCount !== report.rowCount
        ) {
          throw new Error(`event ${eventId}: checkpoint or rows changed before apply`);
        }
        await tx
          .update(playerGameweekStatsInFpl)
          .set({
            publicationId: checkpoint.publication.publicationId,
            publicationGeneration: checkpoint.publication.generation,
            publicationEventLiveSha256: checkpoint.publication.items.eventLive.sha256,
          })
          .where(
            and(
              eq(playerGameweekStatsInFpl.seasonId, season.seasonId),
              eq(playerGameweekStatsInFpl.eventId, eventId),
            ),
          );
      }
    });
  }
  process.stdout.write(`${JSON.stringify({ ...args, reports }, null, 2)}\n`);
}

if (import.meta.main) {
  try {
    await main();
  } finally {
    await databaseSingleton.disconnect();
  }
}
