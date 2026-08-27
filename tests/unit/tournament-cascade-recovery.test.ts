import { describe, expect, mock, test } from 'bun:test';

import { TEST_SEASON } from '../fixtures/seasons.fixtures';

process.env.DATABASE_URL ??= 'postgresql://unit:unit@127.0.0.1:5432/unit';
process.env.REDIS_HOST ??= '127.0.0.1';
process.env.REDIS_PORT ??= '6379';

const {
  enqueueTournamentCascade,
  maybeEnqueueCascadeMaterializedRefresh,
  persistTournamentTerminalFailureBeforeSettlement,
  shouldCompleteTournamentJobOnSettlement,
} = await import('../../src/workers/tournament-sync.worker');

const cascadeId = '6f1cbf1f-7601-4b9a-844d-461197d9d1cf';

describe('tournament cascade recovery contract', () => {
  test('partial child enqueue fails closed and propagates the obligation generation', async () => {
    const options: Record<string, unknown>[] = [];
    const successfulEnqueue = async (
      _season: unknown,
      _eventId: number,
      _source: string,
      value: Record<string, unknown>,
    ) => {
      options.push(value);
      return { id: `job-${options.length}` };
    };
    const failedEnqueue = async (
      _season: unknown,
      _eventId: number,
      _source: string,
      value: Record<string, unknown>,
    ) => {
      options.push(value);
      throw new Error('controlled queue outage');
    };
    const initBarrier = mock(async () => undefined);

    await expect(
      enqueueTournamentCascade(
        TEST_SEASON,
        12,
        [],
        'run-12',
        {
          obligationId: 'obligation-12',
          obligationGeneration: 4,
          freshnessWindowId: 314,
        },
        {
          createId: () => cascadeId,
          initBarrier,
          enqueuePointsRace: successfulEnqueue as never,
          enqueueBattleRace: failedEnqueue as never,
          enqueueKnockout: successfulEnqueue as never,
          enqueueTransfersPost: successfulEnqueue as never,
          enqueueCupResults: successfulEnqueue as never,
        },
      ),
    ).rejects.toThrow('Tournament cascade enqueue failed for 1 job');

    expect(initBarrier).toHaveBeenCalledWith(cascadeId);
    expect(options).toHaveLength(5);
    expect(options).toEqual(
      options.map(() =>
        expect.objectContaining({
          cascadeId,
          runId: 'run-12',
          obligationId: 'obligation-12',
          obligationGeneration: 4,
          freshnessWindowId: 314,
        }),
      ),
    );
  });

  test('releases the finalizer claim when queue insertion fails', async () => {
    const markEnqueued = mock(async () => undefined);
    const releaseClaim = mock(async () => undefined);
    let finalizerOptions: Record<string, unknown> | undefined;
    const enqueue = mock(async (...args: unknown[]) => {
      finalizerOptions = args[3] as Record<string, unknown>;
      throw new Error('finalizer queue unavailable');
    });

    await expect(
      maybeEnqueueCascadeMaterializedRefresh(
        TEST_SEASON,
        12,
        cascadeId,
        'tournament-selection-stats',
        [],
        'run-12',
        {
          obligationId: 'obligation-12',
          obligationGeneration: 4,
          freshnessWindowId: 314,
        },
        {
          claim: async () => 'claimed',
          enqueue: enqueue as never,
          markEnqueued,
          releaseClaim,
        },
      ),
    ).rejects.toThrow('finalizer queue unavailable');

    expect(markEnqueued).not.toHaveBeenCalled();
    expect(releaseClaim).toHaveBeenCalledWith(cascadeId);
    expect(finalizerOptions).toMatchObject({
      cascadeId,
      obligationId: 'obligation-12',
      obligationGeneration: 4,
      freshnessWindowId: 314,
    });
  });

  test('passes completion ownership only to the actual finalizer path', () => {
    const data = {
      seasonId: 2026,
      seasonCode: '2627',
      eventId: 12,
      source: 'cascade' as const,
      triggeredAt: new Date().toISOString(),
      obligationId: 'obligation-12',
      obligationGeneration: 4,
    };

    expect(
      shouldCompleteTournamentJobOnSettlement({ name: 'tournament-event-results', data }),
    ).toBe(false);
    expect(shouldCompleteTournamentJobOnSettlement({ name: 'tournament-points-race', data })).toBe(
      false,
    );
    expect(
      shouldCompleteTournamentJobOnSettlement({
        name: 'tournament-event-picks',
        data: { ...data, source: 'reconcile' },
      }),
    ).toBe(true);
  });

  test('persists a terminal child failure before BullMQ settlement', async () => {
    const persist = mock(async () => true);
    const data = {
      seasonId: 2026,
      seasonCode: '2627',
      eventId: 12,
      source: 'cascade' as const,
      triggeredAt: new Date().toISOString(),
      obligationId: 'obligation-12',
      obligationGeneration: 4,
    };
    const error = new Error('terminal child failure');

    expect(
      await persistTournamentTerminalFailureBeforeSettlement(
        { attemptsMade: 1, opts: { attempts: 3 }, data },
        error,
        persist,
      ),
    ).toBe(false);
    expect(persist).not.toHaveBeenCalled();

    expect(
      await persistTournamentTerminalFailureBeforeSettlement(
        { attemptsMade: 2, opts: { attempts: 3 }, data },
        error,
        persist,
      ),
    ).toBe(true);
    expect(persist).toHaveBeenCalledWith({
      obligationId: 'obligation-12',
      generation: 4,
      error,
    });
  });
});
