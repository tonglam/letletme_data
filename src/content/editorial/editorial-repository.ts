import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { getDb, type DbOrTransaction } from '../../db/singleton';
import {
  contentCandidateClusters,
  contentEditorialActions,
  contentSourceReceipts,
  contentSources,
  contentStories,
  contentStoryEvidence,
  contentStoryLocalizations,
  contentWeekEditionItems,
  contentWeekEditions,
} from '../../db/schemas/content.schema';
import {
  assertWeekPublication,
  validateWeekLocalePair,
  type WeekLocale,
  type WeekPublicationEnvelope,
} from '../contracts/week-publication';

export type EditorialRole = 'content_editor' | 'content_publisher';

export type EditorialActor = Readonly<{
  actorId: string;
  role: EditorialRole;
  idempotencyKey: string;
}>;

export type StoryLocalizationInput = Readonly<{
  locale: WeekLocale;
  title: string;
  summary: string;
  body: string;
  sourceAttribution?: string | null;
  claims?: readonly string[];
}>;

const jsonObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const assertActor = (actor: EditorialActor): void => {
  if (!actor.actorId.trim()) throw new Error('Editorial actor is required');
  if (!actor.idempotencyKey.trim()) throw new Error('Editorial idempotency key is required');
};

const requireRole = (actor: EditorialActor, role: EditorialRole): void => {
  assertActor(actor);
  if (actor.role !== role) throw new Error(`${role} role required`);
};

async function audit(
  tx: DbOrTransaction,
  actor: EditorialActor,
  actionType: string,
  entityType: string,
  entityId: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx
    .insert(contentEditorialActions)
    .values({
      actionId: randomUUID(),
      idempotencyKey: actor.idempotencyKey,
      actorId: actor.actorId,
      role: actor.role,
      actionType,
      entityType,
      entityId,
      payload,
    })
    .onConflictDoNothing({ target: contentEditorialActions.idempotencyKey });
}

const requireUuid = (value: string, field: string): void => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new Error(`${field} must be a UUID`);
};

const requireText = (value: string, field: string): string => {
  const text = value.trim();
  if (!text) throw new Error(`${field} is required`);
  return text;
};

export async function createCandidateFromReceipts(input: {
  runId: string;
  canonicalHash: string;
  materiality?: string;
  receiptIds: readonly string[];
  actor: EditorialActor;
}): Promise<string> {
  requireRole(input.actor, 'content_editor');
  requireUuid(input.runId, 'runId');
  if (!input.receiptIds.length) throw new Error('At least one receipt is required');
  input.receiptIds.forEach((receiptId) => requireUuid(receiptId, 'receiptId'));
  const candidateId = randomUUID();
  const db = await getDb();
  await db.transaction(async (tx) => {
    const receipts = await tx
      .select({ receiptId: contentSourceReceipts.receiptId })
      .from(contentSourceReceipts)
      .where(
        and(
          eq(contentSourceReceipts.runId, input.runId),
          inArray(contentSourceReceipts.receiptId, [...input.receiptIds]),
        ),
      );
    if (receipts.length !== input.receiptIds.length) throw new Error('Receipt is not in the run');
    await tx.insert(contentCandidateClusters).values({
      candidateId,
      runId: input.runId,
      canonicalHash: requireText(input.canonicalHash, 'canonicalHash'),
      materiality: input.materiality?.trim() || 'unknown',
      receiptIds: [...new Set(input.receiptIds)],
    });
    await audit(tx, input.actor, 'candidate.create', 'candidate', candidateId, {
      receiptCount: input.receiptIds.length,
    });
  });
  return candidateId;
}

export async function acceptCandidate(candidateId: string, actor: EditorialActor): Promise<void> {
  requireRole(actor, 'content_editor');
  requireUuid(candidateId, 'candidateId');
  const db = await getDb();
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ status: contentCandidateClusters.status })
      .from(contentCandidateClusters)
      .where(eq(contentCandidateClusters.candidateId, candidateId))
      .limit(1);
    if (!rows[0]) throw new Error('Candidate not found');
    if (rows[0].status === 'merged' || rows[0].status === 'rejected')
      throw new Error('Candidate cannot be accepted from its current state');
    await tx
      .update(contentCandidateClusters)
      .set({ status: 'accepted', updatedAt: new Date() })
      .where(eq(contentCandidateClusters.candidateId, candidateId));
    await audit(tx, actor, 'candidate.accept', 'candidate', candidateId, {});
  });
}

export async function mergeCandidates(
  targetCandidateId: string,
  sourceCandidateIds: readonly string[],
  actor: EditorialActor,
): Promise<void> {
  requireRole(actor, 'content_editor');
  requireUuid(targetCandidateId, 'targetCandidateId');
  const sourceIds = [...new Set(sourceCandidateIds)].filter((id) => id !== targetCandidateId);
  sourceIds.forEach((id) => requireUuid(id, 'sourceCandidateId'));
  if (!sourceIds.length) throw new Error('At least one source candidate is required');
  const db = await getDb();
  await db.transaction(async (tx) => {
    const ids = [targetCandidateId, ...sourceIds];
    const rows = await tx
      .select({
        candidateId: contentCandidateClusters.candidateId,
        status: contentCandidateClusters.status,
        receiptIds: contentCandidateClusters.receiptIds,
      })
      .from(contentCandidateClusters)
      .where(inArray(contentCandidateClusters.candidateId, ids));
    if (rows.length !== ids.length) throw new Error('Candidate not found');
    if (rows.some((row) => row.status === 'rejected' || row.status === 'merged'))
      throw new Error('Rejected or already merged candidate cannot be merged');
    const receiptIds = [
      ...new Set(rows.flatMap((row) => (Array.isArray(row.receiptIds) ? row.receiptIds : []))),
    ];
    await tx
      .update(contentCandidateClusters)
      .set({ receiptIds, status: 'accepted', updatedAt: new Date() })
      .where(eq(contentCandidateClusters.candidateId, targetCandidateId));
    await tx
      .update(contentCandidateClusters)
      .set({ status: 'merged', updatedAt: new Date() })
      .where(inArray(contentCandidateClusters.candidateId, sourceIds));
    await audit(tx, actor, 'candidate.merge', 'candidate', targetCandidateId, {
      sourceCandidateIds: sourceIds,
    });
  });
}

export async function createDraftStory(input: {
  candidateId: string;
  slug: string;
  expiresAt?: string | null;
  localizations: readonly StoryLocalizationInput[];
  actor: EditorialActor;
}): Promise<string> {
  requireRole(input.actor, 'content_editor');
  requireUuid(input.candidateId, 'candidateId');
  const slug = requireText(input.slug, 'slug');
  const locales = new Set(input.localizations.map((localization) => localization.locale));
  if (locales.size !== 2 || !locales.has('en') || !locales.has('zh-CN'))
    throw new Error('A draft Story requires en and zh-CN localizations');
  const storyId = randomUUID();
  const versionGroupId = randomUUID();
  const db = await getDb();
  await db.transaction(async (tx) => {
    const candidate = await tx
      .select({ status: contentCandidateClusters.status })
      .from(contentCandidateClusters)
      .where(eq(contentCandidateClusters.candidateId, input.candidateId))
      .limit(1);
    if (!candidate[0] || candidate[0].status !== 'accepted')
      throw new Error('Candidate must be accepted before creating a Story');
    await tx.insert(contentStories).values({
      storyId,
      versionGroupId,
      canonicalSlug: slug,
      storyRevision: 1,
      status: 'draft',
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    });
    await tx.insert(contentStoryLocalizations).values(
      input.localizations.map((localization) => ({
        localizationId: randomUUID(),
        versionGroupId,
        locale: localization.locale,
        title: requireText(localization.title, `${localization.locale}.title`),
        summary: requireText(localization.summary, `${localization.locale}.summary`),
        body: requireText(localization.body, `${localization.locale}.body`),
        sourceAttribution: localization.sourceAttribution?.trim() || null,
        claims: localization.claims ? [...localization.claims] : [],
      })),
    );
    await audit(tx, input.actor, 'story.create', 'story', storyId, {
      candidateId: input.candidateId,
    });
  });
  return storyId;
}

export async function attachStoryEvidence(
  storyId: string,
  receiptIds: readonly string[],
  actor: EditorialActor,
): Promise<number> {
  requireRole(actor, 'content_editor');
  requireUuid(storyId, 'storyId');
  if (!receiptIds.length) throw new Error('At least one receipt is required');
  receiptIds.forEach((receiptId) => requireUuid(receiptId, 'receiptId'));
  const db = await getDb();
  let inserted = 0;
  await db.transaction(async (tx) => {
    const story = await tx
      .select({ storyId: contentStories.storyId })
      .from(contentStories)
      .where(eq(contentStories.storyId, storyId))
      .limit(1);
    if (!story[0]) throw new Error('Story not found');
    const receipts = await tx
      .select({ receiptId: contentSourceReceipts.receiptId })
      .from(contentSourceReceipts)
      .where(inArray(contentSourceReceipts.receiptId, [...new Set(receiptIds)]));
    if (receipts.length !== new Set(receiptIds).size) throw new Error('Receipt not found');
    const rows = await tx
      .insert(contentStoryEvidence)
      .values(
        [...new Set(receiptIds)].map((receiptId) => ({
          storyId,
          receiptId,
          evidenceRole: 'source',
        })),
      )
      .onConflictDoNothing()
      .returning({ storyId: contentStoryEvidence.storyId });
    inserted = rows.length;
    await audit(tx, actor, 'story.evidence.attach', 'story', storyId, { receiptCount: inserted });
  });
  return inserted;
}

function rightsAllowPublic(value: unknown): boolean {
  const rights = jsonObject(value);
  return (
    rights.allowPublic === true || rights.publishable === true || rights.visibility === 'public'
  );
}

export async function markStoryReady(storyId: string, actor: EditorialActor): Promise<void> {
  requireRole(actor, 'content_editor');
  requireUuid(storyId, 'storyId');
  const db = await getDb();
  await db.transaction(async (tx) => {
    const story = await tx
      .select({ versionGroupId: contentStories.versionGroupId, status: contentStories.status })
      .from(contentStories)
      .where(eq(contentStories.storyId, storyId))
      .limit(1);
    if (!story[0]) throw new Error('Story not found');
    if (story[0].status === 'removed') throw new Error('Removed Story cannot be made ready');
    const localizations = await tx
      .select({ locale: contentStoryLocalizations.locale })
      .from(contentStoryLocalizations)
      .where(eq(contentStoryLocalizations.versionGroupId, story[0].versionGroupId));
    const locales = new Set(localizations.map((row) => row.locale));
    if (!locales.has('en') || !locales.has('zh-CN'))
      throw new Error('Story requires en and zh-CN localizations');
    const evidence = await tx
      .select({
        rightsPolicy: contentSourceReceipts.rightsPolicy,
        canonicalUrl: contentSourceReceipts.canonicalUrl,
      })
      .from(contentStoryEvidence)
      .innerJoin(
        contentSourceReceipts,
        eq(contentSourceReceipts.receiptId, contentStoryEvidence.receiptId),
      )
      .where(eq(contentStoryEvidence.storyId, storyId));
    if (!evidence.length) throw new Error('Story requires evidence');
    if (evidence.some((row) => !rightsAllowPublic(row.rightsPolicy)))
      throw new Error('Every Story evidence receipt needs explicit public rights');
    if (evidence.some((row) => !/^https?:\/\//i.test(row.canonicalUrl)))
      throw new Error('Story evidence URL must be http(s)');
    await tx
      .update(contentStories)
      .set({ status: 'ready', updatedAt: new Date() })
      .where(eq(contentStories.storyId, storyId));
    await audit(tx, actor, 'story.ready', 'story', storyId, { evidenceCount: evidence.length });
  });
}

export async function createWeekEdition(input: {
  seasonCode: string;
  eventId: number;
  eventName: string;
  deadlineTime: string;
  sourceSnapshotRevision: string;
  actor: EditorialActor;
}): Promise<string> {
  requireRole(input.actor, 'content_editor');
  if (!/^\d{4}$/.test(input.seasonCode)) throw new Error('seasonCode is invalid');
  if (!Number.isSafeInteger(input.eventId) || input.eventId <= 0)
    throw new Error('eventId is invalid');
  const editionId = randomUUID();
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.insert(contentWeekEditions).values({
      editionId,
      seasonCode: input.seasonCode,
      eventId: input.eventId,
      eventName: requireText(input.eventName, 'eventName'),
      deadlineTime: new Date(input.deadlineTime),
      sourceSnapshotRevision: requireText(input.sourceSnapshotRevision, 'sourceSnapshotRevision'),
      status: 'draft',
    });
    await audit(tx, input.actor, 'week-edition.create', 'week_edition', editionId, {
      eventId: input.eventId,
    });
  });
  return editionId;
}

export async function addWeekEditionItem(input: {
  editionId: string;
  storyId: string;
  sectionKey: string;
  placement?: 'featured' | 'standard';
  position: number;
  actor: EditorialActor;
}): Promise<void> {
  requireRole(input.actor, 'content_editor');
  requireUuid(input.editionId, 'editionId');
  requireUuid(input.storyId, 'storyId');
  if (!Number.isSafeInteger(input.position) || input.position < 0)
    throw new Error('position is invalid');
  const db = await getDb();
  await db.transaction(async (tx) => {
    const [edition, story] = await Promise.all([
      tx
        .select({ editionId: contentWeekEditions.editionId })
        .from(contentWeekEditions)
        .where(eq(contentWeekEditions.editionId, input.editionId))
        .limit(1),
      tx
        .select({ status: contentStories.status })
        .from(contentStories)
        .where(eq(contentStories.storyId, input.storyId))
        .limit(1),
    ]);
    if (!edition[0]) throw new Error('Week edition not found');
    if (!story[0] || story[0].status !== 'ready')
      throw new Error('Only ready Stories can enter a Week edition');
    await tx
      .insert(contentWeekEditionItems)
      .values({
        editionId: input.editionId,
        storyId: input.storyId,
        sectionKey: requireText(input.sectionKey, 'sectionKey'),
        placement: input.placement ?? 'standard',
        position: input.position,
      })
      .onConflictDoUpdate({
        target: [contentWeekEditionItems.editionId, contentWeekEditionItems.storyId],
        set: {
          sectionKey: input.sectionKey,
          placement: input.placement ?? 'standard',
          position: input.position,
        },
      });
    await audit(tx, input.actor, 'week-edition.item.upsert', 'week_edition', input.editionId, {
      storyId: input.storyId,
    });
  });
}

export async function markWeekEditionReady(
  editionId: string,
  actor: EditorialActor,
): Promise<void> {
  requireRole(actor, 'content_editor');
  requireUuid(editionId, 'editionId');
  const db = await getDb();
  await db.transaction(async (tx) => {
    const edition = await tx
      .select({ editionId: contentWeekEditions.editionId })
      .from(contentWeekEditions)
      .where(eq(contentWeekEditions.editionId, editionId))
      .limit(1);
    if (!edition[0]) throw new Error('Week edition not found');
    const items = await tx
      .select({
        storyId: contentWeekEditionItems.storyId,
        sectionKey: contentWeekEditionItems.sectionKey,
        position: contentWeekEditionItems.position,
        status: contentStories.status,
      })
      .from(contentWeekEditionItems)
      .innerJoin(contentStories, eq(contentStories.storyId, contentWeekEditionItems.storyId))
      .where(eq(contentWeekEditionItems.editionId, editionId));
    if (items.some((item) => item.status !== 'ready' && item.status !== 'published'))
      throw new Error('Week edition contains a Story that is not ready');
    const positions = new Set<string>();
    for (const item of items) {
      const key = `${item.sectionKey}:${item.position}`;
      if (positions.has(key)) throw new Error(`Duplicate Week position ${key}`);
      positions.add(key);
    }
    await tx
      .update(contentWeekEditions)
      .set({ status: 'ready', updatedAt: new Date() })
      .where(eq(contentWeekEditions.editionId, editionId));
    await audit(tx, actor, 'week-edition.ready', 'week_edition', editionId, {
      itemCount: items.length,
    });
  });
}

type CompiledStory = {
  storyId: string;
  storyRevision: number;
  slug: string;
  expiresAt: Date | null;
  sectionKey: string;
  placement: string;
  position: number;
  sourceName: string | null;
  sourceUrl: string | null;
  sourceCheckedAt: Date | null;
  localizations: Map<WeekLocale, { title: string; summary: string }>;
};

export async function compileWeekEdition(input: {
  editionId: string;
  revision: number;
  publicationId: string;
  sourceCheckedAt: string;
  publishedAt: string;
  validUntil?: string | null;
  actor: EditorialActor;
}): Promise<{ en: WeekPublicationEnvelope; 'zh-CN': WeekPublicationEnvelope }> {
  requireRole(input.actor, 'content_publisher');
  requireUuid(input.editionId, 'editionId');
  requireUuid(input.publicationId, 'publicationId');
  if (!Number.isSafeInteger(input.revision) || input.revision <= 0)
    throw new Error('revision is invalid');
  const db = await getDb();
  const edition = await db
    .select({
      seasonCode: contentWeekEditions.seasonCode,
      eventId: contentWeekEditions.eventId,
      eventName: contentWeekEditions.eventName,
      deadlineTime: contentWeekEditions.deadlineTime,
      status: contentWeekEditions.status,
    })
    .from(contentWeekEditions)
    .where(eq(contentWeekEditions.editionId, input.editionId))
    .limit(1);
  const editionRow = edition[0];
  if (!editionRow || editionRow.status !== 'ready')
    throw new Error('Week edition must be ready before compile');
  const itemRows = await db
    .select({
      storyId: contentWeekEditionItems.storyId,
      sectionKey: contentWeekEditionItems.sectionKey,
      placement: contentWeekEditionItems.placement,
      position: contentWeekEditionItems.position,
      storyRevision: contentStories.storyRevision,
      storyStatus: contentStories.status,
      slug: contentStories.canonicalSlug,
      expiresAt: contentStories.expiresAt,
      versionGroupId: contentStories.versionGroupId,
    })
    .from(contentWeekEditionItems)
    .innerJoin(contentStories, eq(contentStories.storyId, contentWeekEditionItems.storyId))
    .where(eq(contentWeekEditionItems.editionId, input.editionId))
    .orderBy(asc(contentWeekEditionItems.position), asc(contentWeekEditionItems.sectionKey));
  const storyIds = itemRows.map((row) => row.storyId);
  if (itemRows.some((row) => row.storyStatus !== 'ready' && row.storyStatus !== 'published'))
    throw new Error('Week edition contains invalid Story revision');
  const localizations = storyIds.length
    ? await db
        .select({
          versionGroupId: contentStoryLocalizations.versionGroupId,
          locale: contentStoryLocalizations.locale,
          title: contentStoryLocalizations.title,
          summary: contentStoryLocalizations.summary,
        })
        .from(contentStoryLocalizations)
        .where(
          inArray(
            contentStoryLocalizations.versionGroupId,
            itemRows.map((row) => row.versionGroupId),
          ),
        )
    : [];
  const evidence = storyIds.length
    ? await db
        .select({
          storyId: contentStoryEvidence.storyId,
          sourceName: contentSources.displayName,
          sourceUrl: contentSourceReceipts.canonicalUrl,
          sourceCheckedAt: contentSourceReceipts.capturedAt,
        })
        .from(contentStoryEvidence)
        .innerJoin(
          contentSourceReceipts,
          eq(contentSourceReceipts.receiptId, contentStoryEvidence.receiptId),
        )
        .innerJoin(contentSources, eq(contentSources.sourceId, contentSourceReceipts.sourceId))
        .where(inArray(contentStoryEvidence.storyId, storyIds))
        .orderBy(asc(contentSourceReceipts.capturedAt))
    : [];
  const localizationMap = new Map<string, Map<WeekLocale, { title: string; summary: string }>>();
  for (const localization of localizations) {
    const locale = localization.locale as WeekLocale;
    const map = localizationMap.get(localization.versionGroupId) ?? new Map();
    map.set(locale, { title: localization.title, summary: localization.summary });
    localizationMap.set(localization.versionGroupId, map);
  }
  const evidenceMap = new Map<string, (typeof evidence)[number]>();
  for (const row of evidence) if (!evidenceMap.has(row.storyId)) evidenceMap.set(row.storyId, row);
  const stories: CompiledStory[] = itemRows.map((row) => {
    const translations = localizationMap.get(row.versionGroupId);
    if (!translations?.has('en') || !translations.has('zh-CN'))
      throw new Error(`Story ${row.storyId} is missing a locale`);
    const source = evidenceMap.get(row.storyId);
    return {
      storyId: row.storyId,
      storyRevision: row.storyRevision,
      slug: row.slug,
      expiresAt: row.expiresAt,
      sectionKey: row.sectionKey,
      placement: row.placement,
      position: row.position,
      sourceName: source?.sourceName ?? null,
      sourceUrl: source?.sourceUrl ?? null,
      sourceCheckedAt: source?.sourceCheckedAt ?? null,
      localizations: translations,
    };
  });
  const sourceCheckedAt = new Date(input.sourceCheckedAt);
  const publishedAt = new Date(input.publishedAt);
  const validUntil = input.validUntil ? new Date(input.validUntil) : null;
  if (!Number.isFinite(sourceCheckedAt.getTime()) || !Number.isFinite(publishedAt.getTime()))
    throw new Error('Publication timestamps are invalid');
  if (
    validUntil &&
    (!Number.isFinite(validUntil.getTime()) || validUntil > editionRow.deadlineTime)
  )
    throw new Error('validUntil exceeds deadline');
  const event = {
    seasonCode: editionRow.seasonCode,
    eventId: editionRow.eventId,
    name: editionRow.eventName,
    deadlineTime: editionRow.deadlineTime.toISOString(),
  };
  const build = (locale: WeekLocale): WeekPublicationEnvelope => {
    const featured = stories
      .filter((story) => story.placement === 'featured')
      .sort((a, b) => a.position - b.position)
      .map((story) => ({
        id: story.storyId,
        slug: story.slug,
        storyRevision: story.storyRevision,
        title: story.localizations.get(locale)?.title ?? '',
        summary: story.localizations.get(locale)?.summary ?? '',
        sourceName: story.sourceName,
        sourceUrl: story.sourceUrl,
        sourceCheckedAt: story.sourceCheckedAt?.toISOString() ?? null,
        expiresAt: story.expiresAt?.toISOString() ?? null,
      }));
    const sectionKeys = [...new Set(stories.map((story) => story.sectionKey))];
    const sections = sectionKeys
      .map((sectionKey) => ({
        key: sectionKey,
        title: sectionKey,
        items: stories
          .filter((story) => story.sectionKey === sectionKey && story.placement !== 'featured')
          .sort((a, b) => a.position - b.position)
          .map((story) => ({
            id: story.storyId,
            slug: story.slug,
            storyRevision: story.storyRevision,
            title: story.localizations.get(locale)?.title ?? '',
            summary: story.localizations.get(locale)?.summary ?? '',
            sourceName: story.sourceName,
            sourceUrl: story.sourceUrl,
            sourceCheckedAt: story.sourceCheckedAt?.toISOString() ?? null,
            expiresAt: story.expiresAt?.toISOString() ?? null,
          })),
      }))
      .filter((section) => section.items.length > 0);
    const envelope: WeekPublicationEnvelope = {
      schemaVersion: 1,
      scopeKind: 'SURFACE',
      scopeKey: 'week',
      revision: input.revision,
      publicationId: input.publicationId,
      state: stories.length ? 'READY' : 'EMPTY',
      locale,
      publishedAt: publishedAt.toISOString(),
      sourceCheckedAt: sourceCheckedAt.toISOString(),
      validUntil: validUntil?.toISOString() ?? null,
      event,
      featured,
      sections,
    };
    assertWeekPublication(envelope);
    return envelope;
  };
  const pair = { en: build('en'), 'zh-CN': build('zh-CN') };
  validateWeekLocalePair(pair.en, pair['zh-CN']);
  await db.transaction(async (tx) => {
    await audit(tx, input.actor, 'week-edition.compile', 'week_edition', input.editionId, {
      revision: input.revision,
      storyCount: stories.length,
    });
  });
  return pair;
}
