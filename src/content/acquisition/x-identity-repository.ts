import { randomUUID } from 'node:crypto';

import { and, eq, ne, sql } from 'drizzle-orm';

import {
  contentAcquisitionProviderTraces,
  contentAcquisitionRuns,
  contentSourceEndpoints,
  contentSources,
} from '../../db/schemas/content.schema';
import { getDb, type DbHandle, type TransactionHandle } from '../../db/singleton';
import { sha256CanonicalJson } from './canonicalization';
import { parseFormalRunRequestV1 } from './formal-run-contract';
import type { FormalRunProbeEvidence } from './formal-run-repository';
import type { GrokBuildExecutionResult, GrokBuildXUserV1 } from './grok-build-executor';
import { commitXRunBudgets, releaseXRunBudgets } from './x-budget';

const IDENTITY_REFRESH_MS = 30 * 24 * 60 * 60_000;
const IDENTITY_RETRY_MS = 30 * 60_000;

type IdentityTerminalResult = Readonly<{
  status: 'COMPLETED' | 'FAILED';
  identityStatus: 'VERIFIED' | 'FAILED' | 'CONFLICT';
  userId: string | null;
  handle: string;
}>;

function databaseDate(value: Date | string | undefined): Date {
  const result = value instanceof Date ? value : new Date(value ?? Number.NaN);
  if (!Number.isFinite(result.getTime())) throw new Error('Database clock is invalid');
  return result;
}

function sanitizeError(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 1_000);
}

async function insertProviderTrace(input: {
  tx: TransactionHandle;
  runId: string;
  execution: GrokBuildExecutionResult;
  terminalState: string;
  sequence?: number;
}): Promise<void> {
  await input.tx.insert(contentAcquisitionProviderTraces).values({
    traceId: randomUUID(),
    runId: input.runId,
    sequence: input.sequence ?? 0,
    provider: 'grok-build',
    operation: input.execution.toolName,
    requestMetadataHash: input.execution.requestMetadataHash,
    responseMetadataHash: input.execution.responseMetadataHash,
    providerJobIdHash: input.execution.toolCallIdHash,
    providerUnits: '1',
    terminalState: input.terminalState,
  });
}

async function insertProbeTrace(input: {
  tx: TransactionHandle;
  runId: string;
  evidence: FormalRunProbeEvidence;
}): Promise<void> {
  await input.tx.insert(contentAcquisitionProviderTraces).values({
    traceId: randomUUID(),
    runId: input.runId,
    sequence: 0,
    provider: input.evidence.provider,
    operation: input.evidence.operation,
    requestMetadataHash: input.evidence.requestMetadataHash,
    responseMetadataHash: input.evidence.responseMetadataHash,
    providerJobIdHash: input.evidence.providerJobIdHash,
    providerUnits: String(input.evidence.providerUnits),
    terminalState: input.evidence.terminalState,
  });
}

async function failIdentityResult(input: {
  tx: TransactionHandle;
  runId: string;
  endpointId: string;
  handle: string;
  dbNow: Date;
  failureClass: string;
  summary: string;
  identityStatus: 'FAILED' | 'CONFLICT';
  execution: GrokBuildExecutionResult;
  probeEvidence?: FormalRunProbeEvidence;
}): Promise<IdentityTerminalResult> {
  const summary = sanitizeError(input.summary);
  const committedReservations = await commitXRunBudgets({
    tx: input.tx,
    runId: input.runId,
    dbNow: input.dbNow,
  });
  if (committedReservations === 0) {
    throw new Error('Attested X identity result has no reserved budget');
  }
  if (input.probeEvidence)
    await insertProbeTrace({ tx: input.tx, runId: input.runId, evidence: input.probeEvidence });
  await insertProviderTrace({
    tx: input.tx,
    runId: input.runId,
    execution: input.execution,
    terminalState: input.identityStatus,
    sequence: input.probeEvidence ? 1 : 0,
  });
  await input.tx
    .update(contentSourceEndpoints)
    .set({
      identityStatus: input.identityStatus,
      identityErrorSummary: summary,
      identityCheckedAt: input.dbNow,
      identityNextCheckAt:
        input.identityStatus === 'FAILED'
          ? new Date(input.dbNow.getTime() + IDENTITY_RETRY_MS)
          : null,
      updatedAt: input.dbNow,
    })
    .where(eq(contentSourceEndpoints.endpointId, input.endpointId));
  await input.tx
    .update(contentAcquisitionRuns)
    .set({
      status: 'FAILED',
      failureClass: input.failureClass,
      errorSummary: summary,
      failureDetailsHash: sha256CanonicalJson({ failureClass: input.failureClass, summary }),
      provider: 'grok-build',
      providerUnits: String(1 + (input.probeEvidence ? input.probeEvidence.providerUnits : 0)),
      xCallCount: 1 + (input.probeEvidence ? 1 : 0),
      traceVerified: true,
      resultCount: 0,
      rejectedCount: input.execution.users.length,
      runMetrics: {
        durationMs: Math.round(input.execution.durationMs),
        eventCount: input.execution.eventCount,
        totalCostUsd: input.execution.totalCostUsd,
        executionLocation: input.execution.executionLocation,
        runnerReleaseSha: input.execution.runnerReleaseSha,
        grokVersion: input.execution.grokVersion,
        runnerBinaryHash: input.execution.runnerBinaryHash,
        rawPostEvidenceAvailable: input.execution.rawPostEvidenceAvailable,
        traceHash: input.execution.traceHash,
        probeCallCount: input.probeEvidence ? 1 : 0,
      },
      completedAt: input.dbNow,
      leaseExpiresAt: null,
      checkpointAdvanced: false,
    })
    .where(
      and(
        eq(contentAcquisitionRuns.runId, input.runId),
        eq(contentAcquisitionRuns.status, 'RUNNING'),
      ),
    );
  return {
    status: 'FAILED',
    identityStatus: input.identityStatus,
    userId: null,
    handle: input.handle,
  };
}

function oneExactUser(
  users: readonly GrokBuildXUserV1[],
  expectedHandle: string,
): GrokBuildXUserV1 | null {
  if (users.length !== 1 || users[0]?.handle.toLowerCase() !== expectedHandle.toLowerCase()) {
    return null;
  }
  return users[0];
}

export async function persistXIdentityResult(input: {
  runId: string;
  execution: GrokBuildExecutionResult;
  probeEvidence?: FormalRunProbeEvidence;
  db?: DbHandle;
}): Promise<IdentityTerminalResult> {
  if (input.execution.toolName !== 'x_user_search') {
    throw new Error('X identity result did not use x_user_search');
  }
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const clockRows = await tx.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
    const dbNow = databaseDate(clockRows[0]?.dbNow);
    const runRows = await tx
      .select({
        endpointId: contentAcquisitionRuns.endpointId,
        status: contentAcquisitionRuns.status,
        requestSnapshot: contentAcquisitionRuns.requestSnapshot,
      })
      .from(contentAcquisitionRuns)
      .where(eq(contentAcquisitionRuns.runId, input.runId))
      .for('update')
      .limit(1);
    const run = runRows[0];
    if (!run?.endpointId) throw new Error('X identity run has no endpoint target');
    if (run.status !== 'RUNNING') throw new Error(`X identity run is not RUNNING: ${run.status}`);
    const request = parseFormalRunRequestV1(run.requestSnapshot);
    if (request.jobKind !== 'X_IDENTITY' || request.toolRequest.toolName !== 'x_user_search') {
      throw new Error('Persisted run is not an X identity request');
    }
    const endpointRows = await tx
      .select({
        endpointId: contentSourceEndpoints.endpointId,
        sourceId: contentSourceEndpoints.sourceId,
        stableExternalId: contentSourceEndpoints.stableExternalId,
      })
      .from(contentSourceEndpoints)
      .where(eq(contentSourceEndpoints.endpointId, run.endpointId))
      .for('update')
      .limit(1);
    const endpoint = endpointRows[0];
    if (!endpoint) throw new Error('X identity endpoint no longer exists');
    const expectedHandle = request.toolRequest.handle;
    const user = oneExactUser(input.execution.users, expectedHandle);
    if (!user) {
      return failIdentityResult({
        tx,
        runId: input.runId,
        endpointId: endpoint.endpointId,
        handle: expectedHandle,
        dbNow,
        failureClass: 'X_IDENTITY_NOT_EXACT',
        summary: 'x_user_search did not return exactly one exact case-insensitive handle match',
        identityStatus: 'FAILED',
        execution: input.execution,
        probeEvidence: input.probeEvidence,
      });
    }

    const endpointConflicts = await tx
      .select({ endpointId: contentSourceEndpoints.endpointId })
      .from(contentSourceEndpoints)
      .where(
        and(
          eq(contentSourceEndpoints.adapterKind, 'X_ACCOUNT'),
          eq(contentSourceEndpoints.stableExternalId, user.userId),
          ne(contentSourceEndpoints.endpointId, endpoint.endpointId),
        ),
      )
      .limit(1);
    const sourceConflicts = await tx
      .select({ sourceId: contentSources.sourceId })
      .from(contentSources)
      .where(
        and(
          eq(contentSources.platform, 'X'),
          eq(contentSources.externalId, user.userId),
          ne(contentSources.sourceId, endpoint.sourceId),
        ),
      )
      .limit(1);
    if (
      (endpoint.stableExternalId !== null && endpoint.stableExternalId !== user.userId) ||
      endpointConflicts.length > 0 ||
      sourceConflicts.length > 0
    ) {
      return failIdentityResult({
        tx,
        runId: input.runId,
        endpointId: endpoint.endpointId,
        handle: expectedHandle,
        dbNow,
        failureClass: 'X_IDENTITY_CONFLICT',
        summary: 'Resolved X user ID conflicts with an existing stable identity',
        identityStatus: 'CONFLICT',
        execution: input.execution,
        probeEvidence: input.probeEvidence,
      });
    }

    if (input.probeEvidence) {
      await insertProbeTrace({ tx, runId: input.runId, evidence: input.probeEvidence });
    }
    await insertProviderTrace({
      tx,
      runId: input.runId,
      execution: input.execution,
      terminalState: 'VERIFIED',
      sequence: input.probeEvidence ? 1 : 0,
    });
    const committedReservations = await commitXRunBudgets({ tx, runId: input.runId, dbNow });
    if (committedReservations === 0) {
      throw new Error('Verified X identity result has no reserved budget');
    }
    await tx
      .update(contentSourceEndpoints)
      .set({
        stableExternalId: user.userId,
        identityStatus: 'VERIFIED',
        identityErrorSummary: null,
        identityCheckedAt: dbNow,
        identityNextCheckAt: new Date(dbNow.getTime() + IDENTITY_REFRESH_MS),
        updatedAt: dbNow,
      })
      .where(eq(contentSourceEndpoints.endpointId, endpoint.endpointId));
    await tx
      .update(contentSources)
      .set({ platform: 'X', externalId: user.userId, handle: user.handle, updatedAt: dbNow })
      .where(eq(contentSources.sourceId, endpoint.sourceId));
    const updatedRun = await tx
      .update(contentAcquisitionRuns)
      .set({
        status: 'COMPLETED',
        provider: 'grok-build',
        providerUnits: String(1 + (input.probeEvidence ? input.probeEvidence.providerUnits : 0)),
        xCallCount: 1 + (input.probeEvidence ? 1 : 0),
        traceVerified: true,
        resultCount: 1,
        rejectedCount: 0,
        runMetrics: {
          durationMs: Math.round(input.execution.durationMs),
          eventCount: input.execution.eventCount,
          inputTokens: input.execution.inputTokens,
          outputTokens: input.execution.outputTokens,
          totalCostUsd: input.execution.totalCostUsd,
          executionLocation: input.execution.executionLocation,
          runnerReleaseSha: input.execution.runnerReleaseSha,
          grokVersion: input.execution.grokVersion,
          runnerBinaryHash: input.execution.runnerBinaryHash,
          rawPostEvidenceAvailable: input.execution.rawPostEvidenceAvailable,
          traceHash: input.execution.traceHash,
          probeCallCount: input.probeEvidence ? 1 : 0,
        },
        completedAt: dbNow,
        leaseExpiresAt: null,
        checkpointAdvanced: false,
      })
      .where(
        and(
          eq(contentAcquisitionRuns.runId, input.runId),
          eq(contentAcquisitionRuns.status, 'RUNNING'),
        ),
      )
      .returning({ runId: contentAcquisitionRuns.runId });
    if (updatedRun.length !== 1) throw new Error('X identity terminal transition was lost');
    return {
      status: 'COMPLETED',
      identityStatus: 'VERIFIED',
      userId: user.userId,
      handle: user.handle,
    };
  });
}

export async function failXIdentityRun(input: {
  runId: string;
  failureClass: string;
  errorSummary: string;
  providerProcessStarted?: boolean;
  providerExecution?: GrokBuildExecutionResult;
  probeEvidence?: FormalRunProbeEvidence;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const clockRows = await tx.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
    const dbNow = databaseDate(clockRows[0]?.dbNow);
    const rows = await tx
      .select({
        endpointId: contentAcquisitionRuns.endpointId,
        requestSnapshot: contentAcquisitionRuns.requestSnapshot,
        status: contentAcquisitionRuns.status,
      })
      .from(contentAcquisitionRuns)
      .where(eq(contentAcquisitionRuns.runId, input.runId))
      .for('update')
      .limit(1);
    const run = rows[0];
    if (!run?.endpointId || !['PENDING', 'RUNNING'].includes(run.status)) return false;
    const summary = sanitizeError(input.errorSummary);
    const request = parseFormalRunRequestV1(run.requestSnapshot);
    if (request.jobKind !== 'X_IDENTITY' || request.toolRequest.toolName !== 'x_user_search') {
      throw new Error('Failed X identity run has an invalid immutable request');
    }
    if (input.providerExecution && input.providerExecution.toolName !== 'x_user_search') {
      throw new Error('Failed X identity provider evidence used the wrong tool');
    }
    const providerAttempted =
      input.providerExecution !== undefined ||
      input.probeEvidence !== undefined ||
      input.providerProcessStarted === true;
    const mainProviderAttempted =
      input.providerExecution !== undefined || input.providerProcessStarted === true;
    if (providerAttempted) {
      const committedReservations = await commitXRunBudgets({ tx, runId: input.runId, dbNow });
      if (committedReservations === 0) {
        throw new Error('Started X identity provider process has no reserved budget');
      }
    } else {
      await releaseXRunBudgets({ tx, runId: input.runId, dbNow });
    }
    if (input.probeEvidence) {
      await insertProbeTrace({ tx, runId: input.runId, evidence: input.probeEvidence });
    }
    if (input.providerExecution) {
      await insertProviderTrace({
        tx,
        runId: input.runId,
        execution: input.providerExecution,
        terminalState: 'ATTESTED_PROCESSING_FAILED',
        sequence: input.probeEvidence ? 1 : 0,
      });
    }
    await tx
      .update(contentSourceEndpoints)
      .set({
        identityStatus: 'FAILED',
        identityErrorSummary: summary,
        identityCheckedAt: dbNow,
        identityNextCheckAt: new Date(dbNow.getTime() + IDENTITY_RETRY_MS),
        updatedAt: dbNow,
      })
      .where(
        and(
          eq(contentSourceEndpoints.endpointId, run.endpointId),
          ne(contentSourceEndpoints.identityStatus, 'CONFLICT'),
        ),
      );
    await tx
      .update(contentAcquisitionRuns)
      .set({
        status: 'FAILED',
        failureClass: input.failureClass,
        errorSummary: summary,
        failureDetailsHash: sha256CanonicalJson({
          failureClass: input.failureClass,
          summary,
        }),
        provider: providerAttempted ? 'grok-build' : undefined,
        providerUnits: providerAttempted
          ? String(
              (mainProviderAttempted ? 1 : 0) +
                (input.probeEvidence ? input.probeEvidence.providerUnits : 0) || 1,
            )
          : undefined,
        xCallCount: providerAttempted
          ? (mainProviderAttempted ? 1 : 0) + (input.probeEvidence ? 1 : 0) || 1
          : 0,
        traceVerified: input.providerExecution !== undefined,
        runMetrics: input.providerExecution
          ? {
              durationMs: Math.round(input.providerExecution.durationMs),
              eventCount: input.providerExecution.eventCount,
              inputTokens: input.providerExecution.inputTokens,
              outputTokens: input.providerExecution.outputTokens,
              totalCostUsd: input.providerExecution.totalCostUsd,
              executionLocation: input.providerExecution.executionLocation,
              runnerReleaseSha: input.providerExecution.runnerReleaseSha,
              grokVersion: input.providerExecution.grokVersion,
              runnerBinaryHash: input.providerExecution.runnerBinaryHash,
              rawPostEvidenceAvailable: input.providerExecution.rawPostEvidenceAvailable,
              traceHash: input.providerExecution.traceHash,
              probeCallCount: input.probeEvidence ? 1 : 0,
            }
          : providerAttempted
            ? {
                providerProcessStarted: mainProviderAttempted,
                controlPlaneProbeProcessStarted: input.probeEvidence !== undefined,
                providerTraceVerified: false,
                probeCallCount: input.probeEvidence ? 1 : 0,
              }
            : {},
        completedAt: dbNow,
        leaseExpiresAt: null,
        checkpointAdvanced: false,
      })
      .where(eq(contentAcquisitionRuns.runId, input.runId));
    return true;
  });
}
