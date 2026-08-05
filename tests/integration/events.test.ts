import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();
import { beforeAll, describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';
import { eventRepository } from '../../src/repositories/events';
import { getCurrentEvent, getNextEvent, syncEvents } from '../../src/services/events.service';
import type { Event } from '../../src/types';

describe('Events Integration Tests', () => {
  beforeAll(async () => {
    // Sync events once for all tests
    await syncEvents();
  });

  describe('External Data Integration', () => {
    test('should preserve the current or preseason next event marker', async () => {
      const currentEvent = await eventRepository.findCurrent();
      if (currentEvent) {
        expect(currentEvent.isCurrent).toBe(true);
        return;
      }

      const nextEvent = await eventRepository.findNext();
      expect(nextEvent).toBeDefined();
      expect(nextEvent?.isNext).toBe(true);
      expect(nextEvent?.finished).toBe(false);
    });

    test('should save next event to database when FPL marks one', async () => {
      // End of season: bootstrap may have is_current=GW38 finished and no is_next.
      const nextEvent = await eventRepository.findNext();
      if (!nextEvent) {
        const current = await eventRepository.findCurrent();
        expect(current?.finished).toBe(true);
        return;
      }
      expect(nextEvent.isNext).toBe(true);
    });

    test('should have valid event structure', async () => {
      const event = (await eventRepository.findCurrent()) ?? (await eventRepository.findNext());
      expect(event).toBeDefined();
      expect(typeof event?.id).toBe('number');
      expect(typeof event?.name).toBe('string');
      expect(typeof event?.finished).toBe('boolean');
    });
  });

  describe('Service Layer Integration', () => {
    test('should get the current event when FPL marks one', async () => {
      const currentEvent = await getCurrentEvent();
      if (currentEvent) {
        expect(currentEvent.isCurrent).toBe(true);
        return;
      }

      const nextEvent = await getNextEvent();
      expect(nextEvent?.isNext).toBe(true);
    });

    test('should get next event when FPL marks one', async () => {
      const nextEvent = await getNextEvent();
      if (!nextEvent) {
        const current = await getCurrentEvent();
        expect(current?.finished).toBe(true);
        return;
      }
      expect(nextEvent.isNext).toBe(true);
    });

    test('should sync events successfully', async () => {
      const result = await syncEvents();
      expect(result.count).toBeGreaterThan(0);
      expect(result.errors).toBeGreaterThanOrEqual(0);
    });

    test('clears final live authority when a reused event receives a new deadline', async () => {
      const client = await getDbClient();
      const [original] = await client<
        Array<{
          id: number;
          name: string;
          deadlineTime: Date | null;
          averageEntryScore: number | null;
          finished: boolean;
          dataChecked: boolean;
          highestScoringEntry: number | null;
          deadlineTimeEpoch: number | null;
          deadlineTimeGameOffset: number | null;
          highestScore: number | null;
          isPrevious: boolean;
          isCurrent: boolean;
          isNext: boolean;
          cupLeagueCreate: boolean;
          h2hKoMatchesCreated: boolean;
          chipPlays: unknown;
          mostSelected: number | null;
          mostTransferredIn: number | null;
          topElement: number | null;
          topElementInfo: unknown;
          transfersMade: number | null;
          mostCaptained: number | null;
          mostViceCaptained: number | null;
          liveSnapshotFinalizedAt: Date | null;
          updatedAt: Date | null;
        }>
      >`
        SELECT
          id,
          name,
          deadline_time AS "deadlineTime",
          average_entry_score AS "averageEntryScore",
          finished,
          data_checked AS "dataChecked",
          highest_scoring_entry AS "highestScoringEntry",
          deadline_time_epoch AS "deadlineTimeEpoch",
          deadline_time_game_offset AS "deadlineTimeGameOffset",
          highest_score AS "highestScore",
          is_previous AS "isPrevious",
          is_current AS "isCurrent",
          is_next AS "isNext",
          cup_league_create AS "cupLeagueCreate",
          h2h_ko_matches_created AS "h2hKoMatchesCreated",
          chip_plays AS "chipPlays",
          most_selected AS "mostSelected",
          most_transferred_in AS "mostTransferredIn",
          top_element AS "topElement",
          top_element_info AS "topElementInfo",
          transfers_made AS "transfersMade",
          most_captained AS "mostCaptained",
          most_vice_captained AS "mostViceCaptained",
          live_snapshot_finalized_at AS "liveSnapshotFinalizedAt",
          updated_at AS "updatedAt"
        FROM events
        WHERE id = 38
      `;
      expect(original).toBeDefined();
      if (!original) return;

      const marker = '2026-08-04T00:00:00Z';
      const replacementDeadline = '2027-08-20T17:30:00Z';
      await client`
        UPDATE events
        SET live_snapshot_finalized_at = ${marker}::timestamptz
        WHERE id = ${original.id}
      `;

      try {
        await eventRepository.upsertBatch([
          {
            ...original,
            deadlineTime: replacementDeadline,
            chipPlays: original.chipPlays,
            topElementInfo: original.topElementInfo,
          } as unknown as Event,
        ]);
        const [current] = await client<Array<{ finalizedAt: Date | null }>>`
          SELECT live_snapshot_finalized_at AS "finalizedAt"
          FROM events
          WHERE id = ${original.id}
        `;
        expect(current?.finalizedAt).toBeNull();
      } finally {
        await client`
          UPDATE events
          SET deadline_time = ${original.deadlineTime},
              updated_at = ${original.updatedAt},
              live_snapshot_finalized_at = ${original.liveSnapshotFinalizedAt}
          WHERE id = ${original.id}
        `;
      }
    });
  });
});
