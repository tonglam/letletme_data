import { describe, expect, test } from 'bun:test';

import { assertCriticalCoverage, parseLcov } from '../../scripts/check-critical-coverage';

describe('critical coverage gate', () => {
  test('counts executable DA lines instead of comments and type-only lines', () => {
    const records = parseLcov(`
SF:src/critical.ts
FNF:2
FNH:1
DA:10,1
DA:11,0
LF:99
LH:98
end_of_record
`);
    expect(records.get('src/critical.ts')).toMatchObject({
      executableLines: 2,
      coveredExecutableLines: 1,
      functionsFound: 2,
      functionsHit: 1,
    });
  });

  test('fails a gate when a critical module is missing or below threshold', () => {
    const records = parseLcov('SF:src/other.ts\nFNF:1\nFNH:1\nDA:1,1\nend_of_record\n');
    expect(() =>
      assertCriticalCoverage(records, [
        {
          name: 'critical fixture',
          file: 'src/critical.ts',
          minimumLines: 80,
          minimumFunctions: 75,
        },
      ]),
    ).toThrow('missing src/critical.ts');
  });
});
