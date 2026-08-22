import { describe, expect, test } from 'bun:test';

import { advanceSeasonLifecycleState } from '../../src/domain/season-lifecycle';

const event = (
  id: number,
  overrides: Partial<{ finished: boolean; dataChecked: boolean; isCurrent: boolean }> = {},
) => ({
  id,
  finished: false,
  dataChecked: false,
  isCurrent: false,
  ...overrides,
});

describe('season lifecycle advancement', () => {
  test('moves preseason to active from official event evidence', () => {
    expect(advanceSeasonLifecycleState('preseason', [event(1, { isCurrent: true })])).toBe(
      'active',
    );
  });

  test('does not regress active or completed lifecycle states', () => {
    expect(advanceSeasonLifecycleState('active', [])).toBe('active');
    expect(advanceSeasonLifecycleState('completed', [])).toBe('completed');
  });

  test('completes only after GW38 is finished and data checked', () => {
    expect(advanceSeasonLifecycleState('active', [event(38, { finished: true })])).toBe('active');
    expect(
      advanceSeasonLifecycleState('active', [event(38, { finished: true, dataChecked: true })]),
    ).toBe('completed');
  });

  test('preserves reference-only and closed seasons', () => {
    const evidence = [
      event(1, { isCurrent: true }),
      event(38, { finished: true, dataChecked: true }),
    ];
    expect(advanceSeasonLifecycleState('reference_only', evidence)).toBe('reference_only');
    expect(advanceSeasonLifecycleState('closed', evidence)).toBe('closed');
  });
});
