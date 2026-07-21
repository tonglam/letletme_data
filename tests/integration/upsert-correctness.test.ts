import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { PlayerValue } from '../../src/domain/player-values';
import { getDbClient } from '../../src/db/singleton';
import { createEntryEventTransfersRepository } from '../../src/repositories/entry-event-transfers';
import { createPlayerValuesRepository } from '../../src/repositories/player-values';
import type { RawFPLEntryTransfer } from '../../src/types';

/**
 * FP-10 (H5, H6) integration: verify the upsert fixes against a real
 * database — the element_in_played COALESCE survives re-syncs, and
 * concurrent player_values batches racing on the same
 * (element_id, change_date) both succeed instead of deadlocking the job
 * on a unique-violation.
 */

const TEAM_ID = 990001;
const ENTRY_ID = 99000401;
const PLAYER_IN = 990011;
const PLAYER_OUT = 990012;
const VALUE_PLAYER_A = 990013;
const VALUE_PLAYER_B = 990014;
const EVENT_ID = 10;
const CHANGE_DATE = '20260717';

async function db() {
  return getDbClient();
}
const transfersRepository = createEntryEventTransfersRepository();
const playerValuesRepository = createPlayerValuesRepository();

function buildPlayerValue(elementId: number, value: number): PlayerValue {
  return {
    elementId,
    webName: `Player ${elementId}`,
    elementType: 1,
    elementTypeName: 'GKP',
    eventId: 1,
    teamId: TEAM_ID,
    teamName: 'FP-10 Team',
    teamShortName: 'FPT',
    value,
    changeDate: CHANGE_DATE,
    changeType: 'Rise',
    lastValue: value - 1,
  } as PlayerValue;
}

const TRANSFER: RawFPLEntryTransfer = {
  element_in: PLAYER_IN,
  element_in_cost: 55,
  element_out: PLAYER_OUT,
  element_out_cost: 60,
  entry: ENTRY_ID,
  event: EVENT_ID,
  time: '2026-07-17T10:00:00Z',
};

beforeAll(async () => {
  await (
    await db()
  ).begin(async (tx) => {
    // Events may already exist in a prod-shaped database — never overwrite
    await tx`
      INSERT INTO events (id, name) VALUES
        (${EVENT_ID}, 'FP-10 GW'),
        (${EVENT_ID - 1}, 'FP-10 Previous GW'),
        (1, 'FP-10 GW 1')
      ON CONFLICT (id) DO NOTHING
    `;
    await tx`
      INSERT INTO teams (id, code, name, short_name, strength, pulse_id)
      VALUES (${TEAM_ID}, ${TEAM_ID}, 'FP-10 Team', 'FPT', 3, ${TEAM_ID})
      ON CONFLICT (id) DO NOTHING
    `;
    await tx`
      INSERT INTO players ${tx(
        [PLAYER_IN, PLAYER_OUT, VALUE_PLAYER_A, VALUE_PLAYER_B].map((id) => ({
          id,
          code: id,
          type: 1,
          team_id: TEAM_ID,
          web_name: `Player ${id}`,
        })),
      )}
      ON CONFLICT (id) DO NOTHING
    `;
    await tx`
      INSERT INTO entry_infos (id, entry_name, player_name)
      VALUES (${ENTRY_ID}, 'FP-10 Team Name', 'FP-10 Manager')
      ON CONFLICT (id) DO NOTHING
    `;
  });
});

afterAll(async () => {
  await (
    await db()
  ).begin(async (tx) => {
    await tx`DELETE FROM player_values WHERE element_id IN (${VALUE_PLAYER_A}, ${VALUE_PLAYER_B})`;
    await tx`DELETE FROM entry_event_transfers WHERE entry_id = ${ENTRY_ID}`;
    await tx`DELETE FROM players WHERE id IN (${PLAYER_IN}, ${PLAYER_OUT}, ${VALUE_PLAYER_A}, ${VALUE_PLAYER_B})`;
    await tx`DELETE FROM entry_infos WHERE id = ${ENTRY_ID}`;
    await tx`DELETE FROM teams WHERE id = ${TEAM_ID}`;
  });
});

describe('entry-event-transfers element_in_played (H5)', () => {
  test('re-sync with no computed value never nulls the stored flag', async () => {
    // Given: a transfer row whose computed played-flag is stored
    await transfersRepository.replaceForEvent(ENTRY_ID, EVENT_ID, [TRANSFER], undefined, {
      elementInPlayed: true,
    });
    const initial = await (await db())<{ element_in_played: boolean | null }[]>`
      SELECT element_in_played FROM entry_event_transfers
      WHERE entry_id = ${ENTRY_ID} AND event_id = ${EVENT_ID}
    `;
    expect(initial[0]?.element_in_played).toBe(true);

    // When: the same event re-syncs without a computed value (null)
    await transfersRepository.replaceForEvent(ENTRY_ID, EVENT_ID, [TRANSFER], undefined, {
      elementInPlayed: null,
    });

    // Then: the stored flag survives
    const afterNull = await (await db())<{ element_in_played: boolean | null }[]>`
      SELECT element_in_played FROM entry_event_transfers
      WHERE entry_id = ${ENTRY_ID} AND event_id = ${EVENT_ID}
    `;
    expect(afterNull[0]?.element_in_played).toBe(true);

    // And: a fresh computed value still overwrites
    await transfersRepository.replaceForEvent(ENTRY_ID, EVENT_ID, [TRANSFER], undefined, {
      elementInPlayed: false,
    });
    const afterUpdate = await (await db())<{ element_in_played: boolean | null }[]>`
      SELECT element_in_played FROM entry_event_transfers
      WHERE entry_id = ${ENTRY_ID} AND event_id = ${EVENT_ID}
    `;
    expect(afterUpdate[0]?.element_in_played).toBe(false);
  });

  test('all mode stores and idempotently refreshes complete transfer history', async () => {
    const previousEventTransfer: RawFPLEntryTransfer = {
      ...TRANSFER,
      event: EVENT_ID - 1,
      time: '2026-07-10T10:00:00Z',
    };
    const secondSameEventTransfer: RawFPLEntryTransfer = {
      ...TRANSFER,
      element_in: PLAYER_OUT,
      element_out: PLAYER_IN,
      time: '2026-07-17T11:00:00Z',
    };
    const history = [previousEventTransfer, TRANSFER, secondSameEventTransfer];

    await transfersRepository.replaceForEvent(ENTRY_ID, EVENT_ID, history, undefined, {
      elementInPlayed: true,
      syncMode: 'all',
    });

    const firstSync = await (await db())<
      { event_id: number; element_in_id: number; element_in_played: boolean | null }[]
    >`
      SELECT event_id, element_in_id, element_in_played
      FROM entry_event_transfers
      WHERE entry_id = ${ENTRY_ID}
      ORDER BY transfer_time
    `;
    expect(firstSync).toHaveLength(3);
    expect(firstSync.map((row) => row.event_id)).toEqual([EVENT_ID - 1, EVENT_ID, EVENT_ID]);
    expect(firstSync.filter((row) => row.event_id === EVENT_ID)).toHaveLength(2);

    // A later raw refresh has no computed played flag. Signature matching must
    // preserve the prior derived values without duplicating any history rows.
    await transfersRepository.replaceForEvent(ENTRY_ID, EVENT_ID, history, undefined, {
      elementInPlayed: null,
      syncMode: 'all',
    });
    const secondSync = await (await db())<
      { event_id: number; element_in_played: boolean | null }[]
    >`
      SELECT event_id, element_in_played
      FROM entry_event_transfers
      WHERE entry_id = ${ENTRY_ID}
      ORDER BY transfer_time
    `;
    expect(secondSync).toHaveLength(3);
    expect(
      secondSync.filter((row) => row.event_id === EVENT_ID).every((row) => row.element_in_played),
    ).toBe(true);
  });
});

describe('player-values concurrent insert race (H6)', () => {
  test('overlapping batches both succeed; each (element, date) stored once', async () => {
    const batchA = [buildPlayerValue(VALUE_PLAYER_A, 50), buildPlayerValue(VALUE_PLAYER_B, 100)];
    const batchB = [buildPlayerValue(VALUE_PLAYER_A, 51), buildPlayerValue(VALUE_PLAYER_B, 101)];

    const [resultA, resultB] = await Promise.all([
      playerValuesRepository.insertBatch(batchA),
      playerValuesRepository.insertBatch(batchB),
    ]);

    // Both batches resolved; winners sum to the distinct keys
    expect(resultA.count + resultB.count).toBe(2);

    const stored = await (await db())<{ count: string }[]>`
      SELECT count(*) as count FROM player_values
      WHERE element_id IN (${VALUE_PLAYER_A}, ${VALUE_PLAYER_B}) AND change_date = ${CHANGE_DATE}
    `;
    expect(Number(stored[0]?.count)).toBe(2);

    // Idempotent re-run of the same day inserts nothing
    const rerun = await playerValuesRepository.insertBatch(batchA);
    expect(rerun.count).toBe(0);
  });
});
