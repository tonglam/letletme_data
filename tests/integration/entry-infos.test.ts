import { describe, expect, test } from 'bun:test';

import { entryInfoRepository } from '../../src/repositories/entry-infos';
import { getEntryInfo, syncEntryInfo } from '../../src/services/entries.service';

// Use a real FPL entry ID for integration testing
const TEST_ENTRY_ID = 15702;

describe('Entry Infos Integration Tests', () => {
  test('should sync entry info from FPL API', async () => {
    const res = await syncEntryInfo(TEST_ENTRY_ID);
    expect(res).toBeDefined();
    expect(res.id).toBe(TEST_ENTRY_ID);

    const row = await entryInfoRepository.findById(TEST_ENTRY_ID);
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

  test('should retrieve entry info from repository and service', async () => {
    const repoRow = await entryInfoRepository.findById(TEST_ENTRY_ID);
    const svcRow = await getEntryInfo(TEST_ENTRY_ID);
    expect(svcRow).toEqual(repoRow);
  });

  test('should maintain usedEntryNames with at least current name', async () => {
    const row = await entryInfoRepository.findById(TEST_ENTRY_ID);
    expect(row).toBeDefined();
    const names = row?.usedEntryNames || [];
    expect(Array.isArray(names)).toBe(true);
    if (row?.entryName) {
      expect(names).toContain(row.entryName);
    }
  });

  test('should update last_* fields to previous values on subsequent sync', async () => {
    // First, read current snapshot
    const before = await entryInfoRepository.findById(TEST_ENTRY_ID);
    await syncEntryInfo(TEST_ENTRY_ID);
    const after = await entryInfoRepository.findById(TEST_ENTRY_ID);

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
