import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { isExactFinalLiveMatchCheckpointPair } from '../../src/services/live-match-v2-checkpoint.service';

const revision = 'a'.repeat(64);
const exact = {
  deskState: 'FINALIZED',
  deskGeneration: 12,
  deskRevisions: { fixtureIdentity: { revision } },
  detailState: 'FINALIZED',
  detailObservedDeskGeneration: 12,
  detailFixtureIdentityRevision: revision,
} as const;

describe('Live Matches V2 final checkpoint fence', () => {
  test('bounds every checkpoint transaction to five seconds', () => {
    const source = readFileSync(
      new URL('../../src/services/live-match-v2-checkpoint.service.ts', import.meta.url),
      'utf8',
    );
    expect(source).toMatch(/SET LOCAL statement_timeout = '5s'/);
  });

  test('accepts only the exact final desk/detail revision vector', () => {
    expect(isExactFinalLiveMatchCheckpointPair(exact)).toBe(true);
    expect(
      isExactFinalLiveMatchCheckpointPair({
        ...exact,
        detailObservedDeskGeneration: exact.deskGeneration - 1,
      }),
    ).toBe(false);
    expect(
      isExactFinalLiveMatchCheckpointPair({
        ...exact,
        detailFixtureIdentityRevision: 'b'.repeat(64),
      }),
    ).toBe(false);
    expect(isExactFinalLiveMatchCheckpointPair({ ...exact, detailState: 'PROVISIONAL' })).toBe(
      false,
    );
  });
});
