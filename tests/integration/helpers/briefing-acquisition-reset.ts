import { sql } from 'drizzle-orm';

import { getDb, type DbHandle } from '../../../src/db/singleton';

/**
 * Keeps non-live Briefing integration cases independent from file ordering.
 * The integration env guard must be imported and asserted before this helper.
 */
export async function resetBriefingAcquisitionState(db?: DbHandle): Promise<void> {
  const database = db ?? (await getDb());
  await database.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL client_min_messages = warning`);
    await tx.execute(sql`
      TRUNCATE TABLE
        content.source_media_assets,
        content.sources,
        content.source_groups,
        content.source_partitions,
        content.source_registry_reconciliations,
        content.acquisition_budget_ledgers
      CASCADE
    `);
  });
}
