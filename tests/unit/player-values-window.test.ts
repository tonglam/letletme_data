import { describe, expect, test } from 'bun:test';

import {
  PLAYER_VALUES_WINDOW_ATTEMPTS,
  PLAYER_VALUES_WINDOW_BACKOFF_MS,
  shouldRetryPlayerValuesNoChange,
} from '../../src/domain/player-values-window';

describe('player values polling window', () => {
  test('keeps no-change attempts retryable through 07:04 UTC+8', () => {
    expect(shouldRetryPlayerValuesNoChange('20260829', new Date('2026-08-28T22:55:00.000Z'))).toBe(
      true,
    );
    expect(shouldRetryPlayerValuesNoChange('20260829', new Date('2026-08-28T23:04:59.000Z'))).toBe(
      true,
    );
  });

  test('lets the 07:05 attempt settle with no changes', () => {
    expect(shouldRetryPlayerValuesNoChange('20260829', new Date('2026-08-28T23:05:00.000Z'))).toBe(
      false,
    );
    expect(shouldRetryPlayerValuesNoChange('20260828', new Date('2026-08-28T23:05:00.000Z'))).toBe(
      false,
    );
  });

  test('matches one fixed-delay attempt per minute in the inclusive window', () => {
    expect(PLAYER_VALUES_WINDOW_ATTEMPTS).toBe(11);
    expect(PLAYER_VALUES_WINDOW_BACKOFF_MS).toBe(60_000);
  });
});
