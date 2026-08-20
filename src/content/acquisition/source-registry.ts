import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';

import { getDb, type DbOrTransaction } from '../../db/singleton';
import {
  contentEditorialActions,
  contentSourceGroupMembers,
  contentSourceGroups,
  contentSources,
} from '../../db/schemas/content.schema';
import { ConflictError } from '../../utils/errors';

export type ContentSourceCommandActor = Readonly<{
  actorId: string;
  role: string;
  idempotencyKey: string;
}>;

export type ContentSourceInput = Readonly<{
  platform: string;
  externalId: string;
  handle?: string | null;
  displayName: string;
  sourceType: string;
  reportingFamily: string;
  rightsPolicy?: Record<string, unknown>;
}>;

export type ContentSourceGroupInput = Readonly<{
  groupKey: string;
  displayName: string;
  pollPolicy?: Record<string, unknown>;
}>;

export type SourceSnapshotItem = Readonly<{
  sourceId: string;
  platform: string;
  externalId: string;
  handle: string | null;
  displayName: string;
  sourceType: string;
  reportingFamily: string;
  rightsPolicy: Record<string, unknown>;
}>;

export function sourceSnapshotRevision(snapshot: readonly SourceSnapshotItem[]): string {
  const canonical = JSON.stringify(
    snapshot.map((item) => ({ ...item, rightsPolicy: item.rightsPolicy })),
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
  );
};

const requestHash = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalize(value)), 'utf8')
    .digest('hex');

const jsonObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

async function sourceCommand<T>(input: {
  actor: ContentSourceCommandActor;
  actionType: string;
  payload: Record<string, unknown>;
  operation: (tx: DbOrTransaction) => Promise<T>;
}): Promise<T> {
  if (!input.actor.actorId.trim() || !input.actor.idempotencyKey.trim())
    throw new Error('Content editor actor and Idempotency-Key are required');
  if (input.actor.role !== 'content_editor') throw new Error('content_editor role required');
  const hash = requestHash({
    actorId: input.actor.actorId,
    role: input.actor.role,
    actionType: input.actionType,
    payload: input.payload,
  });
  const db = await getDb();
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(contentEditorialActions)
      .values({
        actionId: randomUUID(),
        idempotencyKey: input.actor.idempotencyKey,
        actorId: input.actor.actorId,
        role: input.actor.role,
        actionType: input.actionType,
        entityType: 'content_source',
        entityId: null,
        payload: input.payload,
        requestHash: hash,
      })
      .onConflictDoNothing({ target: contentEditorialActions.idempotencyKey })
      .returning({ actionId: contentEditorialActions.actionId });
    if (inserted[0]) {
      const value = await input.operation(tx);
      await tx
        .update(contentEditorialActions)
        .set({ resultPayload: { value: value ?? null }, completedAt: new Date() })
        .where(eq(contentEditorialActions.idempotencyKey, input.actor.idempotencyKey));
      return value;
    }
    const existing = await tx
      .select({
        actorId: contentEditorialActions.actorId,
        role: contentEditorialActions.role,
        actionType: contentEditorialActions.actionType,
        requestHash: contentEditorialActions.requestHash,
        resultPayload: contentEditorialActions.resultPayload,
        completedAt: contentEditorialActions.completedAt,
      })
      .from(contentEditorialActions)
      .where(eq(contentEditorialActions.idempotencyKey, input.actor.idempotencyKey))
      .for('update')
      .limit(1);
    if (existing[0]) {
      const row = existing[0];
      if (
        row.actorId !== input.actor.actorId ||
        row.role !== input.actor.role ||
        row.actionType !== input.actionType ||
        row.requestHash !== hash
      )
        throw new ConflictError(
          'Idempotency-Key was already used for a different command',
          'IDEMPOTENCY_KEY_REUSED',
        );
      if (row.completedAt) return jsonObject(row.resultPayload).value as T;
      throw new ConflictError(
        'The same content source command is already in progress',
        'EDITORIAL_COMMAND_IN_PROGRESS',
      );
    }
    throw new ConflictError(
      'Content source command reservation disappeared',
      'EDITORIAL_COMMAND_RACE',
    );
  });
}

export async function upsertContentSource(
  input: ContentSourceInput,
  actor: ContentSourceCommandActor,
): Promise<string> {
  const sourceId = randomUUID();
  return sourceCommand({
    actor,
    actionType: 'source.upsert',
    payload: input as Record<string, unknown>,
    operation: async (tx) => {
      const rows = await tx
        .insert(contentSources)
        .values({
          sourceId,
          platform: input.platform,
          externalId: input.externalId,
          handle: input.handle ?? null,
          displayName: input.displayName,
          sourceType: input.sourceType,
          reportingFamily: input.reportingFamily,
          rightsPolicy: input.rightsPolicy ?? {},
        })
        .onConflictDoUpdate({
          target: [contentSources.platform, contentSources.externalId],
          set: {
            handle: input.handle ?? null,
            displayName: input.displayName,
            sourceType: input.sourceType,
            reportingFamily: input.reportingFamily,
            rightsPolicy: input.rightsPolicy ?? {},
            updatedAt: new Date(),
          },
        })
        .returning({ sourceId: contentSources.sourceId });
      return rows[0]?.sourceId ?? sourceId;
    },
  });
}

export async function upsertContentSourceGroup(
  input: ContentSourceGroupInput,
  actor: ContentSourceCommandActor,
): Promise<string> {
  const groupId = randomUUID();
  return sourceCommand({
    actor,
    actionType: 'source-group.upsert',
    payload: input as Record<string, unknown>,
    operation: async (tx) => {
      const rows = await tx
        .insert(contentSourceGroups)
        .values({
          groupId,
          groupKey: input.groupKey,
          displayName: input.displayName,
          pollPolicy: input.pollPolicy ?? {},
        })
        .onConflictDoUpdate({
          target: contentSourceGroups.groupKey,
          set: {
            displayName: input.displayName,
            pollPolicy: input.pollPolicy ?? {},
            updatedAt: new Date(),
          },
        })
        .returning({ groupId: contentSourceGroups.groupId });
      return rows[0]?.groupId ?? groupId;
    },
  });
}

export async function addSourceToGroup(
  groupKey: string,
  sourceId: string,
  priority = 100,
  actor: ContentSourceCommandActor,
): Promise<void> {
  await sourceCommand({
    actor,
    actionType: 'source-group.member.upsert',
    payload: { groupKey, sourceId, priority },
    operation: async (tx) => {
      const groups = await tx
        .select({ groupId: contentSourceGroups.groupId })
        .from(contentSourceGroups)
        .where(eq(contentSourceGroups.groupKey, groupKey))
        .limit(1);
      const groupId = groups[0]?.groupId;
      if (!groupId) throw new Error(`Content source group not found: ${groupKey}`);
      await tx
        .insert(contentSourceGroupMembers)
        .values({ groupId, sourceId, priority })
        .onConflictDoUpdate({
          target: [contentSourceGroupMembers.groupId, contentSourceGroupMembers.sourceId],
          set: { priority },
        });
    },
  });
}

export async function buildSourceSnapshot(
  groupKey: string,
): Promise<{ groupId: string; revision: string; items: SourceSnapshotItem[] }> {
  const db = await getDb();
  const groupRows = await db
    .select({ groupId: contentSourceGroups.groupId })
    .from(contentSourceGroups)
    .where(
      and(eq(contentSourceGroups.groupKey, groupKey), eq(contentSourceGroups.status, 'active')),
    )
    .limit(1);
  const groupId = groupRows[0]?.groupId;
  if (!groupId) throw new Error(`No active content source group: ${groupKey}`);
  const rows = await db
    .select({
      sourceId: contentSources.sourceId,
      platform: contentSources.platform,
      externalId: contentSources.externalId,
      handle: contentSources.handle,
      displayName: contentSources.displayName,
      sourceType: contentSources.sourceType,
      reportingFamily: contentSources.reportingFamily,
      rightsPolicy: contentSources.rightsPolicy,
    })
    .from(contentSourceGroups)
    .innerJoin(
      contentSourceGroupMembers,
      eq(contentSourceGroupMembers.groupId, contentSourceGroups.groupId),
    )
    .innerJoin(contentSources, eq(contentSources.sourceId, contentSourceGroupMembers.sourceId))
    .where(
      and(
        eq(contentSourceGroups.groupKey, groupKey),
        eq(contentSourceGroups.status, 'active'),
        eq(contentSources.status, 'active'),
      ),
    )
    .orderBy(asc(contentSourceGroupMembers.priority), asc(contentSources.displayName));
  // Keep the persisted group identifier out of each generated source object.
  // The Grok input schema intentionally accepts only the public source fields;
  // groupId belongs to the enclosing snapshot metadata, not an item.
  const items: SourceSnapshotItem[] = rows.map((row) => ({
    sourceId: row.sourceId,
    platform: row.platform,
    externalId: row.externalId,
    handle: row.handle,
    displayName: row.displayName,
    sourceType: row.sourceType,
    reportingFamily: row.reportingFamily,
    rightsPolicy: (row.rightsPolicy ?? {}) as Record<string, unknown>,
  }));
  return { groupId, revision: sourceSnapshotRevision(items), items };
}
