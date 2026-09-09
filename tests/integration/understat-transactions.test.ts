import { assertIntegrationEnv } from './helpers/env-guard';
assertIntegrationEnv();
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import * as config from '../../src/utils/config';
import * as singleton from '../../src/db/singleton';
import {
  understatClient,
  UnderstatLeagueResponseSchema,
  UnderstatTeamResponseSchema,
  UnderstatMatchResponseSchema,
} from '../../src/clients/understat';
import { understatSyncRepository as runs } from '../../src/repositories/understat-sync';
import * as enqueue from '../../src/jobs/understat-enqueue';
import * as projections from '../../src/services/player-season-summaries.service';
import {
  discoverUnderstatTeams,
  syncUnderstatTeamDetail,
} from '../../src/services/understat-team.service';
import {
  UNDERSTAT_LEAGUE_FIXTURE,
  UNDERSTAT_TEAM_FIXTURE,
  UNDERSTAT_MATCH_FIXTURE,
} from '../fixtures/understat.fixtures';
import { withMutationScopes } from '../../src/utils/mutation-scopes';
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const season = '9697';
const offset = 990_000_000;
const scope = 'understat:reference:all';
const runIds: string[] = [];
const originalConfig = config.getConfig();
function fixture<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value)
      .replaceAll('2025-', '2096-')
      .replace(/"(\d+)"/g, (whole, number) => {
        const n = Number(number);
        return n === 83 || n === 89 || n >= 1000 ? `"${offset + n}"` : whole;
      }),
  );
}
const leagueData = UnderstatLeagueResponseSchema.parse(fixture(UNDERSTAT_LEAGUE_FIXTURE));
const teamData = UnderstatTeamResponseSchema.parse(fixture(UNDERSTAT_TEAM_FIXTURE));
const matchData = UnderstatMatchResponseSchema.parse(fixture(UNDERSTAT_MATCH_FIXTURE));
async function cleanup() {
  for (const runId of runIds) {
    await sql`DELETE FROM ops.sync_items WHERE run_id=${runId}`;
    await sql`DELETE FROM ops.sync_runs WHERE run_id=${runId}`;
  }
  runIds.length = 0;
  await sql`DELETE FROM understat.player_match_stats WHERE match_id=${offset + 28786}`;
  await sql`DELETE FROM understat.player_team_seasons WHERE season_code=${season}`;
  await sql`DELETE FROM understat.player_seasons WHERE season_code=${season}`;
  await sql`DELETE FROM understat.team_stat_splits WHERE season_code=${season}`;
  await sql`DELETE FROM understat.team_seasons WHERE season_code=${season}`;
  await sql`DELETE FROM understat.team_match_stats WHERE match_id=${offset + 28786}`;
  await sql`DELETE FROM understat.matches WHERE season_code=${season}`;
  await sql`DELETE FROM understat.players WHERE player_id BETWEEN ${offset + 1000} AND ${offset + 2011}`;
  await sql`DELETE FROM understat.teams WHERE team_id IN (${offset + 83},${offset + 89})`;
  await sql`DELETE FROM understat.seasons WHERE season_code=${season}`;
}
async function freeScope() {
  expect(singleton.databaseTransactionStorage.getStore()).toBeUndefined();
  await sql.begin(async (tx) => {
    await tx`SELECT scope_key FROM ops.mutation_scopes WHERE scope_key=${scope} FOR UPDATE NOWAIT`;
  });
}
function job() {
  const runId = randomUUID();
  runIds.push(runId);
  return { runId, season, mode: 'incremental' as const, trigger: 'manual' as const };
}
const processors = new Map<string, (job: unknown) => Promise<unknown>>();
const providerContexts: boolean[] = [];
const handoffObservations: Array<{ transaction: boolean; status: string | undefined }> = [];
const projectionObservations: Array<{ transaction: boolean; rows: number }> = [];
async function processJob(lane: 'team' | 'player', name: string, data: unknown) {
  return processors.get(`understat-${lane}-sync`)!({
    id: 'fixture',
    name,
    queueName: `understat-${lane}-sync`,
    attemptsMade: 0,
    opts: { attempts: 3 },
    data,
  });
}
async function wireWorkers() {
  const bullmq = await import('bullmq');
  const teamQueue = await import('../../src/queues/understat-team.queue');
  const playerQueue = await import('../../src/queues/understat-player.queue');
  const queue = await import('../../src/utils/queue');
  const fence = await import('../../src/utils/scheduler-obligation-fence');
  const tracking = await import('../../src/utils/job-run-logger');
  const emitter = {
    on() {
      return this;
    },
  };
  spyOn(bullmq, 'Worker').mockImplementation(function (name: string, callback: unknown) {
    processors.set(name, callback as (job: unknown) => Promise<unknown>);
    return emitter;
  } as never);
  spyOn(bullmq, 'QueueEvents').mockImplementation(function () {
    return emitter;
  } as never);
  spyOn(teamQueue, 'getUnderstatTeamQueue').mockReturnValue({} as never);
  spyOn(playerQueue, 'getUnderstatPlayerQueue').mockReturnValue({} as never);
  spyOn(queue, 'getQueueConnection').mockReturnValue({} as never);
  spyOn(fence, 'startCurrentSchedulerJob').mockResolvedValue(true);
  spyOn(tracking, 'runTrackedJob').mockImplementation(async (_input, operation) => operation());
  spyOn(tracking, 'logJobTriggered').mockImplementation(() => undefined);
  const { createUnderstatWorker } = await import('../../src/workers/understat.worker');
  createUnderstatWorker();
}
beforeEach(async () => {
  await cleanup();
  projectionObservations.length = 0;
  providerContexts.length = 0;
  handoffObservations.length = 0;
  spyOn(config, 'getConfig').mockReturnValue({
    ...originalConfig,
    UNDERSTAT_ENABLED: true,
    UNDERSTAT_SEASON: season,
    UNDERSTAT_MIN_SEASON: season,
    UNDERSTAT_LEAGUE: 'EPL',
  });
  await sql`INSERT INTO ops.mutation_scopes(scope_key,last_used_at) VALUES(${scope},now()) ON CONFLICT DO NOTHING`;
  spyOn(understatClient, 'getLeagueData').mockImplementation(async () => {
    const transaction = Boolean(singleton.databaseTransactionStorage.getStore());
    providerContexts.push(transaction);
    if (!transaction) await freeScope();
    return leagueData as never;
  });
  spyOn(understatClient, 'getTeamData').mockImplementation(async () => {
    const transaction = Boolean(singleton.databaseTransactionStorage.getStore());
    providerContexts.push(transaction);
    if (!transaction) await freeScope();
    return teamData as never;
  });
  spyOn(understatClient, 'getMatchData').mockImplementation(async () => {
    const transaction = Boolean(singleton.databaseTransactionStorage.getStore());
    providerContexts.push(transaction);
    if (!transaction) await freeScope();
    return matchData as never;
  });
  for (const name of [
    'enqueueUnderstatTeamDetail',
    'enqueueUnderstatTeamFinalize',
    'enqueueUnderstatPlayerTeamDetail',
    'enqueueUnderstatPlayerMatch',
    'enqueueUnderstatPlayerFinalize',
  ] as const) {
    spyOn(enqueue, name).mockImplementation(async (data: { runId: string }) => {
      const transaction = Boolean(singleton.databaseTransactionStorage.getStore());
      if (!transaction) await freeScope();
      const [item] =
        await sql`SELECT status FROM ops.sync_items WHERE run_id=${data.runId} AND resource_type='league'`;
      handoffObservations.push({ transaction, status: item?.status });
      return undefined as never;
    });
  }
  spyOn(projections, 'refreshPlayerStateSeasonSafely').mockImplementation(async () => {
    const transaction = Boolean(singleton.databaseTransactionStorage.getStore());
    const [row] =
      await sql`SELECT count(*)::int AS count FROM understat.player_team_seasons WHERE season_code=${season}`;
    projectionObservations.push({ transaction, rows: row!.count });
    if (!transaction) await freeScope();
    return undefined as never;
  });
  spyOn(projections, 'publishUnderstatPlayerState').mockImplementation(async () => {
    const transaction = Boolean(singleton.databaseTransactionStorage.getStore());
    const [row] =
      await sql`SELECT count(*)::int AS count FROM understat.player_match_stats WHERE match_id=${offset + 28786}`;
    projectionObservations.push({ transaction, rows: row!.count });
    if (!transaction) await freeScope();
    return undefined as never;
  });
  await wireWorkers();
});
afterEach(async () => {
  mock.restore();
  await cleanup();
});
afterAll(() => sql.end());

test('team discovery commits before fanout and resource completion is atomic with its splits', async () => {
  const data = job();
  await processJob('team', 'understat-team-discover', data);
  expect(enqueue.enqueueUnderstatTeamDetail).toHaveBeenCalled();
  expect(
    handoffObservations.every((value) => !value.transaction && value.status === 'completed'),
  ).toBe(true);
  await processJob('team', 'understat-team-detail', {
    ...data,
    teamId: offset + 83,
    teamTitle: 'Arsenal',
  });
  expect((await runs.findItem(data.runId, 'team-detail', String(offset + 83)))!.status).toBe(
    'completed',
  );
  const [row] =
    await sql`SELECT count(*)::int AS count FROM understat.team_stat_splits WHERE season_code=${season} AND team_id=${offset + 83}`;
  expect(row!.count).toBe(7);
  expect(providerContexts).toEqual([false, false]);
  await freeScope();
});

test('player discovery, team and match requests release the scope and projections follow commits', async () => {
  const data = job();
  await processJob('player', 'understat-player-discover', data);
  await processJob('player', 'understat-player-team-detail', {
    ...data,
    resourceId: offset + 83,
    teamTitle: 'Arsenal',
  });
  expect((await runs.findItem(data.runId, 'team-participants', String(offset + 83)))!.status).toBe(
    'completed',
  );
  await processJob('player', 'understat-player-match', { ...data, resourceId: offset + 28786 });
  expect((await runs.findItem(data.runId, 'match-roster', String(offset + 28786)))!.status).toBe(
    'completed',
  );
  expect(projections.refreshPlayerStateSeasonSafely).toHaveBeenCalled();
  expect(projections.publishUnderstatPlayerState).toHaveBeenCalled();
  expect(providerContexts).toEqual([false, false, false]);
  expect(projectionObservations).toHaveLength(2);
  expect(projectionObservations.every((value) => !value.transaction && value.rows > 0)).toBe(true);
});

test('a failed run during provider wait discards the response before canonical writes', async () => {
  const data = job();
  spyOn(understatClient, 'getLeagueData').mockImplementation(async () => {
    await freeScope();
    await runs.markRunFailed(data.runId, 'fixture recovery');
    return leagueData as never;
  });
  await discoverUnderstatTeams(data);
  const [row] =
    await sql`SELECT count(*)::int AS count FROM understat.matches WHERE season_code=${season}`;
  expect(row!.count).toBe(0);
  expect(enqueue.enqueueUnderstatTeamDetail).not.toHaveBeenCalled();
});

test('a newer item attempt fences a delayed provider response', async () => {
  const data = job();
  spyOn(understatClient, 'getLeagueData').mockImplementation(async () => {
    await freeScope();
    await withMutationScopes(
      { queueName: 'understat-team-sync', jobName: 'fixture-claim', scopes: [scope] },
      () => runs.markItemRunning(data.runId, 'league', 'EPL'),
    );
    return leagueData as never;
  });
  await discoverUnderstatTeams(data);
  expect((await runs.findItem(data.runId, 'league', 'EPL'))!.attempts).toBe(2);
  expect(enqueue.enqueueUnderstatTeamDetail).not.toHaveBeenCalled();
  const [row] =
    await sql`SELECT count(*)::int AS count FROM understat.matches WHERE season_code=${season}`;
  expect(row!.count).toBe(0);
});

test('failed resource checkpoint rolls back canonical rows and never hands off', async () => {
  const data = job();
  await discoverUnderstatTeams(data);
  const original = runs.completeItem;
  spyOn(runs, 'completeItem').mockImplementation(async (...args) => {
    if (args[1] === 'team-detail') throw new Error('checkpoint failure');
    return original.apply(runs, args);
  });
  await expect(
    syncUnderstatTeamDetail({ ...data, teamId: offset + 83, teamTitle: 'Arsenal' }),
  ).rejects.toThrow('checkpoint failure');
  const [row] =
    await sql`SELECT count(*)::int AS count FROM understat.team_stat_splits WHERE season_code=${season} AND team_id=${offset + 83}`;
  expect(row!.count).toBe(0);
  expect((await runs.findItem(data.runId, 'team-detail', String(offset + 83)))!.status).toBe(
    'running',
  );
  expect(enqueue.enqueueUnderstatTeamFinalize).not.toHaveBeenCalled();
});

test('fanout failure preserves the committed discovery and retry hands off without refetching', async () => {
  const data = job();
  spyOn(enqueue, 'enqueueUnderstatTeamDetail').mockRejectedValue(new Error('queue unavailable'));
  await expect(discoverUnderstatTeams(data)).rejects.toThrow();
  expect((await runs.findItem(data.runId, 'league', 'EPL'))!.status).toBe('completed');
  expect(understatClient.getLeagueData).toHaveBeenCalledTimes(1);
  spyOn(enqueue, 'enqueueUnderstatTeamDetail').mockImplementation(async () => {
    await freeScope();
    return undefined as never;
  });
  await discoverUnderstatTeams(data);
  expect(understatClient.getLeagueData).toHaveBeenCalledTimes(1);
  expect(enqueue.enqueueUnderstatTeamDetail).toHaveBeenCalledTimes(4);
});

test('settled resources retry only their post-commit handoff without fetching again', async () => {
  const data = job();
  await discoverUnderstatTeams(data);
  const detail = { ...data, teamId: offset + 83, teamTitle: 'Arsenal' };
  await syncUnderstatTeamDetail(detail);
  await withMutationScopes(
    { queueName: 'understat-team-sync', jobName: 'fixture-skip-sibling', scopes: [scope] },
    () =>
      runs.skipItem(data.runId, 'team-detail', String(offset + 89), 'fixture incomplete sibling'),
  );
  await syncUnderstatTeamDetail(detail);
  expect(understatClient.getTeamData).toHaveBeenCalledTimes(1);
  expect((await runs.findItem(data.runId, 'team-detail', String(offset + 83)))!.attempts).toBe(1);
  expect(enqueue.enqueueUnderstatTeamFinalize).toHaveBeenCalledTimes(1);
  expect(
    handoffObservations.every((value) => !value.transaction && value.status === 'completed'),
  ).toBe(true);
});

test('a later shared match observation cannot be mixed with an older discovery graph', async () => {
  const player = job();
  await processJob('player', 'understat-player-discover', player);
  const team = job();
  spyOn(understatClient, 'getLeagueData').mockImplementation(async () => {
    await freeScope();
    await withMutationScopes(
      { queueName: 'understat-player-sync', jobName: 'fixture-newer-reference', scopes: [scope] },
      async () => {
        await sql`UPDATE understat.matches SET source_hash='newer-reference-fixture',home_xg=2,source_checked_at=stamp.checked_at,last_seen_at=stamp.checked_at FROM (SELECT clock_timestamp() AS checked_at) stamp WHERE match_id=${offset + 28786}`;
      },
    );
    return leagueData as never;
  });
  await expect(discoverUnderstatTeams(team)).rejects.toThrow('reference snapshot was superseded');
  const [match] =
    await sql`SELECT source_hash FROM understat.matches WHERE match_id=${offset + 28786}`;
  expect(match!.source_hash).toBe('newer-reference-fixture');
  const [stats] =
    await sql`SELECT count(*)::int AS count FROM understat.team_match_stats WHERE match_id=${offset + 28786}`;
  expect(stats!.count).toBe(0);
  expect(enqueue.enqueueUnderstatTeamDetail).not.toHaveBeenCalled();
});
