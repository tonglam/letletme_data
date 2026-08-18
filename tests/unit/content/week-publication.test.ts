import { describe, expect, test } from 'bun:test';
import fixture from '../../fixtures/content/week-publication-v1.json';

import {
  assertWeekPublication,
  serializeWeekPublication,
  validateWeekLocalePair,
  weekPublicationBytes,
  weekPublicationSha256,
  type WeekPublicationEnvelope,
} from '../../../src/content/contracts/week-publication';

const english = fixture as unknown as WeekPublicationEnvelope;
const chinese: WeekPublicationEnvelope = {
  ...english,
  locale: 'zh-CN',
};

describe('Week publication contract', () => {
  test('accepts the canonical fixture and produces stable bytes/hash', () => {
    assertWeekPublication(english);
    expect(serializeWeekPublication(english)).toBe(serializeWeekPublication(english));
    expect(weekPublicationBytes(english)).toBeGreaterThan(2);
    expect(weekPublicationSha256(english)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('requires matching locale story order and revision', () => {
    validateWeekLocalePair(english, chinese);
    expect(() => validateWeekLocalePair(english, { ...chinese, revision: 2 })).toThrow(
      'Week locales must share a revision',
    );
  });

  test('rejects a validUntil after the target deadline', () => {
    expect(() =>
      assertWeekPublication({
        ...english,
        validUntil: '2026-08-22T17:30:00.000Z',
      }),
    ).toThrow('validUntil exceeds deadline');
  });

  test('rejects non-http source links before publication', () => {
    expect(() =>
      assertWeekPublication({
        ...english,
        featured: [
          {
            id: 'story-1',
            slug: 'unsafe',
            storyRevision: 1,
            title: 'Unsafe link',
            summary: 'Not publishable',
            sourceUrl: 'javascript:alert(1)',
          },
        ],
      }),
    ).toThrow('sourceUrl is invalid');
  });
});
