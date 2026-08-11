import { createHash } from 'node:crypto';

import postgres from 'postgres';

import {
  fingerprintPlatformDataManifest,
  loadPlatformDataManifest,
} from './platform-data-contract';
import {
  fingerprintSchemaContract,
  loadPlatformSchemaContract,
  loadReportingMaterializedViewState,
} from './platform-schema-contract';

const EXPECTED_LEDGER_COUNT = 99;
const EXPECTED_LEDGER_FIRST = '0006_align_event_lives_table_name.sql';
const EXPECTED_LEDGER_LAST = '0095_canonicalize_platform_contract.sql';
const EXPECTED_LEDGER_FINGERPRINT =
  '7e73ca4d98ecf3dbdf595eaa214c6ec609a7d538d57157f82f2fffed84842e27';

export const EXPECTED_PLATFORM_SCHEMA_FINGERPRINT =
  'c96488fc64756b7e5456fafde47c467d3f66bf0eb01800fed5d92ebe9209c40b';

// Filled from the post-activation production manifest before this adopter is merged.
export const EXPECTED_PRODUCTION_DATA_FINGERPRINT = 'PENDING_CANONICAL_ACTIVATION';

type QueryClient = postgres.Sql | postgres.TransactionSql;

type LedgerRow = {
  filename: string;
  checksum: string | null;
};

export type BaselineAdoptionExpectations = {
  ledgerFingerprint: string;
  schemaFingerprint: string;
  dataFingerprint: string;
};

export const PRODUCTION_BASELINE_ADOPTION_EXPECTATIONS: BaselineAdoptionExpectations = {
  ledgerFingerprint: EXPECTED_LEDGER_FINGERPRINT,
  schemaFingerprint: EXPECTED_PLATFORM_SCHEMA_FINGERPRINT,
  dataFingerprint: EXPECTED_PRODUCTION_DATA_FINGERPRINT,
};

function fingerprintLedger(rows: readonly LedgerRow[]): string {
  return createHash('sha256').update(JSON.stringify(rows), 'utf8').digest('hex');
}

async function loadLedger(client: QueryClient): Promise<LedgerRow[]> {
  return client<LedgerRow[]>`
    SELECT filename, checksum
    FROM ops.schema_migrations
    ORDER BY filename
  `;
}

function assertExpectedLedger(rows: readonly LedgerRow[], expectedFingerprint: string): void {
  if (
    rows.length !== EXPECTED_LEDGER_COUNT ||
    rows[0]?.filename !== EXPECTED_LEDGER_FIRST ||
    rows.at(-1)?.filename !== EXPECTED_LEDGER_LAST ||
    rows.some((row) => row.checksum === null) ||
    fingerprintLedger(rows) !== expectedFingerprint
  ) {
    throw new Error('Production migration ledger does not match the accepted canonical boundary');
  }
}

async function assertRetiredRoleAbsent(client: QueryClient): Promise<void> {
  const [{ exists }] = await client<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_roles
      WHERE rolname LIKE 'letletme\\_%\\_frozen_owner' ESCAPE '\\'
    ) AS exists
  `;
  if (exists) throw new Error('Retired frozen-owner role still exists');
}

async function assertReportingViewsPopulated(client: QueryClient): Promise<void> {
  const states = await loadReportingMaterializedViewState(client);
  const expectedNames = ['tournament_entry_event_summaries', 'tournament_selection_stats'];
  if (
    states.length !== expectedNames.length ||
    states.some((state, index) => state.name !== expectedNames[index] || !state.isPopulated)
  ) {
    throw new Error('Production reporting materialized views are not fully populated');
  }
}

export async function adoptProductionPlatformBaseline(
  transaction: postgres.TransactionSql,
  baselineFilename: string,
  baselineChecksum: string,
  expectations: BaselineAdoptionExpectations = PRODUCTION_BASELINE_ADOPTION_EXPECTATIONS,
): Promise<void> {
  if (expectations.dataFingerprint === 'PENDING_CANONICAL_ACTIVATION') {
    throw new Error('Production baseline data fingerprint has not been frozen');
  }

  const ledgerBefore = await loadLedger(transaction);
  assertExpectedLedger(ledgerBefore, expectations.ledgerFingerprint);
  await assertRetiredRoleAbsent(transaction);
  await assertReportingViewsPopulated(transaction);

  const schemaBefore = fingerprintSchemaContract(await loadPlatformSchemaContract(transaction));
  if (schemaBefore !== expectations.schemaFingerprint) {
    throw new Error(
      `Platform schema fingerprint mismatch: expected=${expectations.schemaFingerprint} actual=${schemaBefore}`,
    );
  }

  const dataBefore = fingerprintPlatformDataManifest(await loadPlatformDataManifest(transaction));
  if (dataBefore !== expectations.dataFingerprint) {
    throw new Error(
      `Platform data fingerprint mismatch: expected=${expectations.dataFingerprint} actual=${dataBefore}`,
    );
  }

  await transaction`DELETE FROM ops.schema_migrations`;
  await transaction`
    INSERT INTO ops.schema_migrations (filename, checksum)
    VALUES (${baselineFilename}, ${baselineChecksum})
  `;

  const ledgerAfter = await loadLedger(transaction);
  if (
    ledgerAfter.length !== 1 ||
    ledgerAfter[0]?.filename !== baselineFilename ||
    ledgerAfter[0]?.checksum !== baselineChecksum
  ) {
    throw new Error('Canonical baseline ledger adoption did not converge to one row');
  }

  const schemaAfter = fingerprintSchemaContract(await loadPlatformSchemaContract(transaction));
  if (schemaAfter !== schemaBefore) {
    throw new Error('Schema changed while adopting the canonical baseline ledger');
  }

  const dataAfter = fingerprintPlatformDataManifest(await loadPlatformDataManifest(transaction));
  if (dataAfter !== dataBefore) {
    throw new Error('Business data or sequence state changed during baseline adoption');
  }
}
