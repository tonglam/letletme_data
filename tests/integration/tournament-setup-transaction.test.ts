import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { getDb, getDbClient, withDatabaseSavepoint } from '../../src/db/singleton';
import { explicitSeasonRef } from '../../src/domain/fpl-season';
import { tournamentSetupLifecycleScope } from '../../src/domain/mutation-scope';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { publishTournamentTrendScope } from '../../src/services/tournament-trends-publication.service';
import { withMutationScopes } from '../../src/utils/mutation-scopes';

const SEASON_CODE = '9293';
const SEASON_ID = explicitSeasonRef(SEASON_CODE).seasonId;
const RETRY_TOURNAMENT_ID = 991_901;
const SUCCESS_TOURNAMENT_ID = 991_902;
const ENTRY_IDS = [991_901, 991_902] as const;
const LEAGUE_ID = 991_901;

async function cleanup(): Promise<void> {
  const sqlClient = await getDbClient();
  await sqlClient`
    DELETE FROM competition.entry_event_pick_heads
    WHERE season_id = ${SEASON_ID} AND entry_id = ANY(${sqlClient.array([...ENTRY_IDS])}::integer[])
  `;
  await sqlClient`
    DELETE FROM competition.entry_event_pick_repairs
    WHERE season_id = ${SEASON_ID} AND entry_id = ANY(${sqlClient.array([...ENTRY_IDS])}::integer[])
  `;
  await sqlClient`
    DELETE FROM competition.tournaments
    WHERE tournament_id IN (${RETRY_TOURNAMENT_ID}, ${SUCCESS_TOURNAMENT_ID})
  `;
  await sqlClient`
    DELETE FROM competition.entries
    WHERE season_id = ${SEASON_ID}
      AND entry_id = ANY(${[...ENTRY_IDS]}::integer[])
  `;
  await sqlClient`
    DELETE FROM fpl.events
    WHERE season_id = ${SEASON_ID}
  `;
  await sqlClient`
    DELETE FROM fpl.seasons
    WHERE season_id = ${SEASON_ID}
  `;
}

async function seed(): Promise<void> {
  const sqlClient = await getDbClient();
  await cleanup();

  await sqlClient`
    INSERT INTO fpl.seasons (
      season_id,
      season_code,
      display_name,
      start_year,
      end_year,
      lifecycle_state,
      is_current
    )
    VALUES (
      ${SEASON_ID},
      ${SEASON_CODE},
      'Tournament setup transaction integration',
      ${SEASON_ID},
      ${SEASON_ID + 1},
      'completed',
      false
    )
  `;
  await sqlClient`
    INSERT INTO competition.entries (season_id, entry_id, entry_name, player_name)
    SELECT ${SEASON_ID}, entry_id, 'Transaction Entry ' || entry_id::text, 'Transaction Manager ' || entry_id::text
    FROM unnest(${[...ENTRY_IDS]}::integer[]) AS entries(entry_id)
  `;
  await sqlClient`
    INSERT INTO fpl.events (season_id, event_id, name)
    VALUES (${SEASON_ID}, 1, 'Gameweek 1')
  `;
  await sqlClient`
    INSERT INTO competition.tournaments (
      tournament_id,
      season_id,
      name,
      creator,
      admin_entry_id,
      league_id,
      league_type,
      total_team_num,
      tournament_mode,
      group_mode,
      group_auto_averages,
      state
    )
    SELECT
      tournament_id,
      ${SEASON_ID},
      'Tournament setup transaction integration ' || tournament_id::text,
      'integration-test',
      ${ENTRY_IDS[0]},
      ${LEAGUE_ID},
      'classic',
      1,
      'normal',
      'no_group',
      false,
      'active'
    FROM unnest(${[RETRY_TOURNAMENT_ID, SUCCESS_TOURNAMENT_ID]}::integer[]) AS tournaments(tournament_id)
  `;
}

beforeAll(seed);
afterAll(cleanup);

async function runDatabaseFailure(
  tournamentId: number,
  attempt: number,
  terminal: boolean,
  expectedSetupAttempt: number,
  expectedSetupStatus: 'pending' | 'processing',
) {
  const season = explicitSeasonRef(SEASON_CODE);
  let changed = false;

  await withMutationScopes(
    {
      queueName: 'integration-tournament-setup',
      jobName: 'savepoint-failure',
      tournamentId,
      scopes: [tournamentSetupLifecycleScope(tournamentId)],
    },
    async () => {
      try {
        await withDatabaseSavepoint(async () => {
          await tournamentInfoRepository.markSetupProcessing(
            season,
            tournamentId,
            undefined,
            attempt,
          );
          const db = await getDb();
          await db.execute(sql`SELECT (1, 2)::integer[]`);
        });
      } catch (error) {
        expect(error).toMatchObject({ cause: { code: '42846' } });
        const rolledBack = await tournamentInfoRepository.findSetupStatus(season, tournamentId);
        expect(rolledBack?.setupStatus).toBe(expectedSetupStatus);
        expect(rolledBack?.setupAttempt).toBe(expectedSetupAttempt);
        changed = await tournamentInfoRepository.markSetupAttemptFailure(season, tournamentId, {
          attempt,
          terminal,
          errorCode: '42846',
          nextRetryAt: terminal ? null : new Date(Date.now() + 60_000),
          startedAt: new Date(),
        });
      }
    },
  );

  return changed;
}

describe('tournament setup transaction recovery', () => {
  test('starts repeatable-read safely and converges concurrent Trends publishers', async () => {
    const [first, second] = await Promise.all([
      publishTournamentTrendScope(explicitSeasonRef(SEASON_CODE), SUCCESS_TOURNAMENT_ID, 1),
      publishTournamentTrendScope(explicitSeasonRef(SEASON_CODE), SUCCESS_TOURNAMENT_ID, 1),
    ]);

    expect([first.state, second.state].sort()).toEqual(['COLLECTING', 'REUSED']);
    for (const publication of [first, second]) {
      expect(publication).toMatchObject({
        tournamentId: SUCCESS_TOURNAMENT_ID,
        eventId: 1,
        ownershipState: 'NOT_READY',
        transfersState: 'NOT_READY',
        rows: 0,
      });
    }
    expect(first.publicationId).toBeNumber();
    expect(second.publicationId).toBe(first.publicationId);
  });

  test('rolls back a database statement error to the savepoint and persists retry state', async () => {
    const sqlClient = await getDbClient();
    const season = explicitSeasonRef(SEASON_CODE);

    expect(await runDatabaseFailure(RETRY_TOURNAMENT_ID, 1, false, 0, 'pending')).toBe(true);
    const [firstFailureRow] = await sqlClient<
      Array<{
        setup_status: string;
        setup_phase: string;
        setup_attempt: number;
        setup_last_error_code: string | null;
        setup_next_retry_at: string | null;
      }>
    >`
      SELECT setup_status, setup_phase, setup_attempt, setup_last_error_code, setup_next_retry_at
      FROM competition.tournaments
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${RETRY_TOURNAMENT_ID}
    `;
    expect(firstFailureRow).toMatchObject({
      setup_status: 'processing',
      setup_phase: 'queued',
      setup_attempt: 1,
      setup_last_error_code: '42846',
    });
    expect(firstFailureRow?.setup_next_retry_at).not.toBeNull();

    expect(await runDatabaseFailure(RETRY_TOURNAMENT_ID, 2, false, 1, 'processing')).toBe(true);
    const [secondAttemptRow] = await sqlClient<
      Array<{
        setup_attempt: number;
        setup_phase: string;
      }>
    >`
      SELECT setup_attempt, setup_phase
      FROM competition.tournaments
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${RETRY_TOURNAMENT_ID}
    `;
    expect(secondAttemptRow).toEqual({ setup_attempt: 2, setup_phase: 'queued' });

    await tournamentInfoRepository.markSetupRetryQueued(season, RETRY_TOURNAMENT_ID);
    expect(await runDatabaseFailure(RETRY_TOURNAMENT_ID, 3, true, 0, 'processing')).toBe(true);
    const [terminalRow] = await sqlClient<
      Array<{
        setup_status: string;
        setup_phase: string;
        setup_attempt: number;
      }>
    >`
      SELECT setup_status, setup_phase, setup_attempt
      FROM competition.tournaments
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${RETRY_TOURNAMENT_ID}
    `;
    expect(terminalRow).toEqual({
      setup_status: 'failed',
      setup_phase: 'failed',
      setup_attempt: 3,
    });
  });

  test('commits a successful savepoint and ignores a stale failure after READY', async () => {
    const season = explicitSeasonRef(SEASON_CODE);
    await withMutationScopes(
      {
        queueName: 'integration-tournament-setup',
        jobName: 'savepoint-success',
        tournamentId: SUCCESS_TOURNAMENT_ID,
        scopes: [tournamentSetupLifecycleScope(SUCCESS_TOURNAMENT_ID)],
      },
      async () => {
        await withDatabaseSavepoint(async () => {
          await tournamentInfoRepository.markSetupProcessing(
            season,
            SUCCESS_TOURNAMENT_ID,
            undefined,
            1,
          );
          await tournamentInfoRepository.markSetupResult(
            season,
            SUCCESS_TOURNAMENT_ID,
            'ready',
            null,
            0,
          );
        });
      },
    );

    const changed = await withMutationScopes(
      {
        queueName: 'integration-tournament-setup',
        jobName: 'stale-failure',
        tournamentId: SUCCESS_TOURNAMENT_ID,
        scopes: [tournamentSetupLifecycleScope(SUCCESS_TOURNAMENT_ID)],
      },
      () =>
        tournamentInfoRepository.markSetupAttemptFailure(season, SUCCESS_TOURNAMENT_ID, {
          attempt: 1,
          terminal: true,
          errorCode: '42846',
          nextRetryAt: null,
          startedAt: new Date(),
        }),
    );
    expect(changed).toBe(false);

    const sqlClient = await getDbClient();
    const [row] = await sqlClient<
      Array<{
        setup_status: string;
        setup_phase: string;
        setup_attempt: number;
        setup_finished_at: string | null;
      }>
    >`
      SELECT setup_status, setup_phase, setup_attempt, setup_finished_at
      FROM competition.tournaments
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${SUCCESS_TOURNAMENT_ID}
    `;
    expect(row?.setup_status).toBe('ready');
    expect(row?.setup_phase).toBe('ready');
    expect(row?.setup_attempt).toBe(1);
    expect(row?.setup_finished_at).not.toBeNull();
  });

  test('watchdog recovery preserves the attempt counter and real error code', async () => {
    const season = explicitSeasonRef(SEASON_CODE);
    await withMutationScopes(
      {
        queueName: 'integration-tournament-setup',
        jobName: 'watchdog-seed',
        tournamentId: RETRY_TOURNAMENT_ID,
        scopes: [tournamentSetupLifecycleScope(RETRY_TOURNAMENT_ID)],
      },
      async () => {
        await tournamentInfoRepository.markSetupRetryQueued(season, RETRY_TOURNAMENT_ID);
        expect(
          await tournamentInfoRepository.markSetupAttemptFailure(season, RETRY_TOURNAMENT_ID, {
            attempt: 1,
            terminal: false,
            errorCode: '42846',
            nextRetryAt: new Date(Date.now() + 60_000),
            startedAt: new Date(),
          }),
        ).toBe(true);
      },
    );

    const beforeRecovery = await tournamentInfoRepository.findSetupStatus(
      season,
      RETRY_TOURNAMENT_ID,
    );
    expect(beforeRecovery?.setupProgressUpdatedAt).not.toBeNull();
    expect(
      await withMutationScopes(
        {
          queueName: 'integration-tournament-setup',
          jobName: 'watchdog-recovery',
          tournamentId: RETRY_TOURNAMENT_ID,
          scopes: [tournamentSetupLifecycleScope(RETRY_TOURNAMENT_ID)],
        },
        () =>
          tournamentInfoRepository.markStuckSetupQueuedIfUnchanged(
            season,
            RETRY_TOURNAMENT_ID,
            beforeRecovery?.setupProgressUpdatedAt ?? null,
          ),
      ),
    ).toBe(true);

    const afterRecovery = await tournamentInfoRepository.findSetupStatus(
      season,
      RETRY_TOURNAMENT_ID,
    );
    expect(afterRecovery).toMatchObject({
      setupStatus: 'pending',
      setupAttempt: 1,
      setupLastErrorCode: '42846',
    });
  });
});
