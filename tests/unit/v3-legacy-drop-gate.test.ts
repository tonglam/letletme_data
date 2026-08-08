import { describe, expect, test } from 'bun:test';

import {
  isV3LegacyDropMigration,
  selectV3LegacyDropMigrations,
} from '../../scripts/v3-legacy-drop-gate';

const files = [
  '0090_activate_v3_and_freeze_v2.sql',
  '0091_drop_v2_reporting_and_rpcs.sql',
  '0092_drop_v2_tables_partitions_triggers.sql',
  '0093_finalize_v3_migration_ownership.sql',
];
const runId = 'v3-20260808T160008Z-b9eddc0';
const approval = `APPROVE_V3_LEGACY_DROP ${runId}`;

describe('v3 legacy drop gate', () => {
  test('recognizes only the destructive cleanup migrations', () => {
    expect(isV3LegacyDropMigration(files[0])).toBe(false);
    expect(files.slice(1).every(isV3LegacyDropMigration)).toBe(true);
  });

  test('gates every pending cleanup file when approval is absent', () => {
    expect(selectV3LegacyDropMigrations(files, [files[0]], undefined)).toEqual({
      files: [files[0]],
      gatedFiles: files.slice(1),
      approval: undefined,
    });
  });

  test('allows exact approval and verifies all files after cleanup', () => {
    expect(selectV3LegacyDropMigrations(files, [files[0]], approval)).toEqual({
      files,
      gatedFiles: [],
      approval,
    });
    expect(selectV3LegacyDropMigrations(files, files, undefined)).toEqual({
      files,
      gatedFiles: [],
      approval: undefined,
    });
  });

  test('fails closed for malformed approval and partial cleanup', () => {
    expect(() => selectV3LegacyDropMigrations(files, [files[0]], `${approval} `)).toThrow(
      'must equal',
    );
    expect(() => selectV3LegacyDropMigrations(files, files.slice(0, 2), undefined)).toThrow(
      'partially applied',
    );
  });
});
