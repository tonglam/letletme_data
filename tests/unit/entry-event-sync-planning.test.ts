import { describe, expect, test } from 'bun:test';

import { classifyDataError, retryPolicyForError } from '../../src/domain/error-classification';
import {
  planEntrySyncAuditReuse,
  planTournamentEventSync,
} from '../../src/services/tournament-event-results.service';
import { IncompleteDataSyncError } from '../../src/utils/errors';

describe('entry/event terminal synchronization planning', () => {
  test('requests only stale result components and isolates transfer-only work', () => {
    const plan = planTournamentEventSync(
      [101, 102, 103],
      new Set([101, 102]),
      new Set([101, 102, 103]),
      new Set([102, 103]),
    );

    expect(plan.requiredResultEntryIds).toEqual([103]);
    expect(plan.requiredTransferEntryIds).toEqual([102, 103]);
    expect(plan.reusedUnits).toBe(3);
  });

  test('keeps a missing final checkpoint in dependency-wait classification', () => {
    const error = new IncompleteDataSyncError(
      'final checkpoint is not ready',
      1,
      0,
      0,
      1,
      'SOURCE_NOT_READY',
    );

    expect(classifyDataError(error)).toBe('SOURCE_NOT_READY');
    expect(retryPolicyForError(classifyDataError(error))).toMatchObject({
      retryable: true,
      maxAttempts: 3,
      createGovernanceCase: false,
    });
  });

  test('terminalizes reused result and final components for transfer-only entries', () => {
    expect(planEntrySyncAuditReuse([101, 102, 103], [103], [102])).toEqual({
      reusedComponentEntryIds: [101, 102],
      reusedRunEntryIds: [101],
    });
  });
});
