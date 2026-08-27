import { describe, expect, test } from 'bun:test';

import { parseStrictBooleanEnvValue, parseStrictIntegerEnvValue } from '../../src/utils/config';
import { parseStrictNumberEnv } from '../../src/content/config';

describe('strict runtime configuration parsers', () => {
  test('accepts documented boolean spellings and rejects typos', () => {
    expect(parseStrictBooleanEnvValue('true', false, 'FLAG')).toBe(true);
    expect(parseStrictBooleanEnvValue(' OFF ', true, 'FLAG')).toBe(false);
    expect(parseStrictBooleanEnvValue(undefined, true, 'FLAG')).toBe(true);
    expect(() => parseStrictBooleanEnvValue('truthy', false, 'FLAG')).toThrow(
      'FLAG must be a boolean',
    );
  });

  test('accepts only bounded safe integers', () => {
    expect(parseStrictIntegerEnvValue(' 42 ', 1, 1, 100, 'COUNT')).toBe(42);
    expect(parseStrictIntegerEnvValue(undefined, 7, 1, 100, 'COUNT')).toBe(7);
    for (const value of ['NaN', 'Infinity', '1.5', '1e2', '0x10', '101']) {
      expect(() => parseStrictIntegerEnvValue(value, 1, 1, 100, 'COUNT')).toThrow('COUNT');
    }
  });

  test('allows bounded decimal lane multipliers without Number coercion', () => {
    expect(parseStrictNumberEnv('0.5', 1, 0.1, 10, 'MULTIPLIER')).toBe(0.5);
    expect(parseStrictNumberEnv(undefined, 1, 0.1, 10, 'MULTIPLIER')).toBe(1);
    expect(() => parseStrictNumberEnv('1e2', 1, 0.1, 10, 'MULTIPLIER')).toThrow('MULTIPLIER');
    expect(() => parseStrictNumberEnv('0.01', 1, 0.1, 10, 'MULTIPLIER')).toThrow('MULTIPLIER');
  });
});
