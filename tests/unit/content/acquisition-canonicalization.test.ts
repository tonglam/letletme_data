import { describe, expect, test } from 'bun:test';

import {
  canonicalJson,
  canonicalizeTranscriptSegments,
  normalizeCanonicalText,
  transcriptSegmentsHash,
} from '../../../src/content/acquisition/canonicalization';

describe('Briefing acquisition canonicalization', () => {
  test('normalizes Unicode text and transcript timing deterministically', () => {
    const segments = canonicalizeTranscriptSegments([
      { text: ' Hello \n world\u00a0 ', offsetSeconds: 0.88, durationSeconds: 6.08 },
      { text: 'Second\tline', offsetSeconds: 6.96, durationSeconds: 6.08 },
    ]);
    expect(segments).toEqual([
      { startMs: 880, endMs: 6960, text: 'Hello world' },
      { startMs: 6960, endMs: 13040, text: 'Second line' },
    ]);
    expect(transcriptSegmentsHash(segments)).toBe(
      'ea773175ebe6921606539de46dc8da852cb56f40180b8db0a232fa2f69d84df9',
    );
  });

  test('sorts object keys without reordering arrays', () => {
    expect(canonicalJson({ z: 1, a: [{ z: 'last', a: 'first' }, 2] })).toBe(
      '{"a":[{"a":"first","z":"last"},2],"z":1}',
    );
  });

  test('uses NFC and a single ASCII space for all whitespace runs', () => {
    expect(normalizeCanonicalText('Cafe\u0301\r\n\u00a0briefing')).toBe('Café briefing');
  });
});
