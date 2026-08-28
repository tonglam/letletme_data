import {
  completeSchedulerObligation as completeSchedulerObligationRecord,
  completeSchedulerObligationByBullJobId as completeSchedulerObligationByBullJobIdRecord,
  failSchedulerObligation as failSchedulerObligationRecord,
  failSchedulerObligationByBullJobId as failSchedulerObligationByBullJobIdRecord,
  getSchedulerObligation,
  getSchedulerObligationByBullJobId,
  type SchedulerObligation,
} from '../repositories/scheduler-obligations';
import { contractForSchedulerJob, queueLaneForSchedulerJob } from '../domain/data-contracts';
import { retryPolicyForError, summarizeDataError } from '../domain/error-classification';
import { openGovernanceCase, recordFreshnessObservation } from './data-governance.service';
import { logError } from '../utils/logger';

type CompletionEvidence = Pick<
  SchedulerObligation,
  'jobName' | 'evidence' | 'completedAt' | 'runId'
>;

type SchedulerObligationLifecycleDependencies = Readonly<{
  complete: typeof completeSchedulerObligationRecord;
  completeByBullJobId: typeof completeSchedulerObligationByBullJobIdRecord;
  fail: typeof failSchedulerObligationRecord;
  failByBullJobId: typeof failSchedulerObligationByBullJobIdRecord;
  getById: typeof getSchedulerObligation;
  getByBullJobId: typeof getSchedulerObligationByBullJobId;
  recordFreshness: typeof recordFreshnessObservation;
  openCase: typeof openGovernanceCase;
  now: () => Date;
  reportError: (message: string, error: unknown, context: Record<string, unknown>) => void;
}>;

function freshnessWindowIdsFromEvidence(evidence: unknown): number[] {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return [];
  const record = evidence as Record<string, unknown>;
  const values = [
    ...(Array.isArray(record.freshnessWindowIds) ? record.freshnessWindowIds : []),
    record.freshnessWindowId,
  ];
  return [
    ...new Set(
      values.filter(
        (value): value is number =>
          typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
      ),
    ),
  ];
}

function finiteEvidenceCount(
  evidence: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = evidence[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return undefined;
}

function checkpointCompleteness(evidence: Record<string, unknown>): 'COMPLETE' | 'INCOMPLETE' {
  if (evidence.complete === false || evidence.scanComplete === false || evidence.hasMore === true) {
    return 'INCOMPLETE';
  }
  const failedUnits = finiteEvidenceCount(evidence, ['failedUnits', 'failedCount']);
  return failedUnits !== undefined && failedUnits > 0 ? 'INCOMPLETE' : 'COMPLETE';
}

export function createSchedulerObligationLifecycle(
  overrides: Partial<SchedulerObligationLifecycleDependencies> = {},
) {
  const dependencies: SchedulerObligationLifecycleDependencies = {
    complete: completeSchedulerObligationRecord,
    completeByBullJobId: completeSchedulerObligationByBullJobIdRecord,
    fail: failSchedulerObligationRecord,
    failByBullJobId: failSchedulerObligationByBullJobIdRecord,
    getById: getSchedulerObligation,
    getByBullJobId: getSchedulerObligationByBullJobId,
    recordFreshness: recordFreshnessObservation,
    openCase: openGovernanceCase,
    now: () => new Date(),
    reportError: (message, error, context) => logError(message, error, context),
    ...overrides,
  };

  const recordCheckpointFreshnessEvidence = async (input: CompletionEvidence): Promise<void> => {
    const contract = contractForSchedulerJob(input.jobName);
    if (contract?.freshnessEvidence !== 'checkpoint') return;
    const evidence =
      input.evidence && typeof input.evidence === 'object' && !Array.isArray(input.evidence)
        ? input.evidence
        : {};
    const windowIds = freshnessWindowIdsFromEvidence(evidence);
    if (windowIds.length === 0) return;
    const completedAt = input.completedAt ?? dependencies.now();
    const producerRevision = [
      evidence.revision,
      evidence.snapshotRevision,
      evidence.checkpointRevision,
      evidence.publicationRevision,
      input.runId,
    ].find(
      (value): value is string | number => typeof value === 'string' || typeof value === 'number',
    );
    const expectedCount = finiteEvidenceCount(evidence, [
      'expectedCount',
      'requiredUnits',
      'expectedUnits',
    ]);
    const observedCount = finiteEvidenceCount(evidence, [
      'observedCount',
      'succeededUnits',
      'observedUnits',
    ]);
    for (const windowId of windowIds) {
      try {
        await dependencies.recordFreshness({
          windowId,
          sourceCheckedAt: completedAt,
          pgPublishedAt: completedAt,
          ...(producerRevision === undefined ? {} : { producerRevision: String(producerRevision) }),
          ...(expectedCount === undefined ? {} : { expectedCount }),
          ...(observedCount === undefined ? {} : { observedCount }),
          completenessStatus: checkpointCompleteness(evidence),
        });
      } catch (error) {
        dependencies.reportError('Checkpoint freshness evidence update failed', error, {
          jobName: input.jobName,
          windowId,
        });
      }
    }
  };

  const recordCompletion = async (obligation: SchedulerObligation | null): Promise<void> => {
    if (!obligation) return;
    await recordCheckpointFreshnessEvidence(obligation);
  };

  const complete = async (
    input: Parameters<typeof completeSchedulerObligationRecord>[0],
  ): Promise<boolean> => {
    const changed = await dependencies.complete(input);
    if (changed) {
      await recordCompletion(
        await dependencies.getById({ obligationId: input.obligationId, db: input.db }),
      );
    }
    return changed;
  };

  const completeByBullJobId = async (
    input: Parameters<typeof completeSchedulerObligationByBullJobIdRecord>[0],
  ): Promise<boolean> => {
    const changed = await dependencies.completeByBullJobId(input);
    if (changed) {
      await recordCompletion(
        await dependencies.getByBullJobId({ bullJobId: input.bullJobId, db: input.db }),
      );
    }
    return changed;
  };

  const recordFailureCase = async (
    input: Parameters<typeof failSchedulerObligationRecord>[0],
    obligation: SchedulerObligation | null,
  ): Promise<void> => {
    if (!obligation) return;
    const classified = summarizeDataError(input.error);
    const retryPolicy = retryPolicyForError(classified.errorClass);
    if (!retryPolicy.createGovernanceCase && obligation.status !== 'irrecoverable') return;
    const contract = contractForSchedulerJob(obligation.jobName);
    if (!contract) return;
    try {
      await dependencies.openCase({
        caseKind: 'scheduler-failure',
        contractKey: contract.contractKey,
        lane: queueLaneForSchedulerJob(obligation.jobName) ?? contract.queueLane,
        obligationId: obligation.obligationId,
        scopeKey: obligation.scopeKey,
        errorClass: classified.errorClass,
        errorCode: classified.errorCode,
        fingerprint: `${obligation.jobName}:${obligation.scopeKey}:${classified.errorCode}`,
        evidence: {
          generation: obligation.generation,
          retryable: retryPolicy.retryable,
          maxAttempts: retryPolicy.maxAttempts,
        },
        repairTarget: { jobName: obligation.jobName, scopeKey: obligation.scopeKey },
        compensator: contract.compensator,
        db: input.db,
      });
    } catch (error) {
      dependencies.reportError('Scheduler failure governance case persistence failed', error, {
        obligationId: obligation.obligationId,
      });
    }
  };

  const fail = async (
    input: Parameters<typeof failSchedulerObligationRecord>[0],
  ): Promise<boolean> => {
    const changed = await dependencies.fail(input);
    if (changed) {
      await recordFailureCase(
        input,
        await dependencies.getById({ obligationId: input.obligationId, db: input.db }),
      );
    }
    return changed;
  };

  const failByBullJobId = async (
    input: Parameters<typeof failSchedulerObligationByBullJobIdRecord>[0],
  ): Promise<boolean> => {
    const changed = await dependencies.failByBullJobId(input);
    if (!changed) return false;
    const obligation = await dependencies.getByBullJobId({
      bullJobId: input.bullJobId,
      db: input.db,
    });
    if (obligation) {
      await recordFailureCase(
        { obligationId: obligation.obligationId, error: input.error, db: input.db },
        obligation,
      );
    }
    return true;
  };

  return {
    completeSchedulerObligation: complete,
    completeSchedulerObligationByBullJobId: completeByBullJobId,
    failSchedulerObligation: fail,
    failSchedulerObligationByBullJobId: failByBullJobId,
    recordCheckpointFreshnessEvidence,
  };
}

const schedulerObligationLifecycle = createSchedulerObligationLifecycle();

export const completeSchedulerObligation = schedulerObligationLifecycle.completeSchedulerObligation;
export const completeSchedulerObligationByBullJobId =
  schedulerObligationLifecycle.completeSchedulerObligationByBullJobId;
export const failSchedulerObligation = schedulerObligationLifecycle.failSchedulerObligation;
export const failSchedulerObligationByBullJobId =
  schedulerObligationLifecycle.failSchedulerObligationByBullJobId;
export const recordCheckpointFreshnessEvidence =
  schedulerObligationLifecycle.recordCheckpointFreshnessEvidence;
