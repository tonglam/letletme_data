import { afterEach, beforeAll, describe, expect, test } from 'bun:test';

import { playerValuesCache } from '../../src/cache/operations';
import { playerValuesRepository } from '../../src/repositories/player-values';
import {
  getPlayerValues,
  getPlayerValuesAnalytics,
  getPlayerValuesByChangeType,
  getPlayerValuesCount,
  syncCurrentPlayerValues,
} from '../../src/services/player-values.service';
import { logInfo } from '../../src/utils/logger';

describe('Player Values Integration Tests', () => {
  let changeDate: string;

  beforeAll(async () => {
    // Setup - clear cache and generate today's date
    const today = new Date();
    changeDate = today.toISOString().split('T')[0].replace(/-/g, ''); // YYYYMMDD format

    await playerValuesCache.clearByDate(changeDate);
  });

  describe('Daily Sync Integration', () => {
    test('should sync current player values using daily approach', async () => {
      // Clear existing data first
      await playerValuesRepository.deleteByChangeDate(changeDate);

      // This should sync only players with price changes (using our new daily logic)
      const result = await syncCurrentPlayerValues();

      // The result count could be 0 if no prices changed today, which is valid
      expect(result.count).toBeGreaterThanOrEqual(0);
      logInfo('Daily sync completed', { count: result.count });

      if (result.count > 0) {
        // If there were changes, verify they were saved
        const allPlayerValues = await getPlayerValues();
        expect(allPlayerValues.length).toBe(result.count);
        expect(allPlayerValues[0]).toHaveProperty('changeDate');
        expect(allPlayerValues[0].changeDate).toBe(changeDate);
      }
    }, 30000); // Longer timeout for API calls

    test('should handle no price changes scenario', async () => {
      // Run sync again immediately - should detect no new changes
      const result = await syncCurrentPlayerValues();

      // Should return 0 since we just synced and no prices changed in the meantime
      expect(result.count).toBe(0);
      logInfo('No duplicate records created on second sync');
    }, 30000);

    test('should have correct daily cache structure if changes exist', async () => {
      const cachedChanges = await playerValuesCache.getDailyChanges(changeDate);

      if (cachedChanges && cachedChanges.length > 0) {
        expect(Array.isArray(cachedChanges)).toBe(true);
        expect(cachedChanges[0]).toHaveProperty('changeDate');
        expect(cachedChanges[0]).toHaveProperty('changeType');
        logInfo('Daily cache contains price changes', { count: cachedChanges.length });
      } else {
        logInfo('No cached changes found (no price changes today)');
        expect(cachedChanges).toBeNull();
      }
    });
  });

  describe('Service Layer with Daily Data', () => {
    test('should get player values count', async () => {
      const count = await getPlayerValuesCount();
      expect(count).toBeGreaterThanOrEqual(0);
      logInfo('Total player value records', { count });
    });

    test('should get analytics even with minimal data', async () => {
      const analytics = await getPlayerValuesAnalytics();

      expect(analytics).toHaveProperty('totalRisers');
      expect(analytics).toHaveProperty('totalFallers');
      expect(analytics).toHaveProperty('totalStable');
      expect(analytics).toHaveProperty('topRisers');
      expect(analytics).toHaveProperty('topFallers');

      // Values should be >= 0 even if no data
      expect(analytics.totalRisers).toBeGreaterThanOrEqual(0);
      expect(analytics.totalFallers).toBeGreaterThanOrEqual(0);
      expect(analytics.totalStable).toBeGreaterThanOrEqual(0);

      logInfo('Analytics calculated', analytics);
    });

    test('should filter by change type correctly', async () => {
      const increases = await getPlayerValuesByChangeType('Rise');
      const decreases = await getPlayerValuesByChangeType('Faller');
      const stable = await getPlayerValuesByChangeType('Start');

      // All should be arrays (might be empty)
      expect(Array.isArray(increases)).toBe(true);
      expect(Array.isArray(decreases)).toBe(true);
      expect(Array.isArray(stable)).toBe(true);

      logInfo('Change type filtering', {
        rise: increases.length,
        faller: decreases.length,
        start: stable.length,
      });
    });
  });

  describe('Database Operations with Daily Approach', () => {
    test('should handle findLatestForAllPlayers correctly', async () => {
      const latestValues = await playerValuesRepository.findLatestForAllPlayers();

      expect(Array.isArray(latestValues)).toBe(true);
      logInfo('Latest values retrieved', { playersCount: latestValues.length });

      if (latestValues.length > 0) {
        expect(latestValues[0]).toHaveProperty('elementId');
        expect(latestValues[0]).toHaveProperty('value');
        expect(latestValues[0]).toHaveProperty('changeDate');
      }
    });

    test('should handle findByChangeDate correctly', async () => {
      const todaysRecords = await playerValuesRepository.findByChangeDate(changeDate);

      expect(Array.isArray(todaysRecords)).toBe(true);
      logInfo('Records retrieved for date', { changeDate, count: todaysRecords.length });

      if (todaysRecords.length > 0) {
        expect(todaysRecords[0].changeDate).toBe(changeDate);
      }
    });
  });

  describe('Real-world Scenario Testing', () => {
    test('should simulate price change detection', async () => {
      // Get current stored values
      const latestValues = await playerValuesRepository.findLatestForAllPlayers();
      const initialCount = await getPlayerValuesCount();

      logInfo('Starting state', {
        playersWithValues: latestValues.length,
        totalRecords: initialCount,
      });

      // Our daily sync should work correctly regardless of whether prices changed
      const result = await syncCurrentPlayerValues();

      const finalCount = await getPlayerValuesCount();

      logInfo('After sync', { newChanges: result.count, totalRecords: finalCount });

      // Final count should equal initial count plus new changes
      expect(finalCount).toBe(initialCount + result.count);
    }, 30000);

    test('should maintain data integrity across multiple syncs', async () => {
      const beforeCount = await getPlayerValuesCount();

      // Run multiple syncs - should not create duplicates
      await syncCurrentPlayerValues();
      await syncCurrentPlayerValues();
      await syncCurrentPlayerValues();

      const afterCount = await getPlayerValuesCount();

      // Count should remain the same since no new changes
      expect(afterCount).toBe(beforeCount);
      logInfo('No duplicate records created across multiple syncs');
    }, 45000);
  });

  // Inspect DB and Redis after each test
  afterEach(async () => {
    const count = await getPlayerValuesCount();
    // Check today's cache (date-based)
    const today = new Date();
    const todayDate = today.toISOString().split('T')[0].replace(/-/g, '');
    const cachedToday = await playerValuesCache.getByDate(todayDate);
    const cacheCount = cachedToday ? cachedToday.length : 0;
    logInfo('PlayerValues state', { db: count, redis: cacheCount, date: todayDate });
  });
});
