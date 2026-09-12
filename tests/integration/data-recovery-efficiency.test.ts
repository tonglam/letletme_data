import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, expect, test, spyOn } from 'bun:test';
import { contentHash } from '../../src/utils/content-hash';
import {
  liveLeagueV2ItemKey,
  type LeagueLiveManifest,
} from '../../src/cache/live-league-publication-v2';
import { checkpointLiveLeaguePublicationV2 } from '../../src/services/live-league-checkpoint-v2.service';
import { getDb, getDbClient } from '../../src/db/singleton';
import { createEventLiveRepository } from '../../src/repositories/event-lives';
import { attachFreshnessWindowToSchedulerObligation } from '../../src/services/data-governance.service';
import {
  hasFinalLiveLeagueCheckpointsV2,
  readLiveFinalizationPrerequisites,
} from '../../src/services/live-publication-v2-checkpoint.service';
import { singleTransformedEventLiveFixture } from '../fixtures/event-lives.fixtures';

const season = { seasonId: 2089, seasonCode: '8990' };
const obligationId = '30000000-0000-4000-8000-000000000089';

async function cleanup() {
  const sql = await getDbClient();
  await sql`DELETE FROM ops.scheduler_obligations WHERE obligation_id = ${obligationId}`;
  await sql`DELETE FROM competition.tournament_entries WHERE season_id = ${season.seasonId}`;
  await sql`DELETE FROM competition.live_league_checkpoints WHERE season_id = ${season.seasonId}`;
  await sql`DELETE FROM competition.tournaments WHERE season_id = ${season.seasonId}`;
  await sql`DELETE FROM competition.entries WHERE season_id = ${season.seasonId}`;
  await sql`DELETE FROM competition.my_fpl_snapshot_scope_state WHERE season_id = ${season.seasonId}`;
  await sql`DELETE FROM fpl.player_gameweek_stats WHERE season_id = ${season.seasonId}`;
  await sql`DELETE FROM fpl.players WHERE season_id = ${season.seasonId}`;
  await sql`DELETE FROM fpl.teams WHERE season_id = ${season.seasonId}`;
  await sql`DELETE FROM fpl.events WHERE season_id = ${season.seasonId}`;
  await sql`DELETE FROM fpl.seasons WHERE season_id = ${season.seasonId}`;
}

beforeAll(async () => {
  await cleanup();
  const sql = await getDbClient();
  await sql`INSERT INTO fpl.seasons (season_id,season_code,display_name,start_year,end_year,lifecycle_state,is_current)
    VALUES (${season.seasonId},${season.seasonCode},'Recovery test',2089,2090,'completed',false)`;
  await sql`INSERT INTO fpl.events (season_id,event_id,name,finished,data_checked,data_checked_at)
    VALUES (${season.seasonId},1,'GW1',true,true,'2089-09-01T00:00:00Z')`;
  await sql`INSERT INTO fpl.teams (season_id,team_id,code,name,short_name)
    VALUES (${season.seasonId},1,89001,'Recovery team','RCT')`;
  await sql`INSERT INTO fpl.players (season_id,element_id,code,element_type,team_id,web_name)
    VALUES (${season.seasonId},1,89001,1,1,'Recovery player')`;
});
afterAll(cleanup);

test('identical terminal replays do not write rows; first identity and changed facts do', async () => {
  const db = await getDb();
  const sql = await getDbClient();
  const repo = createEventLiveRepository(db);
  const row = { ...singleTransformedEventLiveFixture, eventId: 1, elementId: 1 };
  const checkpoint = {
    publicationId: 'recovery-first',
    generation: 1,
    eventLiveSha256: 'a'.repeat(64),
  };
  expect(await repo.upsertBatch(season, [row], { checkpoint })).toHaveLength(1);
  const finalCheckpoint = {
    ...checkpoint,
    publicationId: 'recovery-final',
    generation: 2,
    forceIdentity: true,
  };
  expect(await repo.upsertBatch(season, [row], { checkpoint: finalCheckpoint })).toHaveLength(1);
  const [before] =
    await sql`SELECT updated_at::text, xmin::text FROM fpl.player_gameweek_stats WHERE season_id=${season.seasonId}`;
  expect(await repo.upsertBatch(season, [row], { checkpoint: finalCheckpoint })).toHaveLength(0);
  const [after] =
    await sql`SELECT updated_at::text, xmin::text FROM fpl.player_gameweek_stats WHERE season_id=${season.seasonId}`;
  expect(after).toEqual(before);
  expect(
    await repo.upsertBatch(season, [{ ...row, totalPoints: row.totalPoints + 1 }], {
      checkpoint: finalCheckpoint,
    }),
  ).toHaveLength(1);
});

test('atomic freshness binding preserves concurrent distinct IDs and skips an identical terminal binding', async () => {
  const sql = await getDbClient();
  await sql`INSERT INTO ops.scheduler_obligations (obligation_id,job_name,scope_key,period_key,cadence,timezone,due_at,status,evidence)
    VALUES (${obligationId},'integration-recovery','integration-recovery','once','once','UTC',now(),'irrecoverable','{"originalFailure":"keep"}')`;
  await Promise.all(
    [11, 12, 13, 14, 15].map((freshnessWindowId) =>
      attachFreshnessWindowToSchedulerObligation({ obligationId, freshnessWindowId }),
    ),
  );
  const [row] =
    await sql`SELECT evidence,updated_at::text,xmin::text FROM ops.scheduler_obligations WHERE obligation_id=${obligationId}`;
  expect([...row.evidence.freshnessWindowIds].sort((a, b) => a - b)).toEqual([11, 12, 13, 14, 15]);
  expect(row.evidence.originalFailure).toBe('keep');
  expect(
    await attachFreshnessWindowToSchedulerObligation({
      obligationId,
      freshnessWindowId: row.evidence.freshnessWindowId,
    }),
  ).toBe(false);
  const [after] =
    await sql`SELECT evidence,updated_at::text,xmin::text FROM ops.scheduler_obligations WHERE obligation_id=${obligationId}`;
  expect(after).toEqual(row);
});

test('new Classic scope invalidates readiness and missing semantic input blocks finalization', async () => {
  const sql = await getDbClient();
  expect(await hasFinalLiveLeagueCheckpointsV2(season, 1)).toBe(true);
  expect(await readLiveFinalizationPrerequisites(season, 1)).toEqual({ blocked: false });
  await sql`INSERT INTO competition.entries (season_id,entry_id,entry_name,player_name) VALUES (${season.seasonId},89001,'test','test')`;
  await sql`INSERT INTO competition.tournaments (tournament_id,season_id,name,creator,admin_entry_id,league_id,league_type,total_team_num,tournament_mode,group_mode,group_auto_averages,state,setup_status)
    VALUES (89001,${season.seasonId},'Recovery','test',89001,89001,'classic',1,'normal','no_group',false,'active','ready')`;
  await sql`INSERT INTO competition.tournament_entries (season_id,tournament_id,league_id,entry_id) VALUES (${season.seasonId},89001,89001,89001)`;
  expect(await hasFinalLiveLeagueCheckpointsV2(season, 1)).toBe(false);
  expect(await readLiveFinalizationPrerequisites(season, 1)).toEqual({ blocked: true });
  const checkpointPayload = { index: [], payload: {} };
  await sql`INSERT INTO competition.live_league_checkpoints (
    season_id,event_id,tournament_id,scope_kind,publication_id,generation,state,
    manifest,index_payload,payload,row_count,payload_bytes,payload_sha256,
    source_checked_at,content_updated_at,published_at,checkpointed_at
  ) VALUES (
    ${season.seasonId},1,89001,'CLASSIC','already-finalized',1,'FINALIZED',
    '{}'::jsonb,'[]'::jsonb,'{}'::jsonb,0,
    ${Buffer.byteLength(JSON.stringify(checkpointPayload))},
    ${contentHash(checkpointPayload)},
    '2089-09-02T00:00:00Z','2089-09-02T00:00:00Z',
    '2089-09-02T00:00:00Z','2089-09-02T00:00:00Z'
  )`;
  expect(await readLiveFinalizationPrerequisites(season, 1)).toEqual({ blocked: false });
});

test('validated checkpoint payloads are reused until identity changes or five minutes elapse', async () => {
  const sql = await getDbClient();
  const db = await getDb();
  const scope = {
    season: season.seasonCode,
    eventId: 1,
    tournamentId: 89001,
    scope: 'CLASSIC' as const,
  };
  const revision = 'a'.repeat(64);
  const timestamp = '2089-09-02T00:00:00.000Z';
  const publication: LeagueLiveManifest = {
    contractVersion: 'live-points-v2',
    publicationId: '30000000-0000-4000-8000-000000000099',
    generation: 1,
    ...scope,
    state: 'FINALIZED',
    globalRef: { publicationId: '30000000-0000-4000-8000-000000000098', generation: 1 },
    revisions: {
      roster: revision,
      scoreCore: revision,
      fixtureIdentity: revision,
      entryInputSet: revision,
      identity: revision,
      officialRank: null,
      rules: revision,
      algorithm: revision,
      schedule: null,
      averageSide: null,
      content: revision,
    },
    times: {
      sourceCheckedAt: timestamp,
      contentUpdatedAt: timestamp,
      publishedAt: timestamp,
      checkpointedAt: timestamp,
      expectedNextCheckAt: null,
    },
    counts: { expected: 0, published: 0, ready: 0, noPicks: 0 },
    items: {
      index: {
        name: 'index',
        key: liveLeagueV2ItemKey(scope, 1, 'index'),
        type: 'string',
        count: 0,
        bytes: 2,
        sha256: contentHash([]),
      },
      payload: {
        name: 'payload',
        key: liveLeagueV2ItemKey(scope, 1, 'payload'),
        type: 'string',
        count: 0,
        bytes: 2,
        sha256: contentHash({}),
      },
    },
  };
  await sql`UPDATE competition.entries SET started_event=2 WHERE season_id=${season.seasonId}`;
  expect(await readLiveFinalizationPrerequisites(season, 1)).toEqual({ blocked: false });
  expect(
    await checkpointLiveLeaguePublicationV2(
      { publication, index: [], payload: {}, servedFrom: 'REDIS_CURRENT' },
      db,
    ),
  ).toBe(true);
  const selection = spyOn(db, 'select');
  const fullReads = () => selection.mock.calls.filter((call) => call[0] === undefined).length;
  try {
    expect(await hasFinalLiveLeagueCheckpointsV2(season, 1)).toBe(true);
    expect(fullReads()).toBe(1);
    expect(await hasFinalLiveLeagueCheckpointsV2(season, 1)).toBe(true);
    expect(fullReads()).toBe(1);
    const now = Date.now();
    const time = spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000 + 1);
    try {
      expect(await hasFinalLiveLeagueCheckpointsV2(season, 1)).toBe(true);
    } finally {
      time.mockRestore();
    }
    expect(fullReads()).toBe(2);
    // A corrupt replacement with changed identity is rejected immediately.
    await sql`UPDATE competition.live_league_checkpoints SET payload_sha256=${'b'.repeat(64)} WHERE season_id=${season.seasonId}`;
    expect(await hasFinalLiveLeagueCheckpointsV2(season, 1)).toBe(false);
    expect(fullReads()).toBe(3);
  } finally {
    selection.mockRestore();
  }
});
