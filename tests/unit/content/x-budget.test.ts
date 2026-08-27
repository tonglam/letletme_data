import { expect, test } from 'bun:test';

import { loadBriefingManifest } from '../../../src/content/acquisition/acquisition-manifest';
import { compileXBudgetPolicy } from '../../../src/content/acquisition/x-budget';

test('scales recurring lane caps without changing global provider guards', async () => {
  const bundle = await loadBriefingManifest();
  const base = compileXBudgetPolicy({
    coverage: bundle.coverage,
    globalRolling24hLimit: 2_400,
    final90Rolling90mLimit: 300,
    identityRolling24hLimit: 100,
  });
  const relaxed = compileXBudgetPolicy({
    coverage: bundle.coverage,
    globalRolling24hLimit: 2_400,
    final90Rolling90mLimit: 300,
    identityRolling24hLimit: 100,
    laneCapMultiplier: 10,
  });

  expect(base.laneCapMultiplier).toBe(1);
  expect(relaxed.laneCapMultiplier).toBe(10);
  expect(relaxed.laneCaps.NORMAL.CREATOR).toBe(base.laneCaps.NORMAL.CREATOR * 10);
  expect(relaxed.laneCaps.NORMAL.LONGFORM).toBe(base.laneCaps.NORMAL.LONGFORM * 10);
  expect(relaxed.laneCaps.FINAL90.OFFICIAL).toBe(base.laneCaps.FINAL90.OFFICIAL * 10);
  expect(relaxed.globalRolling24hLimit).toBe(2_400);
  expect(relaxed.final90Rolling90mLimit).toBe(300);
});

test('bounds fractional lane multipliers and call budgets', async () => {
  const bundle = await loadBriefingManifest();
  const input = {
    coverage: bundle.coverage,
    globalRolling24hLimit: 2_400,
    final90Rolling90mLimit: 300,
    identityRolling24hLimit: 100,
  };

  expect(() => compileXBudgetPolicy({ ...input, laneCapMultiplier: 0.09 })).toThrow(
    'CONTENT_X_LANE_CAP_MULTIPLIER must be between 0.1 and 10',
  );
  const fractional = compileXBudgetPolicy({ ...input, laneCapMultiplier: 0.5 });
  expect(fractional.laneCapMultiplier).toBe(0.5);
  expect(fractional.laneCaps.NORMAL.CREATOR).toBe(
    Math.floor(bundle.coverage.xLaneCallCaps.NORMAL.CREATOR * 0.5),
  );
  expect(
    compileXBudgetPolicy({
      ...input,
      globalRolling24hLimit: 0,
      final90Rolling90mLimit: 0,
      identityRolling24hLimit: 0,
    }),
  ).toMatchObject({ globalRolling24hLimit: 0, final90Rolling90mLimit: 0 });
  expect(() =>
    compileXBudgetPolicy({ ...input, laneCapMultiplier: Number.MAX_SAFE_INTEGER }),
  ).toThrow('CONTENT_X_LANE_CAP_MULTIPLIER must be between 0.1 and 10');
});
