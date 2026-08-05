import { describe, expect, test } from 'bun:test';

import {
  createDataSyncJobData,
  defaultDataSyncJobId,
} from '../../src/jobs/data-sync-job-definition';
import { getCoreSnapshotJobId } from '../../src/jobs/data-sync-enqueue';

describe('data-sync enqueue correlation', () => {
  test('keeps a deterministic queue ID but gives settled executions distinct run IDs', () => {
    const first = createDataSyncJobData('api', {});
    const second = createDataSyncJobData('api', {});

    expect(defaultDataSyncJobId('teams', 'api', {})).toBe('teams-api');
    expect(first.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.runId).not.toBe(first.runId);
  });

  test('does not dedupe an event transition behind the repair job', () => {
    expect(getCoreSnapshotJobId('event-transition')).toBeUndefined();
    expect(getCoreSnapshotJobId('manual')).toBe('core-snapshot-repair');
    expect(getCoreSnapshotJobId('event-transition', { jobId: 'explicit-id' })).toBe('explicit-id');
  });
});
