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
          expectedState: rolledBack!,
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
        publicationState: 'COLLECTING',
        isActive: false,
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

  test('enqueue failure CAS cannot overwrite a newer setup marker', async () => {
    const season = explicitSeasonRef(SEASON_CODE);
    const oldMarker = '2095-01-06T00:00:00.000Z';
    const newMarker = '2095-01-06T00:01:00.000Z';
    const sqlClient = await getDbClient();
    await sqlClient`
      UPDATE competition.tournaments
      SET setup_status='pending', setup_phase='queued',
          setup_progress_updated_at=${newMarker}, setup_started_at=NULL,
          setup_finished_at=NULL
      WHERE season_id=${SEASON_ID} AND tournament_id=${SUCCESS_TOURNAMENT_ID}
    `;

    const changed = await tournamentInfoRepository.markSetupResultIfUnchanged(
      season,
      SUCCESS_TOURNAMENT_ID,
      'failed',
      'queue response lost',
      oldMarker,
      0,
      'QUEUE_ADD_FAILED',
    );

    expect(changed).toBe(false);
    const [row] = await sqlClient<
      Array<{ setup_status: string; setup_progress_updated_at: string | null }>
    >`
      SELECT setup_status, setup_progress_updated_at::text
      FROM competition.tournaments
      WHERE season_id=${SEASON_ID} AND tournament_id=${SUCCESS_TOURNAMENT_ID}
    `;
    expect(row).toEqual({
      setup_status: 'pending',
      setup_progress_updated_at: '2095-01-06 00:01:00+00',
    });
  });

  test('escaped setup failure CAS keeps a newer marker-owned execution', async () => {
    const season = explicitSeasonRef(SEASON_CODE);
    const oldMarker = '2095-01-07T00:00:00.000Z';
    const newMarker = '2095-01-07T00:01:00.000Z';
    const startedAt = '2095-01-07T00:01:01.000Z';
    const sqlClient = await getDbClient();
    await sqlClient`
      UPDATE competition.tournaments
      SET setup_status='processing', setup_phase='building_structure', setup_attempt=1,
          setup_started_at=${startedAt}, setup_next_retry_at=NULL,
          setup_progress_updated_at=${newMarker}, setup_finished_at=NULL
      WHERE season_id=${SEASON_ID} AND tournament_id=${SUCCESS_TOURNAMENT_ID}
    `;

    const changed = await tournamentInfoRepository.markSetupAttemptFailure(
      season,
      SUCCESS_TOURNAMENT_ID,
      {
        execution: { attempt: 1, startedAt },
        attempt: 1,
        terminal: false,
        errorCode: 'QUEUE_WORKER_CRASH',
        nextRetryAt: new Date('2095-01-07T00:02:00.000Z'),
        startedAt: new Date(startedAt),
        progressMarker: oldMarker,
      },
    );

    expect(changed).toBe(false);
    const [row] = await sqlClient<
      Array<{ setup_status: string; setup_phase: string; setup_progress_updated_at: string | null }>
    >`
      SELECT setup_status, setup_phase, setup_progress_updated_at::text
      FROM competition.tournaments
      WHERE season_id=${SEASON_ID} AND tournament_id=${SUCCESS_TOURNAMENT_ID}
    `;
    expect(row).toEqual({
      setup_status: 'processing',
      setup_phase: 'building_structure',
      setup_progress_updated_at: '2095-01-07 00:01:00+00',
    });
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
            expectedState: (await tournamentInfoRepository.findSetupStatus(
              season,
              RETRY_TOURNAMENT_ID,
            ))!,
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
            beforeRecovery?.setupStartedAt ?? null,
            beforeRecovery?.setupAttempt ?? null,
          ),
      ),
    ).not.toBeNull();

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

  test('watchdog CAS rejects a row after a worker claims the observed execution', async () => {
    const season = explicitSeasonRef(SEASON_CODE);
    await tournamentInfoRepository.markSetupRetryQueued(season, RETRY_TOURNAMENT_ID);
    const firstExecution = await tournamentInfoRepository.markSetupProcessing(
      season,
      RETRY_TOURNAMENT_ID,
      '2095-01-01 00:00:00+00',
      1,
    );
    const observed = await tournamentInfoRepository.findSetupStatus(season, RETRY_TOURNAMENT_ID);
    expect(observed?.setupStartedAt).toBe(firstExecution.startedAt);

    // A second claim represents the worker winning the queue-probe/CAS race.
    const secondExecution = await tournamentInfoRepository.markSetupProcessing(
      season,
      RETRY_TOURNAMENT_ID,
      '2095-01-01 00:00:00+00',
      1,
    );
    const recoveryMarker = await withMutationScopes(
      {
        queueName: 'integration-tournament-setup',
        jobName: 'watchdog-race',
        tournamentId: RETRY_TOURNAMENT_ID,
        scopes: [tournamentSetupLifecycleScope(RETRY_TOURNAMENT_ID)],
      },
      () =>
        tournamentInfoRepository.markStuckSetupQueuedIfUnchanged(
          season,
          RETRY_TOURNAMENT_ID,
          observed?.setupProgressUpdatedAt ?? null,
          observed?.setupStartedAt ?? null,
          observed?.setupAttempt ?? null,
        ),
    );

    expect(recoveryMarker).toBeNull();
    expect(secondExecution.startedAt).not.toBe(firstExecution.startedAt);
    expect(
      await tournamentInfoRepository.findSetupStatus(season, RETRY_TOURNAMENT_ID),
    ).toMatchObject({
      setupStatus: 'processing',
      setupPhase: 'syncing_entries',
      setupAttempt: 1,
    });
  });

  test('prepared setup retry keeps one durable marker before queue admission', async () => {
    const season = explicitSeasonRef(SEASON_CODE);
    const firstMarker = await tournamentInfoRepository.markSetupRetryQueued(
      season,
      RETRY_TOURNAMENT_ID,
    );
    const secondMarker = await tournamentInfoRepository.markSetupRetryQueued(
      season,
      RETRY_TOURNAMENT_ID,
    );

    expect(firstMarker).toBeString();
    expect(secondMarker).toBe(firstMarker);
    expect(
      await tournamentInfoRepository.findSetupStatus(season, RETRY_TOURNAMENT_ID),
    ).toMatchObject({
      setupStatus: 'processing',
      setupPhase: 'queued',
      setupAttempt: 0,
      setupProgressUpdatedAt: firstMarker,
    });
  });

  test('official resume watchdog CAS rejects a worker claim after the queue probe', async () => {
    const season = explicitSeasonRef(SEASON_CODE);
    const marker = await tournamentInfoRepository.markSetupRetryQueued(season, RETRY_TOURNAMENT_ID);
    const sqlClient = await getDbClient();
    await sqlClient`
      UPDATE competition.tournaments
      SET state = 'inactive', roster_mode = 'official_sync', roster_sync_status = 'processing'
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${RETRY_TOURNAMENT_ID}
    `;
    const observed = await tournamentInfoRepository.findSetupStatus(season, RETRY_TOURNAMENT_ID);
    expect(observed?.setupProgressUpdatedAt).toBe(marker);

    await tournamentInfoRepository.markSetupProcessing(season, RETRY_TOURNAMENT_ID, marker, 1);
    const observedMarker = observed?.setupProgressUpdatedAt;
    if (!observedMarker) throw new Error('setup retry marker was not persisted');
    const recoveryClaimed = await withMutationScopes(
      {
        queueName: 'integration-tournament-setup',
        jobName: 'watchdog-official-resume-race',
        tournamentId: RETRY_TOURNAMENT_ID,
        scopes: [tournamentSetupLifecycleScope(RETRY_TOURNAMENT_ID)],
      },
      () =>
        tournamentInfoRepository.markStuckOfficialResumeQueuedIfUnchanged(
          season,
          RETRY_TOURNAMENT_ID,
          observedMarker,
          observed?.setupStartedAt,
          observed?.setupAttempt ?? null,
        ),
    );

    expect(recoveryClaimed).toBeNull();
    expect(
      await tournamentInfoRepository.findSetupStatus(season, RETRY_TOURNAMENT_ID),
    ).toMatchObject({
      setupStatus: 'processing',
      setupPhase: 'syncing_entries',
      setupAttempt: 1,
    });
  });

  test('watchdog restores the stale marker when queue admission fails', async () => {
    const season = explicitSeasonRef(SEASON_CODE);
    await tournamentInfoRepository.markSetupRetryQueued(season, RETRY_TOURNAMENT_ID);
    const sqlClient = await getDbClient();
    await sqlClient`
      UPDATE competition.tournaments
      SET setup_status = 'processing',
          setup_phase = 'queued',
          setup_progress_updated_at = '2020-01-01 00:00:00+00',
          updated_at = '2020-01-01 00:00:00+00'
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${RETRY_TOURNAMENT_ID}
    `;
    const beforeRecovery = await tournamentInfoRepository.findSetupStatus(
      season,
      RETRY_TOURNAMENT_ID,
    );
    const [beforeActivity] = await sqlClient<Array<{ updatedAt: string }>>`
      SELECT updated_at::text AS "updatedAt"
      FROM competition.tournaments
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${RETRY_TOURNAMENT_ID}
    `;
    if (!beforeActivity) throw new Error('setup recovery fixture is missing');
    const recoveryMarker = await withMutationScopes(
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
          beforeRecovery?.setupStartedAt ?? null,
          beforeRecovery?.setupAttempt ?? null,
        ),
    );
    expect(recoveryMarker).toBeString();
    expect(
      await withMutationScopes(
        {
          queueName: 'integration-tournament-setup',
          jobName: 'restore-watchdog-recovery',
          tournamentId: RETRY_TOURNAMENT_ID,
          scopes: [tournamentSetupLifecycleScope(RETRY_TOURNAMENT_ID)],
        },
        () =>
          tournamentInfoRepository.restoreStuckSetupAfterEnqueueFailure(
            season,
            RETRY_TOURNAMENT_ID,
            recoveryMarker!,
            beforeRecovery?.setupProgressUpdatedAt ?? null,
            beforeActivity.updatedAt,
          ),
      ),
    ).toBe(true);
    const restored = await tournamentInfoRepository.findSetupStatus(season, RETRY_TOURNAMENT_ID);
    expect(restored).toMatchObject({
      setupStatus: 'pending',
      setupPhase: 'queued',
      setupProgressUpdatedAt: beforeRecovery?.setupProgressUpdatedAt,
      setupLastErrorCode: 'STUCK_SETUP_QUEUE_ENQUEUE_FAILED',
    });
    expect(
      (await tournamentInfoRepository.findStuckProcessing(season, 1)).some(
        (row) => row.id === RETRY_TOURNAMENT_ID,
      ),
    ).toBe(true);
  });

  test('official resume watchdog restores its prior stale execution after enqueue failure', async () => {
    const season = explicitSeasonRef(SEASON_CODE);
    const sqlClient = await getDbClient();
    await sqlClient`
      UPDATE competition.tournaments
      SET state = 'inactive',
          roster_mode = 'official_sync',
          roster_sync_status = 'processing',
          setup_status = 'processing',
          setup_phase = 'syncing_entries',
          setup_attempt = 2,
          setup_progress_updated_at = '2020-01-02 00:00:00+00',
          setup_started_at = '2020-01-02 00:00:00+00',
          setup_next_retry_at = NULL,
          setup_finished_at = NULL,
          updated_at = '2020-01-02 00:00:00+00'
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${RETRY_TOURNAMENT_ID}
    `;
    const [before] = await tournamentInfoRepository.findStuckProcessing(season, 1);
    if (!before) throw new Error('official resume recovery fixture is missing');

    const recoveryUpdatedAt = await withMutationScopes(
      {
        queueName: 'integration-tournament-setup',
        jobName: 'claim-official-resume-recovery',
        tournamentId: RETRY_TOURNAMENT_ID,
        scopes: [tournamentSetupLifecycleScope(RETRY_TOURNAMENT_ID)],
      },
      () =>
        tournamentInfoRepository.markStuckOfficialResumeQueuedIfUnchanged(
          season,
          RETRY_TOURNAMENT_ID,
          before.setupProgressUpdatedAt!,
          before.setupStartedAt,
          before.setupAttempt,
        ),
    );
    expect(recoveryUpdatedAt).toBeString();
    expect(
      await tournamentInfoRepository.restoreStuckOfficialResumeAfterEnqueueFailure(
        season,
        RETRY_TOURNAMENT_ID,
        recoveryUpdatedAt!,
        before,
      ),
    ).toBe(true);

    expect(
      await tournamentInfoRepository.findSetupStatus(season, RETRY_TOURNAMENT_ID),
    ).toMatchObject({
      setupStatus: 'processing',
      setupPhase: 'syncing_entries',
      setupAttempt: 2,
      setupProgressUpdatedAt: before.setupProgressUpdatedAt,
      setupStartedAt: before.setupStartedAt,
    });
  });
});
