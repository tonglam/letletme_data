import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { describe, expect, test } from 'bun:test';

import { redisSingleton } from '../../src/cache/singleton';
import { getActiveCacheSeason, resetActiveSeasonMemo } from '../../src/cache/cache-season';
import { fplClient } from '../../src/clients/fpl';
import {
  estimateTournamentSetupRequests,
  type TournamentBackfillWindow,
} from '../../src/domain/tournament';
import { getDbClient } from '../../src/db/singleton';
import { ENTRY_SYNC_DEFAULT_CONCURRENCY } from '../../src/queues/entry-sync.queue';
import { CORE_HISTORY_BATCH_SIZE } from '../../src/repositories/entry-event-results-history';
import { entryEventTransfersRepository } from '../../src/repositories/entry-event-transfers';
import {
  ensureTournamentCoreResults,
  findMissingHistoricalPicks,
  syncTournamentEntryDetails,
  type TournamentCoreSyncPlan,
  type TournamentEntrySyncPlan,
} from '../../src/services/tournament-backfill.service';
import {
  syncEntryTransferHistories,
  syncTournamentEventResultsForEntryIds,
} from '../../src/services/tournament-event-results.service';
import { mockFPLClient, resetMockFPLClient } from './helpers/mock-fpl';

const RUN_BENCHMARK = process.env.RUN_TOURNAMENT_BENCHMARK === '1';

type BenchmarkEndpoint =
  | 'entry_summary'
  | 'entry_history'
  | 'entry_transfers'
  | 'event_live'
  | 'entry_picks';

const BENCHMARK_ENDPOINTS: BenchmarkEndpoint[] = [
  'entry_summary',
  'entry_history',
  'entry_transfers',
  'event_live',
  'entry_picks',
];

type BenchmarkRecord = {
  event: 'tournament_setup_benchmark';
  case: string;
  participantCount: number;
  eventCount: number;
  durationMs: number;
  rssDeltaBytes: number;
  milestoneOrder: string[];
  requestCounts: Record<BenchmarkEndpoint, number>;
  totalRequests: number;
  reusedUnits: {
    entrySnapshots: number;
    coreResults: number;
    picks: number;
    transferHistories: number;
  };
  maxConcurrentRequests: number;
  maxConcurrentByEndpoint: Record<BenchmarkEndpoint, number>;
  standingsPublishedBeforeEnrichmentRequests: boolean;
  coreUpsertBatchLimit: number;
  maxCoreUpsertBatchRows: number;
};

class BenchmarkRequestRecorder {
  readonly requestCounts = Object.fromEntries(
    BENCHMARK_ENDPOINTS.map((endpoint) => [endpoint, 0]),
  ) as Record<BenchmarkEndpoint, number>;
  readonly maxConcurrentByEndpoint = Object.fromEntries(
    BENCHMARK_ENDPOINTS.map((endpoint) => [endpoint, 0]),
  ) as Record<BenchmarkEndpoint, number>;
  readonly timeline: string[] = [];
  private readonly activeByEndpoint = Object.fromEntries(
    BENCHMARK_ENDPOINTS.map((endpoint) => [endpoint, 0]),
  ) as Record<BenchmarkEndpoint, number>;
  private active = 0;
  maxConcurrentRequests = 0;

  milestone(name: string): void {
    this.timeline.push(`milestone:${name}`);
  }

  async request<T>(endpoint: BenchmarkEndpoint, response: () => T): Promise<T> {
    this.requestCounts[endpoint] += 1;
    this.timeline.push(endpoint);
    this.active += 1;
    this.activeByEndpoint[endpoint] += 1;
    this.maxConcurrentRequests = Math.max(this.maxConcurrentRequests, this.active);
    this.maxConcurrentByEndpoint[endpoint] = Math.max(
      this.maxConcurrentByEndpoint[endpoint],
      this.activeByEndpoint[endpoint],
    );
    try {
      // Yield once so the recorder observes the production concurrency bound
      // without introducing a wall-clock benchmark dependency.
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      return response();
    } finally {
      this.active -= 1;
      this.activeByEndpoint[endpoint] -= 1;
    }
  }
}

function benchmarkEntryIds(baseEntryId: number, participantCount: number): number[] {
  return Array.from({ length: participantCount }, (_, index) => baseEntryId + index);
}

function buildHistory(eventCount: number) {
  return {
    current: Array.from({ length: eventCount }, (_, index) => {
      const event = index + 1;
      return {
        event,
        points: 50 + (event % 10),
        total_points: event * 55,
        rank: event * 100,
        overall_rank: event * 1000,
        bank: 5,
        value: 1000,
        event_transfers: 0,
        event_transfers_cost: 0,
        points_on_bench: 4,
      };
    }),
    chips: [],
    past: [],
  };
}

function installBenchmarkFplClient(recorder: BenchmarkRequestRecorder, eventCount: number): void {
  mockFPLClient({
    getEntrySummary: (...args: unknown[]) => {
      const entryId = Number(args[0]);
      return recorder.request('entry_summary', () => ({
        id: entryId,
        name: `Benchmark Team ${entryId}`,
        player_first_name: 'Benchmark',
        player_last_name: 'Manager',
        player_region_name: 'Australia',
        started_event: 1,
        summary_overall_points: eventCount * 55,
        summary_overall_rank: entryId,
        bank: 5,
        value: 1000,
        leagues: { classic: [], h2h: [] },
      }));
    },
    getEntryHistory: () => recorder.request('entry_history', () => buildHistory(eventCount)),
    getEntryTransfers: () => recorder.request('entry_transfers', () => []),
    getEventLive: () => recorder.request('event_live', () => ({ elements: [] })),
    getEntryEventPicks: (...args: unknown[]) => {
      const eventId = Number(args[1]);
      return recorder.request('entry_picks', () => ({
        active_chip: null,
        automatic_subs: [],
        entry_history: {
          event: eventId,
          points: 50 + (eventId % 10),
          total_points: eventId * 55,
          rank: eventId * 100,
          overall_rank: eventId * 1000,
          bank: 5,
          value: 1000,
          event_transfers: 0,
          event_transfers_cost: 0,
          points_on_bench: 4,
        },
        picks: [],
      }));
    },
  });
}

async function prepareBenchmarkInfrastructure(eventCount: number): Promise<string> {
  const sql = await getDbClient();
  const eventIds = Array.from({ length: eventCount }, (_, index) => index + 1);
  await sql`
    INSERT INTO events (id, name, finished, data_checked)
    SELECT event_id, 'Benchmark GW' || event_id, true, true
    FROM unnest(${eventIds}::integer[]) AS event_id
    ON CONFLICT (id) DO NOTHING
  `;

  const redis = await redisSingleton.getClient();
  const existingSeason = await redis.get('Season:active');
  const season = existingSeason && /^\d{4}$/.test(existingSeason) ? existingSeason : '2526';
  await redis.set('Season:active', season);
  resetActiveSeasonMemo();
  return season;
}

async function cleanupBenchmarkEntries(entryIds: number[], season: string): Promise<void> {
  const sql = await getDbClient();
  await sql.begin(async (tx) => {
    await tx`DELETE FROM entry_event_transfers WHERE entry_id = ANY(${entryIds})`;
    await tx`DELETE FROM entry_event_picks WHERE entry_id = ANY(${entryIds})`;
    await tx`DELETE FROM entry_event_results WHERE entry_id = ANY(${entryIds})`;
    await tx`DELETE FROM entry_league_infos WHERE entry_id = ANY(${entryIds})`;
    await tx`DELETE FROM entry_history_infos WHERE entry_id = ANY(${entryIds})`;
    await tx`DELETE FROM entry_infos WHERE id = ANY(${entryIds})`;
  });
  const redis = await redisSingleton.getClient();
  await redis.hdel(`EntryInfo:${season}`, ...entryIds.map(String));
}

async function clearEventLiveCheckpoint(eventId: number): Promise<void> {
  const sql = await getDbClient();
  await sql`DELETE FROM event_lives WHERE event_id = ${eventId}`;
  const redis = await redisSingleton.getClient();
  const keys = await redis.keys(`EventLive:*:${eventId}`);
  if (keys.length > 0) await redis.del(...keys);
}

async function countPersistedPairs(entryIds: number[]) {
  const sql = await getDbClient();
  const rows = await sql<Array<{ results: number; picks: number }>>`
    SELECT
      (SELECT count(*)::int FROM entry_event_results WHERE entry_id = ANY(${entryIds})) AS results,
      (SELECT count(*)::int FROM entry_event_picks WHERE entry_id = ANY(${entryIds})) AS picks
  `;
  return rows[0] ?? { results: 0, picks: 0 };
}

async function runBenchmarkCase({
  caseName,
  entryIds,
  eventCount,
}: {
  caseName: string;
  entryIds: number[];
  eventCount: number;
}): Promise<BenchmarkRecord> {
  const recorder = new BenchmarkRequestRecorder();
  installBenchmarkFplClient(recorder, eventCount);
  const window: TournamentBackfillWindow = { startEventId: 1, endEventId: eventCount };
  const startedAt = performance.now();
  const rssBefore = process.memoryUsage().rss;
  let entryPlan: TournamentEntrySyncPlan = {
    totalEntries: entryIds.length,
    requestedEntries: 0,
    reusedEntries: 0,
  };
  let corePlan: TournamentCoreSyncPlan = {
    totalPairs: entryIds.length * eventCount,
    missingPairs: 0,
    reusedPairs: 0,
  };
  const season = await getActiveCacheSeason();

  try {
    const entryIssues = await syncTournamentEntryDetails(entryIds, {
      targetEventId: eventCount,
      onPlan: (plan) => {
        entryPlan = plan;
      },
    });
    expect(entryIssues).toEqual([]);
    recorder.milestone('entry_snapshots_synced');

    await ensureTournamentCoreResults(entryIds, window, undefined, (plan) => {
      corePlan = plan;
    });
    recorder.milestone('core_results_ready');
    recorder.milestone('standings_published');

    const missingPicks = await findMissingHistoricalPicks(entryIds, window);
    const missingPickPairs = [...missingPicks.values()].reduce(
      (total, missingEntryIds) => total + missingEntryIds.length,
      0,
    );
    const transferEntryIds = await entryEventTransfersRepository.findEntryIdsNeedingSync(
      entryIds,
      eventCount,
      season,
    );
    recorder.milestone('enrichment_started');

    const transferResult = await syncEntryTransferHistories(transferEntryIds, eventCount, {
      concurrency: ENTRY_SYNC_DEFAULT_CONCURRENCY,
      season,
    });
    expect(transferResult.errors).toBe(0);

    for (const [eventId, missingEntryIds] of missingPicks) {
      const live = await fplClient.getEventLive(eventId);
      await syncTournamentEventResultsForEntryIds(missingEntryIds, eventId, {
        concurrency: ENTRY_SYNC_DEFAULT_CONCURRENCY,
        live,
        skipTransfers: true,
      });
    }
    recorder.milestone('ready');

    const totalRequests = Object.values(recorder.requestCounts).reduce(
      (total, count) => total + count,
      0,
    );
    const standingsMilestoneIndex = recorder.timeline.indexOf('milestone:standings_published');
    const firstEnrichmentRequestIndex = recorder.timeline.findIndex(
      (item) => item === 'entry_picks' || item === 'entry_transfers',
    );
    const record: BenchmarkRecord = {
      event: 'tournament_setup_benchmark',
      case: caseName,
      participantCount: entryIds.length,
      eventCount,
      durationMs: Math.round(performance.now() - startedAt),
      rssDeltaBytes: process.memoryUsage().rss - rssBefore,
      milestoneOrder: recorder.timeline
        .filter((item) => item.startsWith('milestone:'))
        .map((item) => item.slice('milestone:'.length)),
      requestCounts: { ...recorder.requestCounts },
      totalRequests,
      reusedUnits: {
        entrySnapshots: entryPlan.reusedEntries,
        coreResults: corePlan.reusedPairs,
        picks: entryIds.length * eventCount - missingPickPairs,
        transferHistories: entryIds.length - transferEntryIds.length,
      },
      maxConcurrentRequests: recorder.maxConcurrentRequests,
      maxConcurrentByEndpoint: { ...recorder.maxConcurrentByEndpoint },
      standingsPublishedBeforeEnrichmentRequests:
        firstEnrichmentRequestIndex === -1 || standingsMilestoneIndex < firstEnrichmentRequestIndex,
      coreUpsertBatchLimit: CORE_HISTORY_BATCH_SIZE,
      maxCoreUpsertBatchRows: Math.min(eventCount, CORE_HISTORY_BATCH_SIZE),
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(record));
    return record;
  } finally {
    resetMockFPLClient();
  }
}

describe.skipIf(!RUN_BENCHMARK)('tournament setup performance benchmark', () => {
  test(
    'covers cold, warm, partial and large deterministic initialization',
    async () => {
      const season = await prepareBenchmarkInfrastructure(38);
      const oneEntryIds = benchmarkEntryIds(98_100_000, 1);
      const mediumEntryIds = benchmarkEntryIds(98_200_000, 75);
      const largeEntryIds = benchmarkEntryIds(98_300_000, 250);

      try {
        const oneByOne = await runBenchmarkCase({
          caseName: '1x1_cold',
          entryIds: oneEntryIds,
          eventCount: 1,
        });
        expect(oneByOne.milestoneOrder).toEqual([
          'entry_snapshots_synced',
          'core_results_ready',
          'standings_published',
          'enrichment_started',
          'ready',
        ]);
        expect(oneByOne.totalRequests).toBe(5);
        expect(await countPersistedPairs(oneEntryIds)).toEqual({ results: 1, picks: 1 });

        const cold = await runBenchmarkCase({
          caseName: '75x38_cold',
          entryIds: mediumEntryIds,
          eventCount: 38,
        });
        const estimate = estimateTournamentSetupRequests(75, 38);
        expect(estimate.legacyColdStart).toBe(5_888);
        expect(estimate.optimizedColdStartUpperBound).toBe(3_113);
        expect(cold.requestCounts).toEqual({
          entry_summary: 75,
          entry_history: 75,
          entry_transfers: 75,
          event_live: 38,
          entry_picks: 2_850,
        });
        expect(cold.totalRequests).toBeLessThanOrEqual(3_113);
        expect(cold.standingsPublishedBeforeEnrichmentRequests).toBe(true);
        expect(cold.milestoneOrder.indexOf('standings_published')).toBeLessThan(
          cold.milestoneOrder.indexOf('enrichment_started'),
        );

        const warm = await runBenchmarkCase({
          caseName: '75x38_warm_retry',
          entryIds: mediumEntryIds,
          eventCount: 38,
        });
        expect(warm.totalRequests).toBe(0);
        expect(warm.reusedUnits).toEqual({
          entrySnapshots: 75,
          coreResults: 2_850,
          picks: 2_850,
          transferHistories: 75,
        });

        const sql = await getDbClient();
        await sql`
          UPDATE entry_infos
          SET entry_snapshot_synced_through_event_id = 37
          WHERE id = ${mediumEntryIds[0]}
        `;
        await sql`
          UPDATE entry_infos
          SET entry_transfers_synced_through_event_id = NULL,
              entry_transfers_synced_season = NULL
          WHERE id = ${mediumEntryIds[1]}
        `;
        await sql`
          DELETE FROM entry_event_picks
          WHERE entry_id = ${mediumEntryIds[2]} AND event_id = 1
        `;
        await sql`
          DELETE FROM entry_event_results
          WHERE entry_id = ${mediumEntryIds[2]} AND event_id = 1
        `;
        await clearEventLiveCheckpoint(1);

        const partial = await runBenchmarkCase({
          caseName: '75x38_partial_retry',
          entryIds: mediumEntryIds,
          eventCount: 38,
        });
        expect(partial.requestCounts).toEqual({
          entry_summary: 1,
          entry_history: 1,
          entry_transfers: 1,
          event_live: 1,
          entry_picks: 1,
        });

        const large = await runBenchmarkCase({
          caseName: '250x38_cold',
          entryIds: largeEntryIds,
          eventCount: 38,
        });
        expect(large.totalRequests).toBe(10_288);
        expect(large.maxConcurrentRequests).toBeLessThanOrEqual(ENTRY_SYNC_DEFAULT_CONCURRENCY * 2);
        expect(large.maxConcurrentByEndpoint.entry_picks).toBeLessThanOrEqual(
          ENTRY_SYNC_DEFAULT_CONCURRENCY,
        );
        expect(large.maxConcurrentByEndpoint.entry_transfers).toBeLessThanOrEqual(
          ENTRY_SYNC_DEFAULT_CONCURRENCY,
        );
        expect(large.maxCoreUpsertBatchRows).toBeLessThanOrEqual(CORE_HISTORY_BATCH_SIZE);
        expect(await countPersistedPairs(largeEntryIds)).toEqual({
          results: 9_500,
          picks: 9_500,
        });
      } finally {
        resetMockFPLClient();
        await cleanupBenchmarkEntries(oneEntryIds, season);
        await cleanupBenchmarkEntries(mediumEntryIds, season);
        await cleanupBenchmarkEntries(largeEntryIds, season);
      }
    },
    { timeout: 600_000 },
  );
});
