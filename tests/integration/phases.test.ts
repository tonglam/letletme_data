import { beforeAll, describe, expect, test } from 'bun:test';

import { phases } from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import { syncPhases } from '../../src/services/phases.service';

describe('Phases Integration Tests', () => {
  let syncResult: { count: number };

  beforeAll(async () => {
    // Sync phases once
    syncResult = await syncPhases();
  });

  test('syncPhases persists data to database', async () => {
    expect(syncResult.count).toBeGreaterThan(0);

    const db = await getDb();
    const rows = await db.select().from(phases);
    expect(rows.length).toBe(syncResult.count);
    expect(rows.length).toBeGreaterThanOrEqual(1); // At least one phase
  });

  test('should have valid phase structure', async () => {
    const db = await getDb();
    const phaseRows = await db.select().from(phases).limit(1);
    expect(phaseRows.length).toBeGreaterThan(0);

    const phase = phaseRows[0];
    expect(typeof phase.id).toBe('number');
    expect(typeof phase.name).toBe('string');
    expect(typeof phase.startEvent).toBe('number');
    expect(typeof phase.stopEvent).toBe('number');
  });

  test('should have valid event ranges', async () => {
    const db = await getDb();
    const phaseRows = await db.select().from(phases);

    phaseRows.forEach((phase) => {
      expect(phase.startEvent).toBeGreaterThan(0);
      expect(phase.stopEvent).toBeGreaterThan(0);
      expect(phase.stopEvent).toBeGreaterThanOrEqual(phase.startEvent);
    });
  });

  test('should have reasonable phase count', async () => {
    const db = await getDb();
    const phaseRows = await db.select().from(phases);

    // Should have at least 1 phase, typically 1-11 depending on season structure
    expect(phaseRows.length).toBeGreaterThanOrEqual(1);
    expect(phaseRows.length).toBeLessThanOrEqual(15);
  });

  test('should have created_at and updated_at timestamps', async () => {
    const db = await getDb();
    const phaseRows = await db.select().from(phases).limit(3);

    phaseRows.forEach((phase) => {
      expect(phase.createdAt).toBeDefined();
      expect(phase.updatedAt).toBeDefined();
      expect(phase.createdAt).toBeInstanceOf(Date);
      expect(phase.updatedAt).toBeInstanceOf(Date);
    });
  });

  test('should update updated_at on re-sync', async () => {
    const db = await getDb();

    // Get initial timestamps
    const before = await db.select().from(phases).limit(1);
    const beforeUpdatedAt = before[0].updatedAt;

    // Wait a moment to ensure timestamp difference
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Re-sync phases
    await syncPhases();

    // Get new timestamps
    const after = await db.select().from(phases).limit(1);
    const afterUpdatedAt = after[0].updatedAt;

    // created_at should remain unchanged, updated_at should change
    expect(after[0].createdAt).toEqual(before[0].createdAt);
    expect(afterUpdatedAt?.getTime()).toBeGreaterThan(beforeUpdatedAt?.getTime() || 0);
  });
});
