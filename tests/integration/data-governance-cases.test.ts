import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';
import {
  listGovernanceCases,
  openGovernanceCase,
  upsertFreshnessWindow,
  transitionGovernanceCase,
} from '../../src/services/data-governance.service';

const SCOPE_KEY = 'integration:governance-case-cas';
const FINGERPRINT = 'integration:governance-case-cas:v1';
const WINDOW_SLO_KEY = 'integration:consumer-evidence-freeze';
const WINDOW_SCOPE_KEY = 'integration:consumer-evidence-freeze';

async function cleanup(): Promise<void> {
  const sql = await getDbClient();
  await sql`
    DELETE FROM ops.data_governance_cases
    WHERE scope_key = ${SCOPE_KEY} AND fingerprint = ${FINGERPRINT}
  `;
  await sql`
    DELETE FROM ops.freshness_slo_windows
    WHERE slo_key = ${WINDOW_SLO_KEY} AND scope_key = ${WINDOW_SCOPE_KEY}
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
    // PostgreSQL preserves the exact text token used by the CAS predicate;
    // the server may expose milliseconds or microseconds depending on the
    // configured timestamp precision, so do not couple the test to a scale.
    expect(rawRow?.updatedAt).toMatch(/\.\d+\+\d{2}$/);

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

  test('freezes consumer evidence requirements on freshness-window re-reservation', async () => {
    const base = {
      sloKey: WINDOW_SLO_KEY,
      contractKey: 'my-fpl',
      scopeKey: WINDOW_SCOPE_KEY,
      periodKey: 'freeze-v1',
      eligibleAt: new Date('2026-08-28T00:00:00.000Z'),
      dueAt: new Date('2026-08-28T00:15:00.000Z'),
    } as const;

    await upsertFreshnessWindow({
      ...base,
      evidence: { consumerEvidenceRequired: false, redisEvidenceRequired: false },
    });
    await upsertFreshnessWindow({
      ...base,
      evidence: { consumerEvidenceRequired: true, redisEvidenceRequired: true },
    });

    const sql = await getDbClient();
    const [row] = await sql<Array<{ consumer: boolean; redis: boolean }>>`
      SELECT
        (evidence ->> 'consumerEvidenceRequired')::boolean AS consumer,
        (evidence ->> 'redisEvidenceRequired')::boolean AS redis
      FROM ops.freshness_slo_windows
      WHERE slo_key = ${WINDOW_SLO_KEY}
        AND scope_key = ${WINDOW_SCOPE_KEY}
        AND period_key = 'freeze-v1'
    `;
    expect(row).toEqual({ consumer: false, redis: true });
  });
});
