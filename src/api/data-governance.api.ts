import { createHash } from 'node:crypto';
import { Elysia, t } from 'elysia';

import {
  listFreshnessWindows,
  countGovernanceCases,
  listGovernanceCases,
  transitionGovernanceCase,
} from '../services/data-governance.service';
import {
  readQueueAdmission,
  setQueueAdmission,
  type QueueAdmissionMode,
} from '../services/queue-governance.service';
import { getJobsStatus, type JobsStatusWindow } from '../services/jobs-status.service';
import { runLiveMatchesV3Repair } from '../services/live-match-v3-repair.service';
import {
  getHttpStatusFromError,
  getOrCreateRequestId,
  getPublicErrorCode,
  getPublicErrorMessage,
} from '../utils/errors';
import { logError } from '../utils/logger';
import { apiKeyFailureHttpResponse, verifyRequestApiKey } from './auth.guard';

const FRESHNESS_STATUSES = new Set(['PENDING', 'MET', 'BREACHED', 'INVALID', 'NOT_APPLICABLE']);
const GOVERNANCE_CASE_STATUSES = new Set([
  'OPEN',
  'AUTO_REPAIRING',
  'REQUIRES_REVIEW',
  'RECOVERED',
  'DISMISSED',
]);

/**
 * Scope keys are useful to operators, but entry-scoped keys can contain a
 * raw FPL entry id. Keep the response shape stable while replacing the value
 * with a deterministic opaque token. The internal service still receives the
 * real scope when a case action is executed.
 */
function opaqueScopeKey(value: string): string {
  const digest = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 20);
  return `scope:${digest}`;
}

function boundedLimit(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) ? Math.min(max, Math.max(1, parsed)) : fallback;
}

function safeFreshnessWindow(row: Record<string, unknown>) {
  return {
    windowId: row.windowId,
    sloKey: row.sloKey,
    contractKey: row.contractKey,
    seasonId: row.seasonId,
    scopeKey: typeof row.scopeKey === 'string' ? opaqueScopeKey(row.scopeKey) : null,
    periodKey: row.periodKey,
    eventId: row.eventId,
    sourceDay: row.sourceDay,
    eligibleAt: row.eligibleAt,
    dueAt: row.dueAt,
    obligationDueAt: row.obligationDueAt,
    sourceCheckedAt: row.sourceCheckedAt,
    pgPublishedAt: row.pgPublishedAt,
    redisSeenAt: row.redisSeenAt,
    graphqlSeenAt: row.graphqlSeenAt,
    webSeenAt: row.webSeenAt,
    producerRevision: row.producerRevision,
    redisRevision: row.redisRevision,
    graphqlRevision: row.graphqlRevision,
    webRevision: row.webRevision,
    expectedCount: row.expectedCount,
    observedCount: row.observedCount,
    notApplicableCount: row.notApplicableCount,
    completenessStatus: row.completenessStatus,
    status: row.status,
    breachCode: row.breachCode,
    recoveredAt: row.recoveredAt,
    recoveryRevision: row.recoveryRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function safeGovernanceCase(row: Record<string, unknown>) {
  return {
    caseId: row.caseId,
    caseKind: row.caseKind,
    contractKey: row.contractKey,
    lane: row.lane,
    scopeKey: typeof row.scopeKey === 'string' ? opaqueScopeKey(row.scopeKey) : null,
    targetRevision: row.targetRevision,
    sloWindowId: row.sloWindowId,
    errorClass: row.errorClass,
    errorCode: row.errorCode,
    compensator: row.compensator,
    attempts: row.attempts,
    status: row.status,
    repairJobId: row.repairJobId,
    repairDeadlineAt: row.repairDeadlineAt,
    openedAt: row.openedAt,
    updatedAt: row.updatedAt,
    recoveredAt: row.recoveredAt,
    recoveryRevision: row.recoveryRevision,
  };
}

async function requireOpsKey(request: Request, set: { status?: number | string }) {
  const verification = await verifyRequestApiKey(request);
  if (verification.status === 'ok') return true;
  const failure = apiKeyFailureHttpResponse(verification.status);
  set.status = failure.httpStatus;
  return false;
}

export const dataGovernanceAPI = new Elysia({ prefix: '/ops' })
  .get('/data-governance/overview', async ({ request, set }) => {
    if (!(await requireOpsKey(request, set))) return { success: false, error: 'Unauthorized' };
    const requestedWindow = new URL(request.url).searchParams.get('window') ?? '1h';
    if (!['1h', '6h', '3d', '28d'].includes(requestedWindow)) {
      set.status = 400;
      return { success: false, error: 'window must be one of 1h, 6h, 3d, 28d' };
    }
    const window = requestedWindow as JobsStatusWindow;
    const status = await getJobsStatus(window);
    return {
      success: true,
      generatedAt: new Date().toISOString(),
      window,
      // Keep the explicit deep-governance envelope extensible. This endpoint
      // is intentionally separate from the lightweight /jobs/status control
      // projection; the Web admin adapter filters the object by contract and
      // never receives secrets or raw provider errors.
      governance: status,
    };
  })
  .get('/data-governance/windows', async ({ request, set, query }) => {
    if (!(await requireOpsKey(request, set))) return { success: false, error: 'Unauthorized' };
    const status = typeof query.status === 'string' ? query.status : undefined;
    if (status && !FRESHNESS_STATUSES.has(status)) {
      set.status = 400;
      return { success: false, error: 'Invalid freshness status' };
    }
    const windows = await listFreshnessWindows({
      status: status as never,
      limit: boundedLimit(query.limit, 100, 500),
    });
    return { success: true, windows: windows.map((row) => safeFreshnessWindow(row)) };
  })
  .get('/data-governance/cases', async ({ request, set, query }) => {
    if (!(await requireOpsKey(request, set))) return { success: false, error: 'Unauthorized' };
    const status = typeof query.status === 'string' ? query.status : undefined;
    if (status && !GOVERNANCE_CASE_STATUSES.has(status)) {
      set.status = 400;
      return { success: false, error: 'Invalid governance case status' };
    }
    const cases = await listGovernanceCases({
      status: status as never,
      limit: boundedLimit(query.limit, 100, 500),
    });
    const openCount = await countGovernanceCases({
      status: ['OPEN', 'AUTO_REPAIRING', 'REQUIRES_REVIEW'],
    });
    const total = await countGovernanceCases();
    return {
      success: true,
      cases: cases.map((row) => safeGovernanceCase(row)),
      openCount,
      total,
    };
  })
  .post(
    '/data-governance/cases/:id/action',
    async ({ request, set, params, body }) => {
      if (!(await requireOpsKey(request, set))) return { success: false, error: 'Unauthorized' };
      const expectedUpdatedAt = body.expectedUpdatedAt.trim();
      if (!expectedUpdatedAt || !Number.isFinite(Date.parse(expectedUpdatedAt))) {
        set.status = 400;
        return { success: false, error: 'Invalid expectedUpdatedAt' };
      }
      const changed = await transitionGovernanceCase({
        caseId: Number(params.id),
        expectedUpdatedAt,
        action: body.action,
      });
      if (!changed) {
        set.status = 409;
        return { success: false, error: 'Governance case changed or is no longer actionable' };
      }
      return { success: true, action: body.action };
    },
    {
      body: t.Object({
        action: t.Union([t.Literal('dry-run'), t.Literal('execute'), t.Literal('dismiss')]),
        expectedUpdatedAt: t.String(),
      }),
    },
  )
  .post(
    '/live-matches-v3/repair',
    async ({ request, set, body }) => {
      if (!(await requireOpsKey(request, set))) return { success: false, error: 'Unauthorized' };
      try {
        const repairInput = {
          action: body.action,
          season: body.season,
          eventId: body.eventId,
          reason: body.reason ?? null,
          confirmation: body.confirmation ?? null,
          ...(body.kind === undefined ? {} : { kind: body.kind }),
        };
        const repair = await runLiveMatchesV3Repair(repairInput);
        return { success: true, repair };
      } catch (error) {
        const status = getHttpStatusFromError(error);
        const requestId = getOrCreateRequestId(request);
        if (status >= 500) {
          logError('Live Matches V3 operator repair failed', error, { requestId });
          set.headers['x-request-id'] = requestId;
        }
        set.status = status;
        const code = getPublicErrorCode(error, status);
        return {
          success: false,
          error: getPublicErrorMessage(error, status),
          ...(code ? { code } : {}),
          ...(status >= 500 && process.env.NODE_ENV === 'production' ? { requestId } : {}),
        };
      }
    },
    {
      body: t.Object({
        action: t.Union([
          t.Literal('inspect'),
          t.Literal('promote-previous'),
          t.Literal('rebuild-current'),
          t.Literal('replay-checkpoint'),
          t.Literal('restore-equivalent-final-pair'),
        ]),
        season: t.String({ pattern: '^\\d{4}$' }),
        eventId: t.Integer({ minimum: 1 }),
        kind: t.Optional(t.Union([t.Literal('desk'), t.Literal('detail')])),
        reason: t.Optional(t.String({ maxLength: 240 })),
        confirmation: t.Optional(t.String({ maxLength: 64 })),
      }),
    },
  )
  .post(
    '/queues/:lane/admission',
    async ({ request, set, params, body }) => {
      if (!(await requireOpsKey(request, set))) return { success: false, error: 'Unauthorized' };
      const admission = await setQueueAdmission({
        queueName: params.lane,
        mode: body.mode,
        ttlSeconds: body.ttlSeconds,
        reasonCode: body.reasonCode,
        changedBy: request.headers.get('x-actor-id') ?? 'operator',
        forceCritical: body.forceCritical,
      });
      return { success: true, admission };
    },
    {
      body: t.Object({
        mode: t.Union([t.Literal('OPEN'), t.Literal('DRAIN_ONLY')]),
        ttlSeconds: t.Integer({ minimum: 1, maximum: 900 }),
        reasonCode: t.String({ minLength: 1, maxLength: 120 }),
        forceCritical: t.Optional(t.Boolean()),
      }),
    },
  )
  .get('/queues/:lane/admission', async ({ request, set, params }) => {
    if (!(await requireOpsKey(request, set))) return { success: false, error: 'Unauthorized' };
    return { success: true, admission: await readQueueAdmission(params.lane) };
  });

export type { QueueAdmissionMode };
