import { describe, expect, test } from 'bun:test';

import {
  transformEventLiveExplains,
  transformSingleEventLiveExplain,
} from '../../src/transformers/event-live-explains';
import {
  rawExplainElementsFixture,
  transformedExplainsFixture,
} from '../fixtures/event-live-explains.fixtures';

describe('Event Live Explains - Transformer', () => {
  test('should transform single element explain correctly', () => {
    const eventId = 99;
    const record = transformSingleEventLiveExplain(eventId, rawExplainElementsFixture[0]);
    expect(record).toEqual(transformedExplainsFixture[0]);
  });

  test('should transform multiple explains correctly', () => {
    const eventId = 99;
    const records = transformEventLiveExplains(eventId, rawExplainElementsFixture);
    expect(records).toHaveLength(2);
    expect(records).toEqual(transformedExplainsFixture);
  });

  test('should handle empty explains array gracefully', () => {
    const eventId = 99;
    const emptyEl = { ...rawExplainElementsFixture[0], explain: [] };
    const rec = transformSingleEventLiveExplain(eventId, emptyEl);
    expect(rec.minutes).toBe(90);
    expect(rec.minutesPoints).toBeNull();
    expect(rec.goalsScored).toBe(0);
    expect(rec.goalsScoredPoints).toBe(0);
  });
});
