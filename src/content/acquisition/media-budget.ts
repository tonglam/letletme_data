import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import {
  contentAcquisitionBudgetLedgers,
  contentAcquisitionBudgetReservations,
} from '../../db/schemas/content.schema';
import { getDb, type DbHandle } from '../../db/singleton';

export type MediaBudgetReservationResult = Readonly<{
  reserved: boolean;
  remainingSecondsBeforeReservation: number;
}>;

export type ProviderCreditReservationResult = Readonly<{
  reserved: boolean;
  remainingCreditsBeforeReservation: number;
}>;

function hourBucket(dbNow: Date): { windowStart: Date; windowEnd: Date } {
  const windowStart = new Date(dbNow);
  windowStart.setUTCMinutes(0, 0, 0);
  return { windowStart, windowEnd: new Date(windowStart.getTime() + 60 * 60_000) };
}

export async function reserveHermesAudioBudget(input: {
  runId: string;
  audioSeconds: number;
  dailyAudioMinutes: number;
  db?: DbHandle;
}): Promise<MediaBudgetReservationResult> {
  if (!Number.isFinite(input.audioSeconds) || input.audioSeconds <= 0) {
    throw new Error('Hermes audio budget requires positive duration seconds');
  }
  if (!Number.isSafeInteger(input.dailyAudioMinutes) || input.dailyAudioMinutes < 1) {
    throw new Error('Hermes daily audio-minute limit must be a positive integer');
  }
  const units = Math.ceil(input.audioSeconds);
  const maximumUnits = input.dailyAudioMinutes * 60;
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('briefing-hermes-budget-v1'))`);
    const clockRows = await tx.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
    const dbNow = new Date(clockRows[0]?.dbNow ?? Number.NaN);
    if (!Number.isFinite(dbNow.getTime())) throw new Error('Database clock is invalid');
    const existing = await tx
      .select({ status: contentAcquisitionBudgetReservations.status })
      .from(contentAcquisitionBudgetReservations)
      .innerJoin(
        contentAcquisitionBudgetLedgers,
        eq(contentAcquisitionBudgetLedgers.ledgerId, contentAcquisitionBudgetReservations.ledgerId),
      )
      .where(
        and(
          eq(contentAcquisitionBudgetReservations.runId, input.runId),
          eq(contentAcquisitionBudgetLedgers.scopeKind, 'PROVIDER'),
          eq(contentAcquisitionBudgetLedgers.scopeKey, 'HERMES_TRANSCRIPT'),
          eq(contentAcquisitionBudgetLedgers.unitKind, 'AUDIO_SECOND'),
        ),
      )
      .limit(1);
    if (existing[0] && ['RESERVED', 'COMMITTED'].includes(existing[0].status)) {
      return { reserved: true, remainingSecondsBeforeReservation: 0 };
    }
    const usageRows = await tx.execute<{ used: string | number }>(sql`
      SELECT COALESCE(sum(reservation.units), 0) AS used
      FROM content.acquisition_budget_reservations AS reservation
      JOIN content.acquisition_budget_ledgers AS ledger
        ON ledger.ledger_id = reservation.ledger_id
      WHERE ledger.scope_kind = 'PROVIDER'
        AND ledger.scope_key = 'HERMES_TRANSCRIPT'
        AND ledger.unit_kind = 'AUDIO_SECOND'
        AND reservation.status IN ('RESERVED', 'COMMITTED')
        AND reservation.created_at > ${new Date(
          dbNow.getTime() - 24 * 60 * 60_000,
        ).toISOString()}::timestamptz
    `);
    const used = Number(usageRows[0]?.used ?? 0);
    if (!Number.isFinite(used) || used < 0) throw new Error('Hermes budget usage is invalid');
    const remaining = Math.max(0, maximumUnits - used);
    if (used + units > maximumUnits) {
      return { reserved: false, remainingSecondsBeforeReservation: remaining };
    }
    const bucket = hourBucket(dbNow);
    const ledgerRows = await tx
      .insert(contentAcquisitionBudgetLedgers)
      .values({
        ledgerId: randomUUID(),
        scopeKind: 'PROVIDER',
        scopeKey: 'HERMES_TRANSCRIPT',
        unitKind: 'AUDIO_SECOND',
        windowStart: bucket.windowStart,
        windowEnd: bucket.windowEnd,
        maxUnits: String(maximumUnits),
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
            ${maximumUnits}
          )`,
          updatedAt: dbNow,
        },
      })
      .returning({ ledgerId: contentAcquisitionBudgetLedgers.ledgerId });
    const ledger = ledgerRows[0];
    if (!ledger) throw new Error('Hermes budget ledger reservation was lost');
    await tx
      .update(contentAcquisitionBudgetLedgers)
      .set({
        reservedUnits: sql`${contentAcquisitionBudgetLedgers.reservedUnits} + ${units}`,
        updatedAt: dbNow,
      })
      .where(eq(contentAcquisitionBudgetLedgers.ledgerId, ledger.ledgerId));
    await tx.insert(contentAcquisitionBudgetReservations).values({
      reservationId: randomUUID(),
      ledgerId: ledger.ledgerId,
      runId: input.runId,
      units: String(units),
      status: 'RESERVED',
      createdAt: dbNow,
      updatedAt: dbNow,
    });
    return {
      reserved: true,
      remainingSecondsBeforeReservation: Math.max(0, remaining - units),
    };
  });
}

export async function reserveSupadataCreditBudget(input: {
  runId: string;
  expectedCredits: number;
  dailyCreditLimit: number;
  db?: DbHandle;
}): Promise<ProviderCreditReservationResult> {
  if (!Number.isSafeInteger(input.expectedCredits) || input.expectedCredits < 1) {
    throw new Error('Supadata budget requires positive integer expected credits');
  }
  if (!Number.isSafeInteger(input.dailyCreditLimit) || input.dailyCreditLimit < 1) {
    throw new Error('Supadata daily credit limit must be a positive integer');
  }
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('briefing-supadata-budget-v1'))`);
    const clockRows = await tx.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
    const dbNow = new Date(clockRows[0]?.dbNow ?? Number.NaN);
    if (!Number.isFinite(dbNow.getTime())) throw new Error('Database clock is invalid');
    const existing = await tx
      .select({ status: contentAcquisitionBudgetReservations.status })
      .from(contentAcquisitionBudgetReservations)
      .innerJoin(
        contentAcquisitionBudgetLedgers,
        eq(contentAcquisitionBudgetLedgers.ledgerId, contentAcquisitionBudgetReservations.ledgerId),
      )
      .where(
        and(
          eq(contentAcquisitionBudgetReservations.runId, input.runId),
          eq(contentAcquisitionBudgetLedgers.scopeKind, 'PROVIDER'),
          eq(contentAcquisitionBudgetLedgers.scopeKey, 'SUPADATA_TRANSCRIPT'),
          eq(contentAcquisitionBudgetLedgers.unitKind, 'CREDIT'),
        ),
      )
      .limit(1);
    if (existing[0] && ['RESERVED', 'COMMITTED'].includes(existing[0].status)) {
      return { reserved: true, remainingCreditsBeforeReservation: 0 };
    }
    const usageRows = await tx.execute<{ used: string | number }>(sql`
      SELECT COALESCE(sum(reservation.units), 0) AS used
      FROM content.acquisition_budget_reservations AS reservation
      JOIN content.acquisition_budget_ledgers AS ledger
        ON ledger.ledger_id = reservation.ledger_id
      WHERE ledger.scope_kind = 'PROVIDER'
        AND ledger.scope_key = 'SUPADATA_TRANSCRIPT'
        AND ledger.unit_kind = 'CREDIT'
        AND reservation.status IN ('RESERVED', 'COMMITTED')
        AND reservation.created_at > ${new Date(
          dbNow.getTime() - 24 * 60 * 60_000,
        ).toISOString()}::timestamptz
    `);
    const used = Number(usageRows[0]?.used ?? 0);
    if (!Number.isFinite(used) || used < 0) throw new Error('Supadata budget usage is invalid');
    const remaining = Math.max(0, input.dailyCreditLimit - used);
    if (used + input.expectedCredits > input.dailyCreditLimit) {
      return { reserved: false, remainingCreditsBeforeReservation: remaining };
    }
    const bucket = hourBucket(dbNow);
    const ledgerRows = await tx
      .insert(contentAcquisitionBudgetLedgers)
      .values({
        ledgerId: randomUUID(),
        scopeKind: 'PROVIDER',
        scopeKey: 'SUPADATA_TRANSCRIPT',
        unitKind: 'CREDIT',
        windowStart: bucket.windowStart,
        windowEnd: bucket.windowEnd,
        maxUnits: String(input.dailyCreditLimit),
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
            ${contentAcquisitionBudgetLedgers.reservedUnits}
              + ${contentAcquisitionBudgetLedgers.committedUnits},
            ${input.dailyCreditLimit}
          )`,
          updatedAt: dbNow,
        },
      })
      .returning({ ledgerId: contentAcquisitionBudgetLedgers.ledgerId });
    const ledger = ledgerRows[0];
    if (!ledger) throw new Error('Supadata budget ledger reservation was lost');
    await tx
      .update(contentAcquisitionBudgetLedgers)
      .set({
        reservedUnits: sql`${contentAcquisitionBudgetLedgers.reservedUnits} + ${input.expectedCredits}`,
        updatedAt: dbNow,
      })
      .where(eq(contentAcquisitionBudgetLedgers.ledgerId, ledger.ledgerId));
    await tx.insert(contentAcquisitionBudgetReservations).values({
      reservationId: randomUUID(),
      ledgerId: ledger.ledgerId,
      runId: input.runId,
      units: String(input.expectedCredits),
      status: 'RESERVED',
      createdAt: dbNow,
      updatedAt: dbNow,
    });
    return {
      reserved: true,
      remainingCreditsBeforeReservation: Math.max(0, remaining - input.expectedCredits),
    };
  });
}
