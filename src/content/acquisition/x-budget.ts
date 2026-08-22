import { randomUUID } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  contentAcquisitionBudgetLedgers,
  contentAcquisitionBudgetReservations,
} from '../../db/schemas/content.schema';
import type { TransactionHandle } from '../../db/singleton';
import type { BriefingCoverageReport } from './acquisition-manifest';
import type { AcquisitionPhase, XAcquisitionLane } from './acquisition-profiles';

export type XBudgetLane = XAcquisitionLane | 'IDENTITY';

export type XBudgetPolicy = Readonly<{
  globalRolling24hLimit: number;
  final90Rolling90mLimit: number;
  identityRolling24hLimit: number;
  laneCaps: BriefingCoverageReport['xLaneCallCaps'];
  laneWindowMinutes: BriefingCoverageReport['xForecastWindowMinutes'];
}>;

export type XBudgetReservationResult = Readonly<{
  reserved: boolean;
  deferredScope: string | null;
  remainingBeforeReservation: number;
  reservationIds: readonly string[];
}>;

type BudgetScope = Readonly<{
  scopeKind: 'GLOBAL' | 'LANE' | 'PROVIDER';
  scopeKey: string;
  windowMinutes: number;
  limit: number;
}>;

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function compileXBudgetPolicy(input: {
  coverage: BriefingCoverageReport;
  globalRolling24hLimit: number;
  final90Rolling90mLimit: number;
  identityRolling24hLimit?: number;
}): XBudgetPolicy {
  return {
    globalRolling24hLimit: positiveInteger(
      'CONTENT_X_DAILY_CALL_LIMIT',
      input.globalRolling24hLimit,
    ),
    final90Rolling90mLimit: positiveInteger(
      'CONTENT_X_FINAL90_CALL_LIMIT',
      input.final90Rolling90mLimit,
    ),
    identityRolling24hLimit: positiveInteger(
      'X identity rolling limit',
      input.identityRolling24hLimit ?? 100,
    ),
    laneCaps: input.coverage.xLaneCallCaps,
    laneWindowMinutes: input.coverage.xForecastWindowMinutes,
  };
}

function budgetScopes(input: {
  phase: AcquisitionPhase;
  lane: XBudgetLane;
  policy: XBudgetPolicy;
}): readonly BudgetScope[] {
  const laneLimit =
    input.lane === 'IDENTITY'
      ? input.policy.identityRolling24hLimit
      : input.policy.laneCaps[input.phase][input.lane];
  const laneWindowMinutes =
    input.lane === 'IDENTITY' ? 24 * 60 : input.policy.laneWindowMinutes[input.phase];
  const scopes: BudgetScope[] = [
    {
      scopeKind: 'GLOBAL',
      scopeKey: 'GROK_BUILD_X',
      windowMinutes: 24 * 60,
      limit: input.policy.globalRolling24hLimit,
    },
    {
      scopeKind: 'LANE',
      // Lane caps are phase-specific.  Keeping one key would let a burst in
      // APPROACHING consume the same rolling bucket that FINAL90/NORMAL use,
      // making the configured cadence depend on whichever phase happened
      // first.  The global and FINAL90 provider scopes remain shared guards.
      scopeKey: input.lane === 'IDENTITY' ? input.lane : `${input.phase}:${input.lane}`,
      windowMinutes: laneWindowMinutes,
      limit: laneLimit,
    },
  ];
  if (input.phase === 'FINAL90') {
    scopes.push({
      scopeKind: 'PROVIDER',
      scopeKey: 'GROK_BUILD_X_FINAL90',
      windowMinutes: 90,
      limit: input.policy.final90Rolling90mLimit,
    });
  }
  return scopes;
}

function hourBucket(dbNow: Date): { windowStart: Date; windowEnd: Date } {
  const windowStart = new Date(dbNow);
  windowStart.setUTCMinutes(0, 0, 0);
  return { windowStart, windowEnd: new Date(windowStart.getTime() + 60 * 60_000) };
}

export async function reserveXRunBudgets(input: {
  tx: TransactionHandle;
  runId: string;
  phase: AcquisitionPhase;
  lane: XBudgetLane;
  dbNow: Date;
  policy: XBudgetPolicy;
  units?: number;
}): Promise<XBudgetReservationResult> {
  const requestedUnits = input.units ?? 1;
  if (!Number.isSafeInteger(requestedUnits) || requestedUnits < 1) {
    throw new Error('X budget reservation units must be a positive integer');
  }
  await input.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('briefing-x-budget-v1'))`);
  const scopes = budgetScopes(input);
  const usage: Array<{ scope: BudgetScope; used: number }> = [];
  for (const scope of scopes) {
    const rows = await input.tx.execute<{ used: string | number }>(sql`
      SELECT COALESCE(sum(reservation.units), 0) AS used
      FROM content.acquisition_budget_reservations AS reservation
      JOIN content.acquisition_budget_ledgers AS ledger
        ON ledger.ledger_id = reservation.ledger_id
      WHERE ledger.scope_kind = ${scope.scopeKind}
        AND ledger.scope_key = ${scope.scopeKey}
        AND ledger.unit_kind = 'CALL'
        AND reservation.status IN ('RESERVED', 'COMMITTED')
        AND reservation.created_at > ${new Date(
          input.dbNow.getTime() - scope.windowMinutes * 60_000,
        ).toISOString()}::timestamptz
    `);
    const used = Number(rows[0]?.used ?? 0);
    if (!Number.isFinite(used) || used < 0) throw new Error('X budget usage is invalid');
    usage.push({ scope, used });
    if (used + requestedUnits > scope.limit) {
      return {
        reserved: false,
        deferredScope: `${scope.scopeKind}:${scope.scopeKey}`,
        remainingBeforeReservation: Math.max(0, scope.limit - used),
        reservationIds: [],
      };
    }
  }

  const bucket = hourBucket(input.dbNow);
  const reservationIds: string[] = [];
  for (const { scope, used } of usage) {
    const ledgerRows = await input.tx
      .insert(contentAcquisitionBudgetLedgers)
      .values({
        ledgerId: randomUUID(),
        scopeKind: scope.scopeKind,
        scopeKey: scope.scopeKey,
        unitKind: 'CALL',
        windowStart: bucket.windowStart,
        windowEnd: bucket.windowEnd,
        maxUnits: String(scope.limit),
      })
      .onConflictDoUpdate({
        target: [
          contentAcquisitionBudgetLedgers.scopeKind,
          contentAcquisitionBudgetLedgers.scopeKey,
          contentAcquisitionBudgetLedgers.unitKind,
          contentAcquisitionBudgetLedgers.windowStart,
          contentAcquisitionBudgetLedgers.windowEnd,
        ],
        set: {
          maxUnits: sql`GREATEST(
            ${contentAcquisitionBudgetLedgers.maxUnits},
            ${contentAcquisitionBudgetLedgers.reservedUnits} + ${contentAcquisitionBudgetLedgers.committedUnits},
            ${scope.limit}
          )`,
          updatedAt: input.dbNow,
        },
      })
      .returning({ ledgerId: contentAcquisitionBudgetLedgers.ledgerId });
    const ledger = ledgerRows[0];
    if (!ledger) throw new Error('X budget ledger reservation was lost');
    await input.tx
      .update(contentAcquisitionBudgetLedgers)
      .set({
        reservedUnits: sql`${contentAcquisitionBudgetLedgers.reservedUnits} + ${requestedUnits}`,
        updatedAt: input.dbNow,
      })
      .where(eq(contentAcquisitionBudgetLedgers.ledgerId, ledger.ledgerId));
    const existing = await input.tx
      .select({
        reservationId: contentAcquisitionBudgetReservations.reservationId,
        status: contentAcquisitionBudgetReservations.status,
      })
      .from(contentAcquisitionBudgetReservations)
      .where(
        and(
          eq(contentAcquisitionBudgetReservations.runId, input.runId),
          eq(contentAcquisitionBudgetReservations.ledgerId, ledger.ledgerId),
        ),
      )
      .for('update')
      .limit(1);
    if (existing[0]) {
      if (existing[0].status !== 'RESERVED') {
        throw new Error('X budget reservation cannot be increased after transition');
      }
      await input.tx
        .update(contentAcquisitionBudgetReservations)
        .set({
          units: sql`${contentAcquisitionBudgetReservations.units} + ${requestedUnits}`,
          updatedAt: input.dbNow,
        })
        .where(eq(contentAcquisitionBudgetReservations.reservationId, existing[0].reservationId));
      reservationIds.push(existing[0].reservationId);
    } else {
      const reservationId = randomUUID();
      await input.tx.insert(contentAcquisitionBudgetReservations).values({
        reservationId,
        ledgerId: ledger.ledgerId,
        runId: input.runId,
        units: String(requestedUnits),
        status: 'RESERVED',
        createdAt: input.dbNow,
        updatedAt: input.dbNow,
      });
      reservationIds.push(reservationId);
    }
    if (used + requestedUnits > scope.limit)
      throw new Error('X budget reservation exceeded its hard cap');
  }
  return {
    reserved: true,
    deferredScope: null,
    reservationIds,
    remainingBeforeReservation: Math.min(
      ...usage.map(({ scope, used }) => Math.max(0, scope.limit - used - requestedUnits)),
    ),
  };
}

export async function releaseOneXRunBudgetUnit(input: {
  tx: TransactionHandle;
  runId: string;
  dbNow: Date;
  reservationIds: readonly string[];
}): Promise<boolean> {
  const reservationIds = [...new Set(input.reservationIds)];
  if (reservationIds.length === 0) return false;
  await input.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('briefing-x-budget-v1'))`);
  const reservations = await input.tx
    .select({
      reservationId: contentAcquisitionBudgetReservations.reservationId,
      ledgerId: contentAcquisitionBudgetReservations.ledgerId,
      units: contentAcquisitionBudgetReservations.units,
    })
    .from(contentAcquisitionBudgetReservations)
    .where(
      and(
        eq(contentAcquisitionBudgetReservations.runId, input.runId),
        inArray(contentAcquisitionBudgetReservations.reservationId, reservationIds),
        eq(contentAcquisitionBudgetReservations.status, 'RESERVED'),
      ),
    )
    .for('update');
  if (reservations.length !== reservationIds.length) {
    throw new Error('X probe budget reservation disappeared before release');
  }
  for (const reservation of reservations) {
    const units = Number(reservation.units);
    if (!Number.isSafeInteger(units) || units < 1) {
      throw new Error('X budget reservation is invalid');
    }
    if (units === 1) {
      await input.tx
        .update(contentAcquisitionBudgetReservations)
        .set({ status: 'RELEASED', updatedAt: input.dbNow })
        .where(eq(contentAcquisitionBudgetReservations.reservationId, reservation.reservationId));
    } else {
      await input.tx
        .update(contentAcquisitionBudgetReservations)
        .set({
          units: String(units - 1),
          updatedAt: input.dbNow,
        })
        .where(eq(contentAcquisitionBudgetReservations.reservationId, reservation.reservationId));
    }
    await input.tx
      .update(contentAcquisitionBudgetLedgers)
      .set({
        reservedUnits: sql`${contentAcquisitionBudgetLedgers.reservedUnits} - 1`,
        updatedAt: input.dbNow,
      })
      .where(eq(contentAcquisitionBudgetLedgers.ledgerId, reservation.ledgerId));
  }
  return true;
}

async function transitionRunBudgets(input: {
  tx: TransactionHandle;
  runId: string;
  target: 'COMMITTED' | 'RELEASED';
  dbNow: Date;
}): Promise<number> {
  const reservations = await input.tx
    .select({
      reservationId: contentAcquisitionBudgetReservations.reservationId,
      ledgerId: contentAcquisitionBudgetReservations.ledgerId,
      units: contentAcquisitionBudgetReservations.units,
    })
    .from(contentAcquisitionBudgetReservations)
    .where(
      and(
        eq(contentAcquisitionBudgetReservations.runId, input.runId),
        eq(contentAcquisitionBudgetReservations.status, 'RESERVED'),
      ),
    )
    .for('update');
  for (const reservation of reservations) {
    const units = Number(reservation.units);
    if (!Number.isFinite(units) || units <= 0) throw new Error('Run budget reservation is invalid');
    await input.tx
      .update(contentAcquisitionBudgetReservations)
      .set({ status: input.target, updatedAt: input.dbNow })
      .where(
        and(
          eq(contentAcquisitionBudgetReservations.reservationId, reservation.reservationId),
          eq(contentAcquisitionBudgetReservations.status, 'RESERVED'),
        ),
      );
    await input.tx
      .update(contentAcquisitionBudgetLedgers)
      .set({
        reservedUnits: sql`${contentAcquisitionBudgetLedgers.reservedUnits} - ${units}`,
        committedUnits:
          input.target === 'COMMITTED'
            ? sql`${contentAcquisitionBudgetLedgers.committedUnits} + ${units}`
            : contentAcquisitionBudgetLedgers.committedUnits,
        updatedAt: input.dbNow,
      })
      .where(eq(contentAcquisitionBudgetLedgers.ledgerId, reservation.ledgerId));
  }
  return reservations.length;
}

export async function commitXRunBudgets(input: {
  tx: TransactionHandle;
  runId: string;
  dbNow: Date;
}): Promise<number> {
  return transitionRunBudgets({ ...input, target: 'COMMITTED' });
}

export async function releaseXRunBudgets(input: {
  tx: TransactionHandle;
  runId: string;
  dbNow: Date;
}): Promise<number> {
  return transitionRunBudgets({ ...input, target: 'RELEASED' });
}

export const commitRunBudgets = commitXRunBudgets;
export const releaseRunBudgets = releaseXRunBudgets;

export async function reconcileReservedProviderBudget(input: {
  tx: TransactionHandle;
  runId: string;
  scopeKey: string;
  unitKind: string;
  actualUnits: number;
  dbNow: Date;
}): Promise<boolean> {
  if (!Number.isFinite(input.actualUnits) || input.actualUnits < 0) {
    throw new Error('Actual provider units must be a non-negative number');
  }
  const rows = await input.tx.execute<{
    reservationId: string;
    ledgerId: string;
    units: string | number;
    status: string;
  }>(sql`
    SELECT reservation.reservation_id AS "reservationId",
           reservation.ledger_id AS "ledgerId",
           reservation.units,
           reservation.status
    FROM content.acquisition_budget_reservations AS reservation
    JOIN content.acquisition_budget_ledgers AS ledger
      ON ledger.ledger_id = reservation.ledger_id
    WHERE reservation.run_id = ${input.runId}::uuid
      AND reservation.status IN ('RESERVED', 'COMMITTED')
      AND ledger.scope_kind = 'PROVIDER'
      AND ledger.scope_key = ${input.scopeKey}
      AND ledger.unit_kind = ${input.unitKind}
    FOR UPDATE OF reservation
  `);
  if (rows.length === 0) return false;
  if (rows.length !== 1) throw new Error('Provider run has multiple matching budget reservations');
  const row = rows[0]!;
  const reservedUnits = Number(row.units);
  if (!Number.isFinite(reservedUnits) || reservedUnits <= 0) {
    throw new Error('Provider budget reservation is invalid');
  }
  const delta = input.actualUnits - reservedUnits;
  await input.tx
    .update(contentAcquisitionBudgetReservations)
    .set({ units: String(input.actualUnits), updatedAt: input.dbNow })
    .where(eq(contentAcquisitionBudgetReservations.reservationId, row.reservationId));
  await input.tx
    .update(contentAcquisitionBudgetLedgers)
    .set({
      reservedUnits:
        row.status === 'RESERVED'
          ? sql`${contentAcquisitionBudgetLedgers.reservedUnits} + ${delta}`
          : contentAcquisitionBudgetLedgers.reservedUnits,
      committedUnits:
        row.status === 'COMMITTED'
          ? sql`${contentAcquisitionBudgetLedgers.committedUnits} + ${delta}`
          : contentAcquisitionBudgetLedgers.committedUnits,
      maxUnits: sql`GREATEST(
        ${contentAcquisitionBudgetLedgers.maxUnits},
        ${contentAcquisitionBudgetLedgers.reservedUnits}
          + ${contentAcquisitionBudgetLedgers.committedUnits}
          + ${delta}
      )`,
      updatedAt: input.dbNow,
    })
    .where(eq(contentAcquisitionBudgetLedgers.ledgerId, row.ledgerId));
  return true;
}

export async function xRunBudgetStatuses(input: {
  tx: TransactionHandle;
  runId: string;
}): Promise<readonly string[]> {
  const rows = await input.tx
    .select({ status: contentAcquisitionBudgetReservations.status })
    .from(contentAcquisitionBudgetReservations)
    .where(
      and(
        eq(contentAcquisitionBudgetReservations.runId, input.runId),
        inArray(contentAcquisitionBudgetReservations.status, ['RESERVED', 'COMMITTED', 'RELEASED']),
      ),
    );
  return rows.map((row) => row.status);
}
