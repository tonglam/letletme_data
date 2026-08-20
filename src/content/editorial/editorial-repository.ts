import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { getDb, type DbOrTransaction } from '../../db/singleton';
import {
  contentCandidateClusters,
  contentAcquisitionRuns,
  contentEditorialActions,
  contentSourceReceipts,
  contentSources,
  contentStories,
  contentStoryEvidence,
  contentStoryLocalizations,
  contentPublications,
  contentPublicationPayloads,
  contentWeekEditionItems,
  contentWeekEditions,
  contentWeekEditionSnapshots,
  contentWeekEditionSourceRuns,
} from '../../db/schemas/content.schema';
import {
  assertWeekPublication,
  validateWeekLocalePair,
  type WeekLocale,
  type WeekPublicationEnvelope,
} from '../contracts/week-publication';
import { ConflictError } from '../../utils/errors';
import {
  persistWeekPublication,
  stageWeekPublication,
  type WeekPublicationResult,
} from '../publication/week-publication';

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
    .update(contentEditorialActions)
    .set({ payload, resultPayload: { success: true, ...payload }, completedAt: new Date() })
    .where(eq(contentEditorialActions.idempotencyKey, actor.idempotencyKey));
}

type CommandReservation = Readonly<{ replay: boolean; result: Record<string, unknown> | null }>;

/** Reserve the idempotency key before any mutation.  A key is a tuple of the
 * actor, role, command and canonical request body; reusing it for a different
 * command is a conflict rather than a silently ignored INSERT. */
async function reserveCommand(
  tx: DbOrTransaction,
  actor: EditorialActor,
  actionType: string,
  entityType: string,
  entityId: string | null,
  payload: Record<string, unknown>,
): Promise<CommandReservation> {
  const hash = requestHash({
    actorId: actor.actorId,
    role: actor.role,
    actionType,
    entityType,
    entityId,
    payload,
  });
  const inserted = await tx
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
      requestHash: hash,
    })
    .onConflictDoNothing({ target: contentEditorialActions.idempotencyKey })
    .returning({ actionId: contentEditorialActions.actionId });
  if (inserted[0]) return { replay: false, result: null };
  const existing = await tx
    .select({
      actorId: contentEditorialActions.actorId,
      role: contentEditorialActions.role,
      actionType: contentEditorialActions.actionType,
      entityType: contentEditorialActions.entityType,
      entityId: contentEditorialActions.entityId,
      requestHash: contentEditorialActions.requestHash,
      resultPayload: contentEditorialActions.resultPayload,
      completedAt: contentEditorialActions.completedAt,
    })
    .from(contentEditorialActions)
    .where(eq(contentEditorialActions.idempotencyKey, actor.idempotencyKey))
    .for('update')
    .limit(1);
  if (existing[0]) {
    const row = existing[0];
    if (
      row.actorId !== actor.actorId ||
      row.role !== actor.role ||
      row.actionType !== actionType ||
      row.entityType !== entityType ||
      row.entityId !== entityId ||
      row.requestHash !== hash
    ) {
      throw new ConflictError(
        'Idempotency-Key was already used for a different command',
        'IDEMPOTENCY_KEY_REUSED',
      );
    }
    if (row.completedAt) return { replay: true, result: jsonObject(row.resultPayload) };
    throw new ConflictError(
      'The same editorial command is already in progress',
      'EDITORIAL_COMMAND_IN_PROGRESS',
    );
  }
  throw new ConflictError('Editorial command reservation disappeared', 'EDITORIAL_COMMAND_RACE');
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
  let replayResult: Record<string, unknown> | null = null;
  await db.transaction(async (tx) => {
    const reservation = await reserveCommand(
      tx,
      input.actor,
      'candidate.create',
      'candidate',
      null,
      {
        runId: input.runId,
        canonicalHash: input.canonicalHash,
        materiality: input.materiality ?? 'unknown',
        receiptIds: [...input.receiptIds],
      },
    );
    if (reservation.replay) {
      replayResult = reservation.result;
      return;
    }
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
      candidateId,
      receiptCount: input.receiptIds.length,
    });
  });
  const replayCandidateId = replayResult ? replayResult['candidateId'] : undefined;
  return typeof replayCandidateId === 'string' ? replayCandidateId : candidateId;
}

export async function acceptCandidate(candidateId: string, actor: EditorialActor): Promise<void> {
  requireRole(actor, 'content_editor');
  requireUuid(candidateId, 'candidateId');
  const db = await getDb();
  await db.transaction(async (tx) => {
    const reservation = await reserveCommand(
      tx,
      actor,
      'candidate.accept',
      'candidate',
      candidateId,
      {},
    );
    if (reservation.replay) {
      return;
    }
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
    const reservation = await reserveCommand(
      tx,
      actor,
      'candidate.merge',
      'candidate',
      targetCandidateId,
      {
        sourceCandidateIds: sourceIds,
      },
    );
    if (reservation.replay) return;
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
  let replayResult: Record<string, unknown> | null = null;
  await db.transaction(async (tx) => {
    const reservation = await reserveCommand(tx, input.actor, 'story.create', 'story', null, {
      candidateId: input.candidateId,
      slug,
      expiresAt: input.expiresAt ?? null,
      localizations: input.localizations,
    });
    if (reservation.replay) {
      replayResult = reservation.result;
      return;
    }
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
      storyId,
      candidateId: input.candidateId,
    });
  });
  const replayStoryId = replayResult ? replayResult['storyId'] : undefined;
  return typeof replayStoryId === 'string' ? replayStoryId : storyId;
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
    const reservation = await reserveCommand(tx, actor, 'story.evidence.attach', 'story', storyId, {
      receiptIds: [...new Set(receiptIds)],
    });
    if (reservation.replay) {
      inserted = Number(reservation.result?.inserted ?? 0);
      return;
    }
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
    await tx
      .update(contentEditorialActions)
      .set({ resultPayload: { success: true, inserted } })
      .where(eq(contentEditorialActions.idempotencyKey, actor.idempotencyKey));
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
    const reservation = await reserveCommand(tx, actor, 'story.ready', 'story', storyId, {});
    if (reservation.replay) return;
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
  sourceRunIds: readonly string[];
  actor: EditorialActor;
}): Promise<string> {
  requireRole(input.actor, 'content_editor');
  if (!/^\d{4}$/.test(input.seasonCode)) throw new Error('seasonCode is invalid');
  if (!Number.isSafeInteger(input.eventId) || input.eventId <= 0)
    throw new Error('eventId is invalid');
  const sourceRunIds = [...new Set(input.sourceRunIds)];
  if (!sourceRunIds.length) throw new Error('At least one sourceRunId is required');
  sourceRunIds.forEach((runId) => requireUuid(runId, 'sourceRunId'));
  const editionId = randomUUID();
  const db = await getDb();
  let replayResult: Record<string, unknown> | null = null;
  await db.transaction(async (tx) => {
    const reservation = await reserveCommand(
      tx,
      input.actor,
      'week-edition.create',
      'week_edition',
      null,
      {
        seasonCode: input.seasonCode,
        eventId: input.eventId,
        eventName: input.eventName,
        deadlineTime: input.deadlineTime,
        sourceSnapshotRevision: input.sourceSnapshotRevision,
        sourceRunIds,
      },
    );
    if (reservation.replay) {
      replayResult = reservation.result;
      return;
    }
    const runs = await tx
      .select({ runId: contentAcquisitionRuns.runId })
      .from(contentAcquisitionRuns)
      .where(inArray(contentAcquisitionRuns.runId, sourceRunIds));
    if (runs.length !== sourceRunIds.length) throw new Error('Source run not found');
    await tx.insert(contentWeekEditions).values({
      editionId,
      seasonCode: input.seasonCode,
      eventId: input.eventId,
      eventName: requireText(input.eventName, 'eventName'),
      deadlineTime: new Date(input.deadlineTime),
      sourceSnapshotRevision: requireText(input.sourceSnapshotRevision, 'sourceSnapshotRevision'),
      status: 'draft',
    });
    await tx.insert(contentWeekEditionSourceRuns).values(
      sourceRunIds.map((runId) => ({
        editionId,
        runId,
        sourceSnapshotRevision: input.sourceSnapshotRevision,
      })),
    );
    await audit(tx, input.actor, 'week-edition.create', 'week_edition', editionId, {
      editionId,
      eventId: input.eventId,
      sourceRunIds,
    });
  });
  const replayEditionId = replayResult ? replayResult['editionId'] : undefined;
  return typeof replayEditionId === 'string' ? replayEditionId : editionId;
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
    const reservation = await reserveCommand(
      tx,
      input.actor,
      'week-edition.item.upsert',
      'week_edition',
      input.editionId,
      {
        storyId: input.storyId,
        sectionKey: input.sectionKey,
        placement: input.placement ?? 'standard',
        position: input.position,
      },
    );
    if (reservation.replay) return;
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
): Promise<{ frozenSha256: string; replayed: boolean }> {
  requireRole(actor, 'content_editor');
  requireUuid(editionId, 'editionId');
  const db = await getDb();
  let frozenSha256 = '';
  let replayed = false;
  await db.transaction(async (tx) => {
    const reservation = await reserveCommand(
      tx,
      actor,
      'week-edition.ready',
      'week_edition',
      editionId,
      {},
    );
    if (reservation.replay) {
      replayed = true;
      frozenSha256 =
        typeof reservation.result?.frozenSha256 === 'string' ? reservation.result.frozenSha256 : '';
      return;
    }
    const edition = await tx
      .select({
        editionId: contentWeekEditions.editionId,
        seasonCode: contentWeekEditions.seasonCode,
        eventId: contentWeekEditions.eventId,
        eventName: contentWeekEditions.eventName,
        deadlineTime: contentWeekEditions.deadlineTime,
        sourceSnapshotRevision: contentWeekEditions.sourceSnapshotRevision,
        status: contentWeekEditions.status,
      })
      .from(contentWeekEditions)
      .where(eq(contentWeekEditions.editionId, editionId))
      .for('update')
      .limit(1);
    if (!edition[0]) throw new Error('Week edition not found');
    if (edition[0].status !== 'draft') throw new Error('Only draft Week editions can become READY');
    const sourceRuns = await tx
      .select({
        runId: contentWeekEditionSourceRuns.runId,
        linkedRevision: contentWeekEditionSourceRuns.sourceSnapshotRevision,
        runRevision: contentAcquisitionRuns.sourceSnapshotRevision,
        status: contentAcquisitionRuns.status,
        traceVerified: contentAcquisitionRuns.traceVerified,
        checkpointAdvanced: contentAcquisitionRuns.checkpointAdvanced,
        completedAt: contentAcquisitionRuns.completedAt,
      })
      .from(contentWeekEditionSourceRuns)
      .innerJoin(
        contentAcquisitionRuns,
        eq(contentAcquisitionRuns.runId, contentWeekEditionSourceRuns.runId),
      )
      .where(eq(contentWeekEditionSourceRuns.editionId, editionId));
    if (!sourceRuns.length) throw new Error('Week edition requires source runs');
    if (
      sourceRuns.some(
        (run) =>
          run.status !== 'completed' ||
          run.traceVerified !== true ||
          run.checkpointAdvanced !== true ||
          !run.completedAt ||
          run.linkedRevision !== edition[0].sourceSnapshotRevision ||
          run.runRevision !== edition[0].sourceSnapshotRevision,
      )
    )
      throw new Error('Week edition source runs are incomplete or stale');
    const items = await tx
      .select({
        storyId: contentWeekEditionItems.storyId,
        sectionKey: contentWeekEditionItems.sectionKey,
        placement: contentWeekEditionItems.placement,
        position: contentWeekEditionItems.position,
        status: contentStories.status,
        storyRevision: contentStories.storyRevision,
        slug: contentStories.canonicalSlug,
        expiresAt: contentStories.expiresAt,
        versionGroupId: contentStories.versionGroupId,
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
    const storyIds = items.map((item) => item.storyId);
    const localizations = storyIds.length
      ? await tx
          .select({
            versionGroupId: contentStoryLocalizations.versionGroupId,
            locale: contentStoryLocalizations.locale,
            title: contentStoryLocalizations.title,
            summary: contentStoryLocalizations.summary,
            body: contentStoryLocalizations.body,
            sourceAttribution: contentStoryLocalizations.sourceAttribution,
          })
          .from(contentStoryLocalizations)
          .where(
            inArray(
              contentStoryLocalizations.versionGroupId,
              items.map((item) => item.versionGroupId),
            ),
          )
      : [];
    const evidence = storyIds.length
      ? await tx
          .select({
            storyId: contentStoryEvidence.storyId,
            receiptId: contentStoryEvidence.receiptId,
            evidenceRole: contentStoryEvidence.evidenceRole,
            canonicalUrl: contentSourceReceipts.canonicalUrl,
            capturedAt: contentSourceReceipts.capturedAt,
            rightsPolicy: contentSourceReceipts.rightsPolicy,
            sourceId: contentSourceReceipts.sourceId,
            sourceName: contentSources.displayName,
          })
          .from(contentStoryEvidence)
          .innerJoin(
            contentSourceReceipts,
            eq(contentSourceReceipts.receiptId, contentStoryEvidence.receiptId),
          )
          .innerJoin(contentSources, eq(contentSources.sourceId, contentSourceReceipts.sourceId))
          .where(inArray(contentStoryEvidence.storyId, storyIds))
      : [];
    const localizationsByVersion = new Map<string, Record<string, unknown>>();
    for (const localization of localizations) {
      const row = localizationsByVersion.get(localization.versionGroupId) ?? {};
      row[localization.locale] = {
        title: localization.title,
        summary: localization.summary,
        body: localization.body,
        sourceAttribution: localization.sourceAttribution,
      };
      localizationsByVersion.set(localization.versionGroupId, row);
    }
    const evidenceByStory = new Map<string, Record<string, unknown>[]>();
    for (const row of evidence) {
      if (!rightsAllowPublic(row.rightsPolicy))
        throw new Error('Every Story evidence receipt needs explicit public rights');
      if (!/^https?:\/\//i.test(row.canonicalUrl))
        throw new Error('Story evidence URL must be http(s)');
      const list = evidenceByStory.get(row.storyId) ?? [];
      list.push({
        receiptId: row.receiptId,
        evidenceRole: row.evidenceRole,
        canonicalUrl: row.canonicalUrl,
        capturedAt: row.capturedAt.toISOString(),
        rightsPolicy: row.rightsPolicy,
        sourceId: row.sourceId,
        sourceName: row.sourceName,
      });
      evidenceByStory.set(row.storyId, list);
    }
    const itemProjection = items.map((item) => {
      const translations = localizationsByVersion.get(item.versionGroupId);
      if (!translations?.en || !translations['zh-CN'])
        throw new Error(`Story ${item.storyId} is missing a locale`);
      const storyEvidence = evidenceByStory.get(item.storyId) ?? [];
      if (!storyEvidence.length) throw new Error(`Story ${item.storyId} requires evidence`);
      return {
        storyId: item.storyId,
        storyRevision: item.storyRevision,
        slug: item.slug,
        expiresAt: item.expiresAt?.toISOString() ?? null,
        sectionKey: item.sectionKey,
        placement: item.placement,
        position: item.position,
        localizations: translations,
        evidence: storyEvidence,
      };
    });
    const snapshotPayload = {
      sourceRunIds: sourceRuns.map((run) => run.runId).sort(),
      sourceSnapshotRevision: edition[0].sourceSnapshotRevision,
      event: {
        seasonCode: edition[0].seasonCode,
        eventId: edition[0].eventId,
        name: edition[0].eventName,
        deadlineTime: edition[0].deadlineTime.toISOString(),
        sourceCheckedAt: new Date(
          Math.max(...sourceRuns.map((run) => run.completedAt?.getTime() ?? 0)),
        ).toISOString(),
      },
      items: itemProjection,
    };
    frozenSha256 = requestHash(snapshotPayload);
    await tx.insert(contentWeekEditionSnapshots).values({
      snapshotId: randomUUID(),
      editionId,
      sourceRunIds: snapshotPayload.sourceRunIds,
      sourceSnapshotRevision: snapshotPayload.sourceSnapshotRevision,
      eventProjection: snapshotPayload.event,
      itemsProjection: snapshotPayload.items,
      frozenSha256,
    });
    await tx
      .update(contentWeekEditions)
      .set({ status: 'ready', readyAt: new Date(), frozenSha256, updatedAt: new Date() })
      .where(eq(contentWeekEditions.editionId, editionId));
    await audit(tx, actor, 'week-edition.ready', 'week_edition', editionId, {
      itemCount: items.length,
      frozenSha256,
    });
  });
  return { frozenSha256, replayed };
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
      storyRevision: Number(row.storyRevision),
      slug: row.slug,
      expiresAt: row.expiresAt,
      sectionKey: row.sectionKey,
      placement: row.placement,
      position: Number(row.position),
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

type FrozenEditionRow = Readonly<{
  storyId: string;
  storyRevision: number;
  slug: string;
  expiresAt: string | null;
  sectionKey: string;
  placement: string;
  position: number;
  localizations: Record<string, { title: string; summary: string }>;
  evidence: readonly Record<string, unknown>[];
}>;

function frozenItems(value: unknown): FrozenEditionRow[] {
  if (!Array.isArray(value)) throw new Error('Frozen Week snapshot items are invalid');
  return value.map((item) => {
    const row = jsonObject(item);
    const localizations = jsonObject(row.localizations) as Record<
      string,
      { title: string; summary: string }
    >;
    if (
      typeof row.storyId !== 'string' ||
      !Number.isSafeInteger(row.storyRevision) ||
      typeof row.slug !== 'string' ||
      typeof row.sectionKey !== 'string' ||
      typeof row.placement !== 'string' ||
      !Number.isSafeInteger(row.position) ||
      !jsonObject(localizations.en).title ||
      !jsonObject(localizations['zh-CN']).title
    )
      throw new Error('Frozen Week snapshot Story is invalid');
    return {
      storyId: row.storyId,
      storyRevision: Number(row.storyRevision),
      slug: row.slug,
      expiresAt: typeof row.expiresAt === 'string' ? row.expiresAt : null,
      sectionKey: row.sectionKey,
      placement: row.placement,
      position: Number(row.position),
      localizations: localizations as FrozenEditionRow['localizations'],
      evidence: Array.isArray(row.evidence) ? (row.evidence as Record<string, unknown>[]) : [],
    };
  });
}

/** Compile only from the immutable READY snapshot.  This is the reader used
 * by the new publisher command; the older compile helper remains for callers
 * that are still migrating to the frozen contract. */
export async function compileFrozenWeekEdition(input: {
  editionId: string;
  revision: number;
  publicationId: string;
  publishedAt: string;
  validUntil?: string | null;
  expectedFrozenSha256: string;
  database?: DbOrTransaction;
}): Promise<{ en: WeekPublicationEnvelope; 'zh-CN': WeekPublicationEnvelope }> {
  requireUuid(input.editionId, 'editionId');
  requireUuid(input.publicationId, 'publicationId');
  if (!/^[0-9a-f]{64}$/i.test(input.expectedFrozenSha256))
    throw new Error('expectedFrozenSha256 is invalid');
  const db = input.database ?? (await getDb());
  const rows = await db
    .select({
      seasonCode: contentWeekEditions.seasonCode,
      eventId: contentWeekEditions.eventId,
      eventName: contentWeekEditions.eventName,
      deadlineTime: contentWeekEditions.deadlineTime,
      status: contentWeekEditions.status,
      frozenSha256: contentWeekEditions.frozenSha256,
    })
    .from(contentWeekEditions)
    .where(eq(contentWeekEditions.editionId, input.editionId))
    .limit(1);
  const edition = rows[0];
  if (!edition || edition.status !== 'ready')
    throw new Error('Week edition must be READY before publish');
  if (!edition.frozenSha256 || edition.frozenSha256 !== input.expectedFrozenSha256)
    throw new ConflictError('Frozen Week hash does not match', 'FROZEN_HASH_MISMATCH');
  const snapshotRows = await db
    .select({
      eventProjection: contentWeekEditionSnapshots.eventProjection,
      itemsProjection: contentWeekEditionSnapshots.itemsProjection,
      frozenSha256: contentWeekEditionSnapshots.frozenSha256,
    })
    .from(contentWeekEditionSnapshots)
    .where(eq(contentWeekEditionSnapshots.editionId, input.editionId))
    .limit(1);
  const snapshot = snapshotRows[0];
  if (!snapshot || snapshot.frozenSha256 !== input.expectedFrozenSha256)
    throw new ConflictError('Frozen Week snapshot is unavailable', 'FROZEN_SNAPSHOT_UNAVAILABLE');
  const eventProjection = jsonObject(snapshot.eventProjection);
  const event = {
    seasonCode:
      typeof eventProjection.seasonCode === 'string'
        ? eventProjection.seasonCode
        : edition.seasonCode,
    eventId: Number(eventProjection.eventId ?? edition.eventId),
    name: typeof eventProjection.name === 'string' ? eventProjection.name : edition.eventName,
    deadlineTime:
      typeof eventProjection.deadlineTime === 'string'
        ? eventProjection.deadlineTime
        : edition.deadlineTime.toISOString(),
  };
  const items = frozenItems(snapshot.itemsProjection);
  const publishedAt = new Date(input.publishedAt);
  const validUntil = input.validUntil ? new Date(input.validUntil) : null;
  if (!Number.isFinite(publishedAt.getTime())) throw new Error('publishedAt is invalid');
  if (validUntil && (!Number.isFinite(validUntil.getTime()) || validUntil > edition.deadlineTime))
    throw new Error('validUntil exceeds deadline');
  const evidenceSourceCheckedAt = items
    .flatMap((item) =>
      item.evidence.map((evidence) =>
        typeof evidence.capturedAt === 'string' ? Date.parse(evidence.capturedAt) : NaN,
      ),
    )
    .filter(Number.isFinite)
    .reduce((latest, value) => Math.max(latest, value), publishedAt.getTime());
  const projectedSourceCheckedAt =
    typeof eventProjection.sourceCheckedAt === 'string'
      ? Date.parse(eventProjection.sourceCheckedAt)
      : NaN;
  const sourceCheckedAt = Number.isFinite(projectedSourceCheckedAt)
    ? projectedSourceCheckedAt
    : evidenceSourceCheckedAt;
  const build = (locale: WeekLocale): WeekPublicationEnvelope => {
    const cards = items
      .slice()
      .sort(
        (left, right) =>
          left.position - right.position || left.sectionKey.localeCompare(right.sectionKey),
      )
      .map((item) => {
        const localization = item.localizations[locale];
        if (!localization?.title || !localization.summary)
          throw new Error(`Frozen Story ${item.storyId} is missing ${locale}`);
        const source = item.evidence[0] ?? {};
        return {
          id: item.storyId,
          slug: item.slug,
          storyRevision: item.storyRevision,
          title: localization.title,
          summary: localization.summary,
          sourceName: typeof source.sourceName === 'string' ? source.sourceName : null,
          sourceUrl: typeof source.canonicalUrl === 'string' ? source.canonicalUrl : null,
          sourceCheckedAt: typeof source.capturedAt === 'string' ? source.capturedAt : null,
          expiresAt: item.expiresAt,
          sectionKey: item.sectionKey,
          placement: item.placement,
          position: item.position,
        };
      });
    const featured = cards
      .filter((card) => card.placement === 'featured')
      .map(
        ({ sectionKey: _sectionKey, placement: _placement, position: _position, ...card }) => card,
      );
    const sections = [...new Set(cards.map((card) => card.sectionKey))]
      .map((key) => ({
        key,
        title: key,
        items: cards
          .filter((card) => card.sectionKey === key && card.placement !== 'featured')
          .map(
            ({ sectionKey: _sectionKey, placement: _placement, position: _position, ...card }) =>
              card,
          ),
      }))
      .filter((section) => section.items.length);
    const envelope: WeekPublicationEnvelope = {
      schemaVersion: 1,
      scopeKind: 'SURFACE',
      scopeKey: 'week',
      revision: input.revision,
      publicationId: input.publicationId,
      state: cards.length ? 'READY' : 'EMPTY',
      locale,
      publishedAt: publishedAt.toISOString(),
      sourceCheckedAt: new Date(sourceCheckedAt).toISOString(),
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
  return pair;
}

export async function publishFrozenWeekEdition(input: {
  editionId: string;
  expectedFrozenSha256: string;
  reason: string;
  validUntil?: string | null;
  actor: EditorialActor;
}): Promise<WeekPublicationResult & { replayed: boolean }> {
  requireRole(input.actor, 'content_publisher');
  requireUuid(input.editionId, 'editionId');
  const reason = requireText(input.reason, 'reason');
  const db = await getDb();
  const publication = await db.transaction(async (tx) => {
    const reservation = await reserveCommand(
      tx,
      input.actor,
      'week-edition.publish',
      'week_edition',
      input.editionId,
      {
        expectedFrozenSha256: input.expectedFrozenSha256,
        reason,
        validUntil: input.validUntil ?? null,
      },
    );
    if (reservation.replay)
      return { replayed: true, result: jsonObject(reservation.result) } as const;
    const editionRows = await tx
      .select({
        editionId: contentWeekEditions.editionId,
        seasonCode: contentWeekEditions.seasonCode,
        eventId: contentWeekEditions.eventId,
        eventName: contentWeekEditions.eventName,
        deadlineTime: contentWeekEditions.deadlineTime,
        status: contentWeekEditions.status,
        frozenSha256: contentWeekEditions.frozenSha256,
      })
      .from(contentWeekEditions)
      .where(eq(contentWeekEditions.editionId, input.editionId))
      .for('update')
      .limit(1);
    const edition = editionRows[0];
    if (!edition || edition.status !== 'ready')
      throw new Error('Week edition must be READY before publish');
    if (edition.frozenSha256 !== input.expectedFrozenSha256)
      throw new ConflictError('Frozen Week hash does not match', 'FROZEN_HASH_MISMATCH');
    const latest = await tx
      .select({ revision: sql<number>`COALESCE(MAX(${contentPublications.revision}), 0)` })
      .from(contentPublications)
      .where(eq(contentPublications.scopeKey, 'week'));
    const revision = Number(latest[0]?.revision ?? 0) + 1;
    const publicationId = randomUUID();
    const publishedAt = new Date().toISOString();
    const pair = await compileFrozenWeekEdition({
      editionId: input.editionId,
      revision,
      publicationId,
      publishedAt,
      validUntil: input.validUntil,
      expectedFrozenSha256: input.expectedFrozenSha256,
      database: tx,
    });
    const result = await persistWeekPublication(tx, pair.en, pair['zh-CN']);
    await tx
      .update(contentWeekEditions)
      .set({
        status: 'published',
        publishedAt: new Date(publishedAt),
        publishedPublicationId: result.publicationId,
        updatedAt: new Date(),
      })
      .where(eq(contentWeekEditions.editionId, input.editionId));
    await audit(tx, input.actor, 'week-edition.publish', 'week_edition', input.editionId, {
      reason,
      publicationId: result.publicationId,
      revision: result.revision,
    });
    await tx
      .update(contentEditorialActions)
      .set({
        resultPayload: {
          publicationId: result.publicationId,
          revision: result.revision,
          state: result.state,
          redisPublished: result.redisPublished,
          outboxId: result.outboxId,
        },
      })
      .where(eq(contentEditorialActions.idempotencyKey, input.actor.idempotencyKey));
    return {
      replayed: false,
      result,
      pair,
    } as const;
  });
  if (publication.replayed) {
    const replayedResult = publication.result as unknown as WeekPublicationResult;
    const payloadRows = await db
      .select({
        locale: contentPublicationPayloads.locale,
        payload: contentPublicationPayloads.payload,
      })
      .from(contentPublicationPayloads)
      .where(eq(contentPublicationPayloads.publicationId, replayedResult.publicationId));
    const pair = {
      en: payloadRows.find((row) => row.locale === 'en')?.payload,
      'zh-CN': payloadRows.find((row) => row.locale === 'zh-CN')?.payload,
    };
    if (!pair.en || !pair['zh-CN'])
      throw new Error('Persisted Week publication payload pair is incomplete');
    assertWeekPublication(pair.en);
    assertWeekPublication(pair['zh-CN']);
    if (
      pair.en.publicationId !== replayedResult.publicationId ||
      pair['zh-CN'].publicationId !== replayedResult.publicationId ||
      pair.en.revision !== replayedResult.revision ||
      pair['zh-CN'].revision !== replayedResult.revision
    )
      throw new Error('Persisted Week publication payload pair is inconsistent');
    const staged = await stageWeekPublication(pair.en, pair['zh-CN'], replayedResult);
    return { ...staged, replayed: true };
  }
  const staged = await stageWeekPublication(
    publication.pair.en,
    publication.pair['zh-CN'],
    publication.result,
  );
  return { ...staged, replayed: false };
}
