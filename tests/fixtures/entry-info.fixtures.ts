import type { RawFPLEntryHistoryResponse, RawFPLEntrySummary } from '../../src/types';
import type { EntryInfoClient } from '../../src/services/entry-info.service';

export const recordedEntryId = 15_702;

export const recordedEntrySummary: RawFPLEntrySummary = {
  id: recordedEntryId,
  name: 'Recorded Integration XI',
  player_first_name: 'Integration',
  player_last_name: 'Manager',
  player_region_name: 'Australia',
  started_event: 1,
  summary_overall_points: 1234,
  summary_overall_rank: 456_789,
  bank: 10,
  value: 1_005,
  last_deadline_total_transfers: 31,
  last_deadline_bank: 10,
  last_deadline_total_points: 1234,
  last_deadline_rank: 456_789,
  last_deadline_value: 1_005,
  leagues: {
    classic: [
      {
        id: 900_157_020,
        name: 'Recorded Integration League',
        entry_rank: 3,
        entry_last_rank: 4,
        start_event: 1,
      },
    ],
    h2h: [],
  },
};

export const recordedEntryHistory: RawFPLEntryHistoryResponse = {
  current: [{ event: 1, points: 63, total_points: 63, rank: 1_234, overall_rank: 5_678 }],
  chips: [],
  past: [{ season_name: '2024/25', total_points: 2_321, rank: 123_456 }],
};

export const recordedEntryClient: EntryInfoClient = {
  async getEntrySummary(entryId) {
    if (entryId !== recordedEntryId) {
      throw new Error(`Unexpected recorded entry id: ${entryId}`);
    }
    return structuredClone(recordedEntrySummary);
  },
  async getEntryHistory(entryId) {
    if (entryId !== recordedEntryId) {
      throw new Error(`Unexpected recorded entry id: ${entryId}`);
    }
    return structuredClone(recordedEntryHistory);
  },
};
