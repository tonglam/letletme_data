import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';

import { getDb } from '../../db/singleton';
import {
  contentSourceGroupMembers,
  contentSourceGroups,
  contentSources,
} from '../../db/schemas/content.schema';

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

export async function upsertContentSource(input: ContentSourceInput): Promise<string> {
  const db = await getDb();
  const sourceId = randomUUID();
  const rows = await db
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
}

export async function upsertContentSourceGroup(input: ContentSourceGroupInput): Promise<string> {
  const db = await getDb();
  const groupId = randomUUID();
  const rows = await db
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
}

export async function addSourceToGroup(
  groupKey: string,
  sourceId: string,
  priority = 100,
): Promise<void> {
  const db = await getDb();
  const groups = await db
    .select({ groupId: contentSourceGroups.groupId })
    .from(contentSourceGroups)
    .where(eq(contentSourceGroups.groupKey, groupKey))
    .limit(1);
  const groupId = groups[0]?.groupId;
  if (!groupId) throw new Error(`Content source group not found: ${groupKey}`);
  await db
    .insert(contentSourceGroupMembers)
    .values({ groupId, sourceId, priority })
    .onConflictDoUpdate({
      target: [contentSourceGroupMembers.groupId, contentSourceGroupMembers.sourceId],
      set: { priority },
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
      groupId: contentSourceGroups.groupId,
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
  const items = rows.map((row) => ({
    ...row,
    rightsPolicy: (row.rightsPolicy ?? {}) as Record<string, unknown>,
  }));
  return { groupId, revision: sourceSnapshotRevision(items), items };
}
