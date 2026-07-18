import { describe, expect, test } from 'bun:test';

import {
  parseChipPlays,
  parseTopElementInfo,
} from '../../src/services/event-overall-results.service';

describe('event-overall-results service', () => {
  describe('parseChipPlays', () => {
    test('keeps valid chip plays', () => {
      const result = parseChipPlays([
        { chip_name: 'wildcard', num_played: 1234 },
        { chip_name: 'bench_boost', num_played: 567 },
      ]);

      expect(result).toEqual([
        { chipName: 'wildcard', numberPlayed: 1234 },
        { chipName: 'bench_boost', numberPlayed: 567 },
      ]);
    });

    test('drops entries with missing chip name', () => {
      const result = parseChipPlays([{ num_played: 100 }]);
      expect(result).toEqual([]);
    });

    test('drops entries with non-numeric count', () => {
      const result = parseChipPlays([{ chip_name: 'wildcard', num_played: 'lots' }]);
      expect(result).toEqual([]);
    });

    test('returns empty array for non-array input', () => {
      expect(parseChipPlays([])).toEqual([]);
    });
  });

  describe('parseTopElementInfo', () => {
    test('parses element + points', () => {
      const result = parseTopElementInfo({ element: 234, points: 15 });
      expect(result).toEqual({ element: 234, points: 15 });
    });

    test('falls back to id when element is missing', () => {
      const result = parseTopElementInfo({ id: 345, points: 9 });
      expect(result).toEqual({ element: 345, points: 9 });
    });

    test('returns null for missing points', () => {
      expect(parseTopElementInfo({ element: 234 })).toBeNull();
    });

    test('returns null for non-object input', () => {
      expect(parseTopElementInfo(null)).toBeNull();
      expect(parseTopElementInfo('not an object')).toBeNull();
    });
  });
});
