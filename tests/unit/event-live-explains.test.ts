import { describe, expect, test } from 'bun:test';

import { totalPoints } from '../../src/domain/event-live-explains';
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

describe('Event Live Explains - totalPoints', () => {
  test('sums all scoring components treating null as zero', () => {
    expect(
      totalPoints({
        eventId: 1,
        elementId: 10,
        bonus: 3,
        minutes: 90,
        minutesPoints: 2,
        goalsScored: 1,
        goalsScoredPoints: 5,
        assists: null,
        assistsPoints: null,
        cleanSheets: 1,
        cleanSheetsPoints: 4,
        goalsConceded: 0,
        goalsConcededPoints: 0,
        ownGoals: null,
        ownGoalsPoints: null,
        penaltiesSaved: null,
        penaltiesSavedPoints: null,
        penaltiesMissed: null,
        penaltiesMissedPoints: null,
        yellowCards: null,
        yellowCardsPoints: null,
        redCards: null,
        redCardsPoints: null,
        saves: null,
        savesPoints: null,
      }),
    ).toBe(14);
  });

  test('returns zero when every component is null', () => {
    expect(
      totalPoints({
        eventId: 1,
        elementId: 10,
        bonus: null,
        minutes: null,
        minutesPoints: null,
        goalsScored: null,
        goalsScoredPoints: null,
        assists: null,
        assistsPoints: null,
        cleanSheets: null,
        cleanSheetsPoints: null,
        goalsConceded: null,
        goalsConcededPoints: null,
        ownGoals: null,
        ownGoalsPoints: null,
        penaltiesSaved: null,
        penaltiesSavedPoints: null,
        penaltiesMissed: null,
        penaltiesMissedPoints: null,
        yellowCards: null,
        yellowCardsPoints: null,
        redCards: null,
        redCardsPoints: null,
        saves: null,
        savesPoints: null,
      }),
    ).toBe(0);
  });
});
