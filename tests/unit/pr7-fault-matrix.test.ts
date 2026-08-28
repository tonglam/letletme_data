import { describe, expect, test } from 'bun:test';

import { classifyDataPublicationDeliveryFailure } from '../../src/domain/data-publication-delivery';
import {
  isSupportedMyFplInvalidationReason,
  MY_FPL_SNAPSHOT_INVALIDATION_REASON,
  parseMyFplSnapshotInvalidationResult,
} from '../../src/domain/my-fpl-invalidation';
import {
  canManageTournament,
  isOfficialRosterSyncEligible,
} from '../../src/domain/tournament-management';

describe('PR7 critical fault matrix', () => {
  test('unit preload fences database, Redis, provider and network access', async () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(process.env.DATABASE_URL).toBe('postgresql://unit:unit@127.0.0.1:1/unit');
    expect(process.env.CACHE_REDIS_PORT).toBe('1');
    expect(process.env.QUEUE_REDIS_PORT).toBe('2');
    await expect(fetch('https://provider.example.test')).rejects.toThrow(
      'Unit tests cannot access the network',
    );
  });

  test('keeps the Redis CAS vocabulary closed and the reason fixed', () => {
    expect(MY_FPL_SNAPSHOT_INVALIDATION_REASON).toBe('TOURNAMENT_DELETED');
    expect(isSupportedMyFplInvalidationReason('TOURNAMENT_DELETED')).toBe(true);
    expect(isSupportedMyFplInvalidationReason('TOURNAMENT_RENAMED')).toBe(false);
    expect(parseMyFplSnapshotInvalidationResult(['absent'])).toBe('absent');
    expect(parseMyFplSnapshotInvalidationResult(['deleted'])).toBe('deleted');
    expect(parseMyFplSnapshotInvalidationResult(['malformed_deleted'])).toBe('malformed_deleted');
    expect(parseMyFplSnapshotInvalidationResult(['different'])).toBe('different');
    expect(() => parseMyFplSnapshotInvalidationResult(['unexpected'])).toThrow();
  });

  test('keeps publication delivery failures retryable unless Redis is newer', () => {
    expect(classifyDataPublicationDeliveryFailure(new Error('Redis unavailable'))).toBe('retry');
    expect(
      classifyDataPublicationDeliveryFailure(
        new Error('Redis publication is newer than canonical publication; reconciliation required'),
      ),
    ).toBe('superseded');
    expect(classifyDataPublicationDeliveryFailure({ code: 'ETIMEDOUT' })).toBe('retry');
  });

  test('keeps tournament ownership and official roster eligibility deterministic', () => {
    const eligible = {
      adminEntryId: 10,
      leagueType: 'classic',
      groupMode: 'points_races',
      groupNum: 1,
      knockoutMode: 'no_knockout',
    } as const;
    expect(canManageTournament(eligible, { adminEntryId: 10, platformAdmin: false })).toBe(true);
    expect(canManageTournament(eligible, { adminEntryId: 11, platformAdmin: false })).toBe(false);
    expect(canManageTournament(eligible, { adminEntryId: 11, platformAdmin: true })).toBe(true);
    expect(isOfficialRosterSyncEligible(eligible)).toBe(true);
    expect(isOfficialRosterSyncEligible({ ...eligible, groupNum: 2 })).toBe(false);
    expect(isOfficialRosterSyncEligible({ ...eligible, leagueType: 'h2h' })).toBe(false);
  });
});
