import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';
import {
  listGovernanceCases,
  openGovernanceCase,
  transitionGovernanceCase,
} from '../../src/services/data-governance.service';

const SCOPE_KEY = 'integration:governance-case-cas';
const FINGERPRINT = 'integration:governance-case-cas:v1';

async function cleanup(): Promise<void> {
  const sql = await getDbClient();
  await sql`
    DELETE FROM ops.data_governance_cases
    WHERE scope_key = ${SCOPE_KEY} AND fingerprint = ${FINGERPRINT}
  `;
}

beforeEach(cleanup);
afterAll(cleanup);

describe('data governance case CAS', () => {
  test('uses the exact PostgreSQL timestamp token for operator actions', async () => {
    const inserted = await openGovernanceCase({
      caseKind: 'scheduler-failure',
      contractKey: 'housekeeping',
      lane: 'housekeeping',
      scopeKey: SCOPE_KEY,
      errorClass: 'TRANSIENT_INFRA',
      errorCode: 'INTEGRATION_CAS',
      fingerprint: FINGERPRINT,
      compensator: 'integration test',
    });
    expect(inserted).not.toBeNull();

    const raw = await getDbClient();
    const [rawRow] = await raw<{ updatedAt: string }[]>`
      SELECT updated_at::text AS "updatedAt"
      FROM ops.data_governance_cases
      WHERE scope_key = ${SCOPE_KEY} AND fingerprint = ${FINGERPRINT}
    `;
    expect(rawRow?.updatedAt).toMatch(/\.\d{4,}\+/);

    const [listed] = await listGovernanceCases({ status: 'OPEN', limit: 10 });
    expect(listed?.scopeKey).toBe(SCOPE_KEY);
    expect(typeof listed?.updatedAt).toBe('string');
    expect(
      await transitionGovernanceCase({
        caseId: listed!.caseId,
        expectedUpdatedAt: listed!.updatedAt,
        action: 'dry-run',
      }),
    ).toBe(true);

    // The old token is fenced after the state transition; only the exact
    // microsecond-preserving token returned by the next read can proceed.
    expect(
      await transitionGovernanceCase({
        caseId: listed!.caseId,
        expectedUpdatedAt: listed!.updatedAt,
        action: 'dismiss',
      }),
    ).toBe(false);
    const [reviewed] = await listGovernanceCases({ status: 'REQUIRES_REVIEW', limit: 10 });
    expect(reviewed?.scopeKey).toBe(SCOPE_KEY);
    expect(
      await transitionGovernanceCase({
        caseId: reviewed!.caseId,
        expectedUpdatedAt: reviewed!.updatedAt,
        action: 'dismiss',
      }),
    ).toBe(true);
  });
});
