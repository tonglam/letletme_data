import { describe, expect, test } from 'bun:test';

import { postgresTimestampParameter } from '../../src/services/live-publication-v2-checkpoint.service';

const checkpointServiceSource = await Bun.file(
  'src/services/live-publication-v2-checkpoint.service.ts',
).text();

describe('Live Points V2 checkpoint timestamp parameters', () => {
  test('uses an ISO string for raw SQL timestamp bindings', () => {
    expect(postgresTimestampParameter(new Date('2026-08-30T19:09:28.441Z'))).toBe(
      '2026-08-30T19:09:28.441Z',
    );
  });

  test('rejects invalid timestamps before constructing a checkpoint query', () => {
    expect(() => postgresTimestampParameter(new Date('invalid'))).toThrow(
      'PostgreSQL timestamp parameter is invalid',
    );
  });

  test('casts checkpoint chip comparisons to the competition enum safely', () => {
    expect(checkpointServiceSource).toContain('::competition.chip');
    const competitionChipValues = ['n/a', 'wildcard', 'freehit', 'bboost', '3xc', 'manager'];
    expect(checkpointServiceSource).toContain(
      competitionChipValues.map((chip) => `'${chip}'`).join(', '),
    );
  });
});
