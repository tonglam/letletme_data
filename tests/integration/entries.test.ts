import { describe, expect, test } from 'bun:test';

import { entryInfos } from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import { syncEntryInfo } from '../../src/services/entry-info.service';

describe('Entries Integration Tests', () => {
  const TEST_ENTRY_ID = 15702; // Using a known entry ID

  describe('Entry Info Sync', () => {
    test('should sync entry info from FPL API', async () => {
      const result = await syncEntryInfo(TEST_ENTRY_ID);

      expect(result).toBeDefined();
      expect(result.id).toBe(TEST_ENTRY_ID);
      expect(typeof result.entryName).toBe('string');
      expect(typeof result.playerName).toBe('string');
    });

    test('should store entry info in database', async () => {
      await syncEntryInfo(TEST_ENTRY_ID);

      const db = await getDb();
      const infos = await db.select().from(entryInfos);

      expect(infos.length).toBeGreaterThan(0);

      const info = infos.find((i) => i.id === TEST_ENTRY_ID);
      expect(info).toBeDefined();
      expect(info?.entryName).toBeTypeOf('string');
      expect(info?.playerName).toBeTypeOf('string');
    });
  });

  describe('Data Validation', () => {
    test('should have valid entry info structure', async () => {
      const result = await syncEntryInfo(TEST_ENTRY_ID);

      expect(result.id).toBeGreaterThan(0);
      expect(result.entryName.length).toBeGreaterThan(0);
      expect(result.playerName.length).toBeGreaterThan(0);

      // Team value should be reasonable (in tenths)
      if (result.teamValue !== null) {
        expect(result.teamValue).toBeGreaterThan(800); // Min 80.0
        expect(result.teamValue).toBeLessThan(1500); // Max 150.0
      }
    });

    test('should maintain entry name history', async () => {
      await syncEntryInfo(TEST_ENTRY_ID);

      const db = await getDb();
      const infos = await db.select().from(entryInfos);
      const info = infos.find((i) => i.id === TEST_ENTRY_ID);

      expect(info).toBeDefined();
      expect(Array.isArray(info?.usedEntryNames)).toBe(true);

      if (info && info.usedEntryNames) {
        expect(info.usedEntryNames.length).toBeGreaterThan(0);
        expect(info.usedEntryNames).toContain(info.entryName);
      }
    });

    test('should track last values correctly', async () => {
      const db = await getDb();
      const beforeResult = await db.select().from(entryInfos);
      const before = beforeResult.find((i) => i.id === TEST_ENTRY_ID);

      await syncEntryInfo(TEST_ENTRY_ID);

      const afterResult = await db.select().from(entryInfos);
      const after = afterResult.find((i) => i.id === TEST_ENTRY_ID);

      if (before && after) {
        // Last values should reflect previous sync
        const expectedLastTeam = before.teamValue ?? 0;
        expect(after.lastTeamValue).toBe(expectedLastTeam);
      }
    });
  });

  describe('Rankings and Points', () => {
    test('should have valid ranking data', async () => {
      const result = await syncEntryInfo(TEST_ENTRY_ID);

      if (result.overallRank !== null) {
        expect(result.overallRank).toBeGreaterThan(0);
      }

      if (result.overallPoints !== null) {
        expect(result.overallPoints).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('Performance', () => {
    test('should sync entry efficiently', async () => {
      const startTime = performance.now();
      await syncEntryInfo(TEST_ENTRY_ID);
      const endTime = performance.now();

      const duration = endTime - startTime;
      expect(duration).toBeLessThan(30000); // 30 seconds
    });
  });
});
