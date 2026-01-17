import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { entryInfos } from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import { syncEntryInfo } from '../../src/services/entry-info.service';

// Use a real FPL entry ID for integration testing
const TEST_ENTRY_ID = 15702;

describe('Entry Infos Integration Tests', () => {
  test('should sync entry info from FPL API', async () => {
    const res = await syncEntryInfo(TEST_ENTRY_ID);
    expect(res).toBeDefined();
    expect(res.id).toBe(TEST_ENTRY_ID);

    const db = await getDb();
    const result = await db.select().from(entryInfos).where(eq(entryInfos.id, TEST_ENTRY_ID));
    const row = result[0];
    expect(row).toBeDefined();
    expect(row?.id).toBe(TEST_ENTRY_ID);
    expect(typeof row?.entryName).toBe('string');
    expect((row?.entryName || '').length).toBeGreaterThan(0);
    expect(typeof row?.playerName).toBe('string');
    // Monetary fields stored as tenths (ints). bank may be null for some entries.
    if (row?.bank !== null && row?.bank !== undefined) {
      expect(typeof row.bank).toBe('number');
    }
  });

  test('should maintain usedEntryNames with at least current name', async () => {
    const db = await getDb();
    const result = await db.select().from(entryInfos).where(eq(entryInfos.id, TEST_ENTRY_ID));
    const row = result[0];
    expect(row).toBeDefined();
    const names = row?.usedEntryNames || [];
    expect(Array.isArray(names)).toBe(true);
    if (row?.entryName) {
      expect(names).toContain(row.entryName);
    }
  });

  test('should update last_* fields to previous values on subsequent sync', async () => {
    // First, read current snapshot
    const db = await getDb();
    const beforeResult = await db.select().from(entryInfos).where(eq(entryInfos.id, TEST_ENTRY_ID));
    const before = beforeResult[0];
    await syncEntryInfo(TEST_ENTRY_ID);
    const afterResult = await db.select().from(entryInfos).where(eq(entryInfos.id, TEST_ENTRY_ID));
    const after = afterResult[0];

    expect(after).toBeDefined();
    // lastTeamValue should equal prior teamValue (or 0 if no prior)
    const expectedLastTeam = before?.teamValue ?? 0;
    expect(after?.lastTeamValue).toBe(expectedLastTeam);
    // lastOverallPoints/Rank reflect previous overall snapshot (or 0 if no prior)
    const expectedLastPts = before?.overallPoints ?? 0;
    const expectedLastRank = before?.overallRank ?? 0;
    expect(after?.lastOverallPoints).toBe(expectedLastPts);
    expect(after?.lastOverallRank).toBe(expectedLastRank);
    const expectedLastBank = before?.bank ?? 0;
    expect(after?.lastBank).toBe(expectedLastBank);
  });
});
