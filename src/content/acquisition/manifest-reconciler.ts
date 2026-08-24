import { createHash, randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';

import {
  contentAcquisitionRuns,
  contentSourceEndpoints,
  contentSourcePartitionMembers,
  contentSourcePartitions,
  contentSourceRegistryReconciliations,
  contentSourceSchedules,
  contentSources,
} from '../../db/schemas/content.schema';
import { getDb, type DbHandle } from '../../db/singleton';
import { getContentRuntimeFlags } from '../config';
import { canonicalJson, sha256CanonicalJson, type JsonValue } from './canonicalization';
import { getAcquisitionProfile, type AdapterKind } from './acquisition-profiles';
import type { BriefingManifestBundle } from './acquisition-manifest';
import {
  compileBriefingRegistryState,
  nextBackstopDueAt,
  type DesiredSourceEndpoint,
} from './registry-state';
import { releaseXRunBudgets } from './x-budget';

const IDENTITY_REFRESH_MS = 30 * 24 * 60 * 60_000;
const RECONCILE_LOCK_KEY = 'briefing-source-registry-v1';

type ExistingEndpointIdentity = Readonly<{
  adapterKind: string;
  profileKey: string;
  locator: unknown;
  stableExternalId: string | null;
  identityStatus: string;
  identityErrorSummary: string | null;
  identityCheckedAt: Date | null;
  identityNextCheckAt: Date | null;
}>;

type EndpointIdentityState = Readonly<{
  stableExternalId: string | null;
  identityStatus: 'PENDING' | 'VERIFIED' | 'CONFLICT' | 'FAILED';
  identityErrorSummary: string | null;
  identityCheckedAt: Date | null;
  identityNextCheckAt: Date | null;
}>;

export type BriefingRegistryReconcileResult = Readonly<{
  reconciliationId: string;
  status: 'APPLIED' | 'UNCHANGED';
  manifestHash: string;
  entityCount: number;
  endpointCount: number;
  partitionCount: number;
  scheduleCount: number;
  fullRolloutEligible: boolean;
}>;

function canonicalLocator(locator: unknown): string {
  return canonicalJson(locator as JsonValue);
}

function configuredStableIdentity(endpoint: DesiredSourceEndpoint): string | null {
  if (endpoint.adapterKind === 'X_SEMANTIC') {
    return endpoint.locator.semanticProfileKey ?? null;
  }
  if (endpoint.adapterKind === 'YOUTUBE_CHANNEL') return endpoint.locator.channelId ?? null;
  return null;
}

export function initialEndpointIdentity(
  endpoint: DesiredSourceEndpoint,
  now: Date,
): EndpointIdentityState {
  const stableExternalId = configuredStableIdentity(endpoint);
  if (stableExternalId) {
    return {
      stableExternalId,
      identityStatus: 'VERIFIED',
      identityErrorSummary: null,
      identityCheckedAt: now,
      identityNextCheckAt:
        endpoint.adapterKind === 'YOUTUBE_CHANNEL'
          ? new Date(now.getTime() + IDENTITY_REFRESH_MS)
          : null,
    };
  }
  return {
    stableExternalId: null,
    identityStatus: 'PENDING',
    identityErrorSummary: null,
    identityCheckedAt: null,
    identityNextCheckAt: now,
  };
}

export function reconcileEndpointIdentity(input: {
  endpoint: DesiredSourceEndpoint;
  existing?: ExistingEndpointIdentity;
  now: Date;
}): EndpointIdentityState {
  const initial = initialEndpointIdentity(input.endpoint, input.now);
  if (!input.existing) return initial;

  const adapterChanged = input.existing.adapterKind !== input.endpoint.adapterKind;
  const locatorChanged =
    canonicalLocator(input.existing.locator) !== canonicalLocator(input.endpoint.locator);
  const configuredIdentity = configuredStableIdentity(input.endpoint);

  if (
    input.existing.stableExternalId &&
    (adapterChanged ||
      (configuredIdentity !== null && input.existing.stableExternalId !== configuredIdentity))
  ) {
    return {
      stableExternalId: input.existing.stableExternalId,
      identityStatus: 'CONFLICT',
      identityErrorSummary: 'Manifest locator conflicts with the previously verified stable ID',
      identityCheckedAt: input.existing.identityCheckedAt,
      identityNextCheckAt: null,
    };
  }

  if (configuredIdentity) {
    return {
      ...initial,
      stableExternalId: configuredIdentity,
      identityCheckedAt: input.existing.identityCheckedAt ?? input.now,
    };
  }

  if (adapterChanged || locatorChanged) {
    return {
      stableExternalId: input.existing.stableExternalId,
      identityStatus: 'PENDING',
      identityErrorSummary: null,
      identityCheckedAt: input.existing.identityCheckedAt,
      identityNextCheckAt: input.now,
    };
  }

  return {
    stableExternalId: input.existing.stableExternalId,
    identityStatus: input.existing.identityStatus as EndpointIdentityState['identityStatus'],
    identityErrorSummary: input.existing.identityErrorSummary,
    identityCheckedAt: input.existing.identityCheckedAt,
    identityNextCheckAt: input.existing.identityNextCheckAt,
  };
}

export function deterministicScheduleJitterMs(input: {
  scheduleKey: string;
  adapterKind: AdapterKind;
  profileKey: string;
}): number {
  const profile = getAcquisitionProfile(input.profileKey);
  if (!profile || profile.adapterKind !== input.adapterKind) {
    throw new Error(`Invalid schedule profile ${input.profileKey} for ${input.adapterKind}`);
  }
  const cadenceMs = profile.cadenceMinutes.NORMAL * 60_000;
  const hash = createHash('sha256').update(input.scheduleKey, 'utf8').digest();
  return hash.readUInt32BE(0) % cadenceMs;
}

function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 1_000) || 'Unknown reconcile failure';
}

export async function reconcileBriefingSourceRegistry(input: {
  bundle: BriefingManifestBundle;
  gitRevision?: string | null;
  includeXBackstop?: boolean;
  db?: DbHandle;
}): Promise<BriefingRegistryReconcileResult> {
  const includeXBackstop = input.includeXBackstop ?? getContentRuntimeFlags().xBackstopEnabled;
  const state = compileBriefingRegistryState(input.bundle, { includeXBackstop });
  const db = input.db ?? (await getDb());
  const counts = {
    entityCount: state.entities.length,
    endpointCount: state.endpoints.length,
    partitionCount: state.partitions.length,
    scheduleCount: state.schedules.length,
  };
  const reconciliationId = randomUUID();

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${RECONCILE_LOCK_KEY}))`);
      const clockRows = await tx.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
      const dbNow = new Date(clockRows[0]?.dbNow ?? Date.now());
      if (!Number.isFinite(dbNow.getTime())) throw new Error('Database clock is invalid');

      await tx.insert(contentSourceRegistryReconciliations).values({
        reconciliationId,
        manifestHash: state.manifestHash,
        gitRevision: input.gitRevision ?? null,
        status: 'RUNNING',
        ...counts,
        details: {
          fullRolloutEligible: input.bundle.coverage.fullRolloutEligible,
          includeXBackstop,
        },
      });

      const existingSources = await tx
        .select({
          sourceId: contentSources.sourceId,
          sourceKey: contentSources.sourceKey,
          status: contentSources.status,
          manifestRevision: contentSources.manifestRevision,
        })
        .from(contentSources)
        .where(eq(contentSources.origin, 'MANIFEST'))
        .orderBy(asc(contentSources.sourceKey))
        .for('update');
      const sourceIdByKey = new Map(
        existingSources.map((source) => [source.sourceKey, source.sourceId]),
      );
      const desiredSourceKeys = state.entities.map((entity) => entity.sourceKey);
      const desiredEndpointKeys = state.endpoints.map((endpoint) => endpoint.endpointKey);
      const desiredPartitionKeys = state.partitions.map((partition) => partition.partitionKey);
      const desiredScheduleKeyList = state.schedules.map((schedule) => schedule.scheduleKey);
      const [
        sourceDesiredCount,
        endpointDesiredCount,
        partitionDesiredCount,
        scheduleDesiredCount,
      ] = await Promise.all([
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(contentSources)
          .where(
            and(
              eq(contentSources.origin, 'MANIFEST'),
              inArray(contentSources.sourceKey, desiredSourceKeys),
            ),
          ),
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(contentSourceEndpoints)
          .where(inArray(contentSourceEndpoints.endpointKey, desiredEndpointKeys)),
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(contentSourcePartitions)
          .where(inArray(contentSourcePartitions.partitionKey, desiredPartitionKeys)),
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(contentSourceSchedules)
          .where(inArray(contentSourceSchedules.scheduleKey, desiredScheduleKeyList)),
      ]);
      const [
        sourceMismatch,
        sourceExtra,
        endpointMismatch,
        endpointExtra,
        partitionMismatch,
        partitionExtra,
        scheduleMismatch,
        scheduleExtra,
      ] = await Promise.all([
        tx
          .select({ sourceId: contentSources.sourceId })
          .from(contentSources)
          .where(
            and(
              eq(contentSources.origin, 'MANIFEST'),
              inArray(contentSources.sourceKey, desiredSourceKeys),
              sql`${contentSources.manifestRevision} IS DISTINCT FROM ${state.manifestHash}`,
            ),
          )
          .limit(1),
        tx
          .select({ sourceId: contentSources.sourceId })
          .from(contentSources)
          .where(
            and(
              eq(contentSources.origin, 'MANIFEST'),
              eq(contentSources.status, 'active'),
              notInArray(contentSources.sourceKey, desiredSourceKeys),
            ),
          )
          .limit(1),
        tx
          .select({ endpointId: contentSourceEndpoints.endpointId })
          .from(contentSourceEndpoints)
          .where(
            and(
              eq(contentSourceEndpoints.origin, 'MANIFEST'),
              inArray(contentSourceEndpoints.endpointKey, desiredEndpointKeys),
              sql`${contentSourceEndpoints.manifestRevision} IS DISTINCT FROM ${state.manifestHash}`,
            ),
          )
          .limit(1),
        tx
          .select({ endpointId: contentSourceEndpoints.endpointId })
          .from(contentSourceEndpoints)
          .where(
            and(
              eq(contentSourceEndpoints.origin, 'MANIFEST'),
              eq(contentSourceEndpoints.status, 'active'),
              notInArray(contentSourceEndpoints.endpointKey, desiredEndpointKeys),
            ),
          )
          .limit(1),
        tx
          .select({ partitionId: contentSourcePartitions.partitionId })
          .from(contentSourcePartitions)
          .where(
            and(
              inArray(contentSourcePartitions.partitionKey, desiredPartitionKeys),
              sql`${contentSourcePartitions.manifestRevision} IS DISTINCT FROM ${state.manifestHash}`,
            ),
          )
          .limit(1),
        tx
          .select({ partitionId: contentSourcePartitions.partitionId })
          .from(contentSourcePartitions)
          .where(
            and(
              eq(contentSourcePartitions.status, 'active'),
              notInArray(contentSourcePartitions.partitionKey, desiredPartitionKeys),
            ),
          )
          .limit(1),
        tx
          .select({ scheduleId: contentSourceSchedules.scheduleId })
          .from(contentSourceSchedules)
          .where(
            and(
              inArray(contentSourceSchedules.scheduleKey, desiredScheduleKeyList),
              sql`${contentSourceSchedules.manifestRevision} IS DISTINCT FROM ${state.manifestHash}`,
            ),
          )
          .limit(1),
        tx
          .select({ scheduleId: contentSourceSchedules.scheduleId })
          .from(contentSourceSchedules)
          .where(
            and(
              eq(contentSourceSchedules.status, 'active'),
              notInArray(contentSourceSchedules.scheduleKey, desiredScheduleKeyList),
            ),
          )
          .limit(1),
      ]);
      if (
        sourceDesiredCount[0]?.count === desiredSourceKeys.length &&
        endpointDesiredCount[0]?.count === desiredEndpointKeys.length &&
        partitionDesiredCount[0]?.count === desiredPartitionKeys.length &&
        scheduleDesiredCount[0]?.count === desiredScheduleKeyList.length &&
        sourceMismatch.length === 0 &&
        sourceExtra.length === 0 &&
        endpointMismatch.length === 0 &&
        endpointExtra.length === 0 &&
        partitionMismatch.length === 0 &&
        partitionExtra.length === 0 &&
        scheduleMismatch.length === 0 &&
        scheduleExtra.length === 0
      ) {
        await tx
          .update(contentSourceRegistryReconciliations)
          .set({ status: 'UNCHANGED', completedAt: dbNow })
          .where(eq(contentSourceRegistryReconciliations.reconciliationId, reconciliationId));
        return {
          reconciliationId,
          status: 'UNCHANGED',
          manifestHash: state.manifestHash,
          ...counts,
          fullRolloutEligible: input.bundle.coverage.fullRolloutEligible,
        };
      }
      const sourceRows = state.entities.map((entity) => ({
        sourceId: sourceIdByKey.get(entity.sourceKey) ?? randomUUID(),
        sourceKey: entity.sourceKey,
        platform: null,
        externalId: null,
        handle: null,
        displayName: entity.displayName,
        sourceType: entity.sourceType,
        reportingFamily: entity.reportingFamily,
        status: entity.status,
        origin: entity.origin,
        manifestRevision: entity.manifestRevision,
        rightsPolicy: entity.rightsPolicy,
        updatedAt: dbNow,
      }));
      await tx
        .insert(contentSources)
        .values(sourceRows)
        .onConflictDoUpdate({
          target: contentSources.sourceKey,
          set: {
            displayName: sql`excluded.display_name`,
            sourceType: sql`excluded.source_type`,
            reportingFamily: sql`excluded.reporting_family`,
            status: sql`excluded.status`,
            origin: sql`excluded.origin`,
            manifestRevision: sql`excluded.manifest_revision`,
            rightsPolicy: sql`excluded.rights_policy`,
            updatedAt: dbNow,
          },
        });
      await tx
        .update(contentSources)
        .set({ status: 'paused', updatedAt: dbNow })
        .where(
          and(
            eq(contentSources.origin, 'MANIFEST'),
            notInArray(
              contentSources.sourceKey,
              state.entities.map((entity) => entity.sourceKey),
            ),
          ),
        );

      for (const row of sourceRows) sourceIdByKey.set(row.sourceKey, row.sourceId);
      const existingEndpoints = await tx
        .select({
          endpointId: contentSourceEndpoints.endpointId,
          endpointKey: contentSourceEndpoints.endpointKey,
          sourceId: contentSourceEndpoints.sourceId,
          adapterKind: contentSourceEndpoints.adapterKind,
          profileKey: contentSourceEndpoints.profileKey,
          locator: contentSourceEndpoints.locator,
          stableExternalId: contentSourceEndpoints.stableExternalId,
          identityStatus: contentSourceEndpoints.identityStatus,
          identityErrorSummary: contentSourceEndpoints.identityErrorSummary,
          identityCheckedAt: contentSourceEndpoints.identityCheckedAt,
          identityNextCheckAt: contentSourceEndpoints.identityNextCheckAt,
          status: contentSourceEndpoints.status,
          manifestRevision: contentSourceEndpoints.manifestRevision,
        })
        .from(contentSourceEndpoints)
        .where(eq(contentSourceEndpoints.origin, 'MANIFEST'))
        .orderBy(asc(contentSourceEndpoints.endpointKey))
        .for('update');
      const endpointByKey = new Map(
        existingEndpoints.map((endpoint) => [endpoint.endpointKey, endpoint]),
      );
      const endpointRows = state.endpoints.map((endpoint) => {
        const existing = endpointByKey.get(endpoint.endpointKey);
        const identity = reconcileEndpointIdentity({ endpoint, existing, now: dbNow });
        const sourceId = sourceIdByKey.get(endpoint.sourceKey);
        if (!sourceId) throw new Error(`Missing reconciled source ${endpoint.sourceKey}`);
        return {
          endpointId: existing?.endpointId ?? randomUUID(),
          endpointKey: endpoint.endpointKey,
          sourceId,
          adapterKind: endpoint.adapterKind,
          profileKey: endpoint.profileKey,
          locator: endpoint.locator,
          ...identity,
          status: endpoint.status,
          origin: endpoint.origin,
          rightsPolicy: endpoint.rightsPolicy,
          manifestRevision: endpoint.manifestRevision,
          updatedAt: dbNow,
        };
      });
      await tx
        .insert(contentSourceEndpoints)
        .values(endpointRows)
        .onConflictDoUpdate({
          target: contentSourceEndpoints.endpointKey,
          set: {
            sourceId: sql`excluded.source_id`,
            adapterKind: sql`excluded.adapter_kind`,
            profileKey: sql`excluded.profile_key`,
            locator: sql`excluded.locator`,
            stableExternalId: sql`excluded.stable_external_id`,
            identityStatus: sql`excluded.identity_status`,
            identityErrorSummary: sql`excluded.identity_error_summary`,
            identityCheckedAt: sql`excluded.identity_checked_at`,
            identityNextCheckAt: sql`excluded.identity_next_check_at`,
            status: sql`excluded.status`,
            origin: sql`excluded.origin`,
            rightsPolicy: sql`excluded.rights_policy`,
            manifestRevision: sql`excluded.manifest_revision`,
            updatedAt: dbNow,
          },
        });
      await tx
        .update(contentSourceEndpoints)
        .set({ status: 'paused', updatedAt: dbNow })
        .where(
          and(
            eq(contentSourceEndpoints.origin, 'MANIFEST'),
            notInArray(
              contentSourceEndpoints.endpointKey,
              state.endpoints.map((endpoint) => endpoint.endpointKey),
            ),
          ),
        );

      const endpointIdByKey = new Map(
        endpointRows.map((endpoint) => [endpoint.endpointKey, endpoint.endpointId]),
      );
      const existingPartitions = await tx
        .select({
          partitionId: contentSourcePartitions.partitionId,
          partitionKey: contentSourcePartitions.partitionKey,
          adapterKind: contentSourcePartitions.adapterKind,
          profileKey: contentSourcePartitions.profileKey,
          status: contentSourcePartitions.status,
          manifestRevision: contentSourcePartitions.manifestRevision,
        })
        .from(contentSourcePartitions)
        .orderBy(asc(contentSourcePartitions.partitionKey))
        .for('update');
      const partitionIdByKey = new Map(
        existingPartitions.map((partition) => [partition.partitionKey, partition.partitionId]),
      );
      const partitionRows = state.partitions.map((partition) => ({
        partitionId: partitionIdByKey.get(partition.partitionKey) ?? randomUUID(),
        partitionKey: partition.partitionKey,
        adapterKind: partition.adapterKind,
        profileKey: partition.profileKey,
        priority: partition.priority,
        status: partition.status,
        manifestRevision: partition.manifestRevision,
        updatedAt: dbNow,
      }));
      await tx
        .insert(contentSourcePartitions)
        .values(partitionRows)
        .onConflictDoUpdate({
          target: contentSourcePartitions.partitionKey,
          set: {
            adapterKind: sql`excluded.adapter_kind`,
            profileKey: sql`excluded.profile_key`,
            priority: sql`excluded.priority`,
            status: sql`excluded.status`,
            manifestRevision: sql`excluded.manifest_revision`,
            updatedAt: dbNow,
          },
        });
      await tx
        .update(contentSourcePartitions)
        .set({ status: 'paused', updatedAt: dbNow })
        .where(
          notInArray(
            contentSourcePartitions.partitionKey,
            state.partitions.map((partition) => partition.partitionKey),
          ),
        );
      for (const row of partitionRows) {
        partitionIdByKey.set(row.partitionKey, row.partitionId);
      }

      const existingPartitionMembers = await tx
        .select({
          partitionId: contentSourcePartitionMembers.partitionId,
          endpointId: contentSourcePartitionMembers.endpointId,
          position: contentSourcePartitionMembers.position,
        })
        .from(contentSourcePartitionMembers)
        .orderBy(
          asc(contentSourcePartitionMembers.partitionId),
          asc(contentSourcePartitionMembers.position),
        )
        .for('update');
      const existingMemberIdsByPartition = new Map<string, string[]>();
      for (const member of existingPartitionMembers) {
        const members = existingMemberIdsByPartition.get(member.partitionId) ?? [];
        members.push(member.endpointId);
        existingMemberIdsByPartition.set(member.partitionId, members);
      }

      await tx.delete(contentSourcePartitionMembers);
      const memberRows = state.partitions.flatMap((partition) => {
        const partitionId = partitionIdByKey.get(partition.partitionKey);
        if (!partitionId) throw new Error(`Missing reconciled partition ${partition.partitionKey}`);
        return partition.endpointKeys.map((endpointKey, position) => {
          const endpointId = endpointIdByKey.get(endpointKey);
          if (!endpointId) throw new Error(`Missing reconciled endpoint ${endpointKey}`);
          return { partitionId, endpointId, position };
        });
      });
      if (memberRows.length > 0) await tx.insert(contentSourcePartitionMembers).values(memberRows);

      const existingSchedules = await tx
        .select({
          scheduleId: contentSourceSchedules.scheduleId,
          scheduleKey: contentSourceSchedules.scheduleKey,
          endpointId: contentSourceSchedules.endpointId,
          partitionId: contentSourceSchedules.partitionId,
          jobKind: contentSourceSchedules.jobKind,
          adapterKind: contentSourceSchedules.adapterKind,
          profileKey: contentSourceSchedules.profileKey,
          profileRevision: contentSourceSchedules.profileRevision,
          scheduleRole: contentSourceSchedules.scheduleRole,
          status: contentSourceSchedules.status,
          manifestRevision: contentSourceSchedules.manifestRevision,
          nextDueAt: contentSourceSchedules.nextDueAt,
        })
        .from(contentSourceSchedules)
        .orderBy(asc(contentSourceSchedules.scheduleKey))
        .for('update');

      const scheduleByKey = new Map(
        existingSchedules.map((schedule) => [schedule.scheduleKey, schedule]),
      );
      const desiredEndpointByKey = new Map(
        endpointRows.map((endpoint) => [endpoint.endpointKey, endpoint]),
      );
      const existingPartitionByKey = new Map(
        existingPartitions.map((partition) => [partition.partitionKey, partition]),
      );
      const desiredPartitionByKey = new Map(
        partitionRows.map((partition) => [partition.partitionKey, partition]),
      );
      const endpointContractChanged = (endpointKey: string): boolean => {
        const existing = endpointByKey.get(endpointKey);
        const desired = desiredEndpointByKey.get(endpointKey);
        return (
          !existing ||
          !desired ||
          existing.sourceId !== desired.sourceId ||
          existing.adapterKind !== desired.adapterKind ||
          existing.profileKey !== desired.profileKey ||
          canonicalLocator(existing.locator) !== canonicalLocator(desired.locator)
        );
      };
      const partitionContractChanged = (partitionKey: string): boolean => {
        const existing = existingPartitionByKey.get(partitionKey);
        const desired = desiredPartitionByKey.get(partitionKey);
        const desiredState = state.partitions.find(
          (partition) => partition.partitionKey === partitionKey,
        );
        if (!existing || !desired || !desiredState) return true;
        const desiredMemberIds = desiredState.endpointKeys.map((endpointKey) => {
          const endpointId = endpointIdByKey.get(endpointKey);
          if (!endpointId) throw new Error(`Missing partition endpoint ${endpointKey}`);
          return endpointId;
        });
        const existingMemberIds = existingMemberIdsByPartition.get(existing.partitionId) ?? [];
        return (
          existing.adapterKind !== desired.adapterKind ||
          existing.profileKey !== desired.profileKey ||
          canonicalJson(existingMemberIds) !== canonicalJson(desiredMemberIds) ||
          desiredState.endpointKeys.some(endpointContractChanged)
        );
      };
      const changedScheduleIds = new Set<string>();
      const desiredScheduleKeys = new Set(state.schedules.map((schedule) => schedule.scheduleKey));
      for (const existing of existingSchedules) {
        if (!desiredScheduleKeys.has(existing.scheduleKey))
          changedScheduleIds.add(existing.scheduleId);
      }
      for (const schedule of state.schedules) {
        const existing = scheduleByKey.get(schedule.scheduleKey);
        if (!existing) continue;
        const endpointId =
          schedule.target.kind === 'endpoint'
            ? endpointIdByKey.get(schedule.target.endpointKey)
            : null;
        const partitionId =
          schedule.target.kind === 'partition'
            ? partitionIdByKey.get(schedule.target.partitionKey)
            : null;
        const targetChanged =
          existing.endpointId !== endpointId || existing.partitionId !== partitionId;
        const scheduleChanged =
          existing.jobKind !== schedule.jobKind ||
          existing.adapterKind !== schedule.adapterKind ||
          existing.profileKey !== schedule.profileKey ||
          existing.profileRevision !== schedule.profileRevision ||
          existing.scheduleRole !== schedule.scheduleRole;
        const acquisitionTargetChanged =
          schedule.target.kind === 'endpoint'
            ? endpointContractChanged(schedule.target.endpointKey)
            : partitionContractChanged(schedule.target.partitionKey);
        if (targetChanged || scheduleChanged || acquisitionTargetChanged) {
          changedScheduleIds.add(existing.scheduleId);
        }
      }
      const scheduleRows = state.schedules.map((schedule) => {
        const existing = scheduleByKey.get(schedule.scheduleKey);
        const endpointId =
          schedule.target.kind === 'endpoint'
            ? endpointIdByKey.get(schedule.target.endpointKey)
            : null;
        const partitionId =
          schedule.target.kind === 'partition'
            ? partitionIdByKey.get(schedule.target.partitionKey)
            : null;
        if (schedule.target.kind === 'endpoint' && !endpointId) {
          throw new Error(`Missing schedule endpoint ${schedule.target.endpointKey}`);
        }
        if (schedule.target.kind === 'partition' && !partitionId) {
          throw new Error(`Missing schedule partition ${schedule.target.partitionKey}`);
        }
        return {
          scheduleId: existing?.scheduleId ?? randomUUID(),
          scheduleKey: schedule.scheduleKey,
          endpointId,
          partitionId,
          jobKind: schedule.jobKind,
          adapterKind: schedule.adapterKind,
          profileKey: schedule.profileKey,
          profileRevision: schedule.profileRevision,
          scheduleRole: schedule.scheduleRole,
          priority: schedule.priority,
          status: schedule.status,
          nextDueAt:
            existing && !changedScheduleIds.has(existing.scheduleId)
              ? existing.nextDueAt
              : schedule.scheduleRole === 'BACKSTOP'
                ? nextBackstopDueAt(dbNow, schedule.scheduleKey)
                : new Date(
                    dbNow.getTime() +
                      deterministicScheduleJitterMs({
                        scheduleKey: schedule.scheduleKey,
                        adapterKind: schedule.adapterKind,
                        profileKey: schedule.profileKey,
                      }),
                  ),
          manifestRevision: schedule.manifestRevision,
          updatedAt: dbNow,
        };
      });
      await tx
        .insert(contentSourceSchedules)
        .values(scheduleRows)
        .onConflictDoUpdate({
          target: contentSourceSchedules.scheduleKey,
          set: {
            endpointId: sql`excluded.endpoint_id`,
            partitionId: sql`excluded.partition_id`,
            jobKind: sql`excluded.job_kind`,
            adapterKind: sql`excluded.adapter_kind`,
            profileKey: sql`excluded.profile_key`,
            profileRevision: sql`excluded.profile_revision`,
            scheduleRole: sql`excluded.schedule_role`,
            priority: sql`excluded.priority`,
            status: sql`excluded.status`,
            manifestRevision: sql`excluded.manifest_revision`,
            updatedAt: dbNow,
          },
        });

      if (changedScheduleIds.size > 0) {
        const staleRuns = await tx
          .update(contentAcquisitionRuns)
          .set({
            status: 'FAILED',
            failureClass: 'MANIFEST_CONTRACT_CHANGED',
            failureDetailsHash: sha256CanonicalJson({
              failureClass: 'MANIFEST_CONTRACT_CHANGED',
              manifestHash: state.manifestHash,
            }),
            errorSummary: 'Acquisition contract changed during manifest reconciliation',
            completedAt: dbNow,
            leaseExpiresAt: null,
            checkpointAdvanced: false,
          })
          .where(
            and(
              inArray(contentAcquisitionRuns.scheduleId, [...changedScheduleIds]),
              inArray(contentAcquisitionRuns.status, ['PENDING', 'RUNNING']),
            ),
          )
          .returning({ runId: contentAcquisitionRuns.runId });
        for (const run of staleRuns) {
          await releaseXRunBudgets({ tx, runId: run.runId, dbNow });
        }
        for (const existing of existingSchedules) {
          if (!changedScheduleIds.has(existing.scheduleId)) continue;
          const desired = scheduleRows.find(
            (schedule) => schedule.scheduleId === existing.scheduleId,
          );
          await tx
            .update(contentSourceSchedules)
            .set({
              nextDueAt: desired?.nextDueAt ?? dbNow,
              leaseOwner: null,
              leaseExpiresAt: null,
              failureStreak: 0,
              circuitState: 'CLOSED',
              probeAfter: null,
              cacheNotBefore: null,
              validator: {},
              checkpoint: {},
              bootstrapCompletedAt: null,
              bootstrapCutoffAt: dbNow,
              underLimitStreak: 0,
              updatedAt: dbNow,
            })
            .where(eq(contentSourceSchedules.scheduleId, existing.scheduleId));
        }
      }
      await tx
        .update(contentSourceSchedules)
        .set({ status: 'paused', updatedAt: dbNow })
        .where(
          notInArray(
            contentSourceSchedules.scheduleKey,
            state.schedules.map((schedule) => schedule.scheduleKey),
          ),
        );

      await tx
        .update(contentSourceRegistryReconciliations)
        .set({
          status: 'APPLIED',
          details: {
            fullRolloutEligible: input.bundle.coverage.fullRolloutEligible,
            includeXBackstop,
            resetScheduleCount: changedScheduleIds.size,
            primaryReportingMissing: input.bundle.coverage.clubs.reduce(
              (total, club) => total + club.primaryReportingMissing,
              0,
            ),
          },
          completedAt: dbNow,
        })
        .where(eq(contentSourceRegistryReconciliations.reconciliationId, reconciliationId));

      return {
        reconciliationId,
        status: 'APPLIED',
        manifestHash: state.manifestHash,
        ...counts,
        fullRolloutEligible: input.bundle.coverage.fullRolloutEligible,
      };
    });
  } catch (error) {
    await db
      .insert(contentSourceRegistryReconciliations)
      .values({
        reconciliationId: randomUUID(),
        manifestHash: state.manifestHash,
        gitRevision: input.gitRevision ?? null,
        status: 'REJECTED',
        ...counts,
        details: { failedReconciliationId: reconciliationId },
        errorSummary: errorSummary(error),
        completedAt: sql`now()`,
      })
      .catch(() => undefined);
    throw error;
  }
}
