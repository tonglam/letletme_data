import { describe, expect, mock, test } from 'bun:test';

import { collectEntryCupResults } from '../../src/services/tournament-event-cup-results.service';

describe('tournament entry cup collection', () => {
  test('counts absent cup data as skipped rather than failed', async () => {
    const getEntryCup = mock(async () => null);

    const result = await collectEntryCupResults([123], 38, { getEntryCup });

    expect(result.records).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
  });

  test('keeps unexpected upstream failures visible', async () => {
    const getEntryCup = mock(async () => {
      throw new Error('upstream unavailable');
    });

    const result = await collectEntryCupResults([123], 38, { getEntryCup });

    expect(result.records).toEqual([]);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(1);
  });
});
