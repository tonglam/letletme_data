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
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors';
import {
  lockWeekPublicationScope,
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
  if (!actor.actorId.trim())
    throw new ValidationError('Editorial actor is required', 'EDITORIAL_ACTOR_REQUIRED');
  if (!actor.idempotencyKey.trim())
    throw new ValidationError('Editorial idempotency key is required', 'IDEMPOTENCY_KEY_REQUIRED');
};

const requireRole = (actor: EditorialActor, role: EditorialRole): void => {
  assertActor(actor);
  if (actor.role !== role)
    throw new ForbiddenError(`${role} role required`, 'EDITORIAL_ROLE_REQUIRED');
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
    throw new ValidationError(`${field} must be a UUID`, 'EDITORIAL_INVALID_UUID');
};

const requireText = (value: string, field: string): string => {
  const text = value.trim();
  if (!text) throw new ValidationError(`${field} is required`, 'EDITORIAL_REQUIRED_FIELD');
  return text;
};

const requireSha256 = (value: string, field: string): string => {
  const hash = value.trim();
  if (!/^[0-9a-f]{64}$/.test(hash))
    throw new ValidationError(
      `${field} must be a lowercase SHA-256 hash`,
      'EDITORIAL_HASH_INVALID',
    );
  return hash;
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
  const canonicalHash = requireSha256(input.canonicalHash, 'canonicalHash');
  if (!input.receiptIds.length)
    throw new ValidationError('At least one receipt is required', 'EDITORIAL_RECEIPTS_REQUIRED');
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
        canonicalHash,
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
    if (receipts.length !== input.receiptIds.length)
      throw new NotFoundError('Receipt is not in the run', 'EDITORIAL_RECEIPT_NOT_FOUND');
    await tx.insert(contentCandidateClusters).values({
      candidateId,
      runId: input.runId,
      canonicalHash,
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
      .for('update')
      .limit(1);
    if (!rows[0]) throw new NotFoundError('Candidate not found', 'EDITORIAL_CANDIDATE_NOT_FOUND');
    if (rows[0].status === 'merged' || rows[0].status === 'rejected')
      throw new ConflictError(
        'Candidate cannot be accepted from its current state',
        'EDITORIAL_STATE_CONFLICT',
      );
    const updated = await tx
      .update(contentCandidateClusters)
      .set({ status: 'accepted', updatedAt: new Date() })
      .where(
        and(
          eq(contentCandidateClusters.candidateId, candidateId),
          inArray(contentCandidateClusters.status, ['new', 'accepted']),
        ),
      )
      .returning({ candidateId: contentCandidateClusters.candidateId });
    if (!updated[0])
      throw new ConflictError(
        'Candidate cannot be accepted from its current state',
        'EDITORIAL_STATE_CONFLICT',
      );
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
  if (!sourceIds.length)
    throw new ValidationError(
      'At least one source candidate is required',
      'EDITORIAL_SOURCE_CANDIDATES_REQUIRED',
    );
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
      .where(inArray(contentCandidateClusters.candidateId, ids))
      // A source candidate is consumable by only one merge. Lock every
      // participating row in a deterministic order before checking status so
      // concurrent merges cannot both observe `accepted` and copy its receipts
      // into different targets.
      .orderBy(asc(contentCandidateClusters.candidateId))
      .for('update');
    if (rows.length !== ids.length)
      throw new NotFoundError('Candidate not found', 'EDITORIAL_CANDIDATE_NOT_FOUND');
    if (rows.some((row) => row.status === 'rejected' || row.status === 'merged'))
      throw new ConflictError(
        'Rejected or already merged candidate cannot be merged',
        'EDITORIAL_STATE_CONFLICT',
      );
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
    throw new ValidationError(
      'A draft Story requires en and zh-CN localizations',
      'EDITORIAL_LOCALES_REQUIRED',
    );
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
    if (!candidate[0])
      throw new NotFoundError('Candidate not found', 'EDITORIAL_CANDIDATE_NOT_FOUND');
    if (candidate[0].status !== 'accepted')
      throw new ConflictError(
        'Candidate must be accepted before creating a Story',
        'EDITORIAL_STATE_CONFLICT',
      );
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
  if (!receiptIds.length)
    throw new ValidationError('At least one receipt is required', 'EDITORIAL_RECEIPTS_REQUIRED');
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
    if (!story[0]) throw new NotFoundError('Story not found', 'EDITORIAL_STORY_NOT_FOUND');
    const receipts = await tx
      .select({ receiptId: contentSourceReceipts.receiptId })
      .from(contentSourceReceipts)
      .where(inArray(contentSourceReceipts.receiptId, [...new Set(receiptIds)]));
    if (receipts.length !== new Set(receiptIds).size)
      throw new NotFoundError('Receipt not found', 'EDITORIAL_RECEIPT_NOT_FOUND');
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
    if (!story[0]) throw new NotFoundError('Story not found', 'EDITORIAL_STORY_NOT_FOUND');
    if (story[0].status === 'removed')
      throw new ConflictError('Removed Story cannot be made ready', 'EDITORIAL_STATE_CONFLICT');
    const localizations = await tx
      .select({ locale: contentStoryLocalizations.locale })
      .from(contentStoryLocalizations)
      .where(eq(contentStoryLocalizations.versionGroupId, story[0].versionGroupId));
    const locales = new Set(localizations.map((row) => row.locale));
    if (!locales.has('en') || !locales.has('zh-CN'))
      throw new ValidationError(
        'Story requires en and zh-CN localizations',
        'EDITORIAL_LOCALES_REQUIRED',
      );
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
    if (!evidence.length)
      throw new ValidationError('Story requires evidence', 'EDITORIAL_EVIDENCE_REQUIRED');
    if (evidence.some((row) => !rightsAllowPublic(row.rightsPolicy)))
      throw new ValidationError(
        'Every Story evidence receipt needs explicit public rights',
        'EDITORIAL_RIGHTS_REQUIRED',
      );
    if (evidence.some((row) => !/^https?:\/\//i.test(row.canonicalUrl)))
      throw new ValidationError('Story evidence URL must be http(s)', 'EDITORIAL_URL_INVALID');
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
  if (!/^\d{4}$/.test(input.seasonCode))
    throw new ValidationError('seasonCode is invalid', 'EDITORIAL_SEASON_INVALID');
  if (!Number.isSafeInteger(input.eventId) || input.eventId <= 0)
    throw new ValidationError('eventId is invalid', 'EDITORIAL_EVENT_INVALID');
  const sourceSnapshotRevision = requireSha256(
    input.sourceSnapshotRevision,
    'sourceSnapshotRevision',
  );
  const sourceRunIds = [...new Set(input.sourceRunIds)];
  if (!sourceRunIds.length)
    throw new ValidationError(
      'At least one sourceRunId is required',
      'EDITORIAL_SOURCE_RUNS_REQUIRED',
    );
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
        sourceSnapshotRevision,
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
    if (runs.length !== sourceRunIds.length)
      throw new NotFoundError('Source run not found', 'EDITORIAL_SOURCE_RUN_NOT_FOUND');
    await tx.insert(contentWeekEditions).values({
      editionId,
      seasonCode: input.seasonCode,
      eventId: input.eventId,
      eventName: requireText(input.eventName, 'eventName'),
      deadlineTime: new Date(input.deadlineTime),
      sourceSnapshotRevision,
      status: 'draft',
    });
    await tx.insert(contentWeekEditionSourceRuns).values(
      sourceRunIds.map((runId) => ({
        editionId,
        runId,
        sourceSnapshotRevision,
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
    throw new ValidationError('position is invalid', 'EDITORIAL_POSITION_INVALID');
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
    if (!edition[0])
      throw new NotFoundError('Week edition not found', 'EDITORIAL_EDITION_NOT_FOUND');
    if (!story[0]) throw new NotFoundError('Story not found', 'EDITORIAL_STORY_NOT_FOUND');
    if (story[0].status !== 'ready')
      throw new ConflictError(
        'Only ready Stories can enter a Week edition',
        'EDITORIAL_STATE_CONFLICT',
      );
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
    if (!edition[0])
      throw new NotFoundError('Week edition not found', 'EDITORIAL_EDITION_NOT_FOUND');
    if (edition[0].status !== 'draft')
      throw new ConflictError(
        'Only draft Week editions can become READY',
        'EDITORIAL_STATE_CONFLICT',
      );
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
      .where(eq(contentWeekEditionSourceRuns.editionId, editionId))
      .for('update', { of: contentAcquisitionRuns });
    if (!sourceRuns.length)
      throw new ValidationError(
        'Week edition requires source runs',
        'EDITORIAL_SOURCE_RUNS_REQUIRED',
      );
    if (
      sourceRuns.some(
        (run) =>
          !['completed', 'empty', 'partial'].includes(run.status) ||
          run.traceVerified !== true ||
          run.checkpointAdvanced !== true ||
          !run.completedAt ||
          run.linkedRevision !== edition[0].sourceSnapshotRevision ||
          run.runRevision !== edition[0].sourceSnapshotRevision,
      )
    )
      throw new ConflictError(
        'Week edition source runs are incomplete or stale',
        'EDITORIAL_STATE_CONFLICT',
      );
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
      throw new ConflictError(
        'Week edition contains a Story that is not ready',
        'EDITORIAL_STATE_CONFLICT',
      );
    const positions = new Set<string>();
    for (const item of items) {
      const key = `${item.sectionKey}:${item.position}`;
      if (positions.has(key))
        throw new ValidationError(`Duplicate Week position ${key}`, 'EDITORIAL_DUPLICATE_POSITION');
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
            runId: contentSourceReceipts.runId,
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
    const verifiedRunIds = new Set(sourceRuns.map((run) => run.runId));
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
      if (!verifiedRunIds.has(row.runId))
        throw new ValidationError(
          'Every Story evidence receipt must belong to a verified source run',
          'EDITORIAL_EVIDENCE_UNVERIFIED',
        );
      if (!rightsAllowPublic(row.rightsPolicy))
        throw new ValidationError(
          'Every Story evidence receipt needs explicit public rights',
          'EDITORIAL_RIGHTS_REQUIRED',
        );
      if (!/^https?:\/\//i.test(row.canonicalUrl))
        throw new ValidationError('Story evidence URL must be http(s)', 'EDITORIAL_URL_INVALID');
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
        throw new ValidationError(
          `Story ${item.storyId} is missing a locale`,
          'EDITORIAL_LOCALES_REQUIRED',
        );
      const storyEvidence = evidenceByStory.get(item.storyId) ?? [];
      if (!storyEvidence.length)
        throw new ValidationError(
          `Story ${item.storyId} requires evidence`,
          'EDITORIAL_EVIDENCE_REQUIRED',
        );
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
    throw new ValidationError('revision is invalid', 'EDITORIAL_REVISION_INVALID');
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
  if (!editionRow) throw new NotFoundError('Week edition not found', 'EDITORIAL_EDITION_NOT_FOUND');
  if (editionRow.status !== 'ready')
    throw new ConflictError(
      'Week edition must be ready before compile',
      'EDITORIAL_STATE_CONFLICT',
    );
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
    throw new ConflictError(
      'Week edition contains invalid Story revision',
      'EDITORIAL_STATE_CONFLICT',
    );
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
      throw new ValidationError(
        `Story ${row.storyId} is missing a locale`,
        'EDITORIAL_LOCALES_REQUIRED',
      );
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
    throw new ValidationError('Publication timestamps are invalid', 'EDITORIAL_TIMESTAMP_INVALID');
  if (
    validUntil &&
    (!Number.isFinite(validUntil.getTime()) || validUntil > editionRow.deadlineTime)
  )
    throw new ValidationError('validUntil exceeds deadline', 'EDITORIAL_VALID_UNTIL_INVALID');
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
  if (!Array.isArray(value))
    throw new ValidationError(
      'Frozen Week snapshot items are invalid',
      'EDITORIAL_SNAPSHOT_INVALID',
    );
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
      throw new ValidationError(
        'Frozen Week snapshot Story is invalid',
        'EDITORIAL_SNAPSHOT_INVALID',
      );
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
  const expectedFrozenSha256 = requireSha256(input.expectedFrozenSha256, 'expectedFrozenSha256');
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
  if (!edition) throw new NotFoundError('Week edition not found', 'EDITORIAL_EDITION_NOT_FOUND');
  if (edition.status !== 'ready')
    throw new ConflictError(
      'Week edition must be READY before publish',
      'EDITORIAL_STATE_CONFLICT',
    );
  if (!edition.frozenSha256 || edition.frozenSha256 !== expectedFrozenSha256)
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
  if (!snapshot || snapshot.frozenSha256 !== expectedFrozenSha256)
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
  if (!Number.isFinite(publishedAt.getTime()))
    throw new ValidationError('publishedAt is invalid', 'EDITORIAL_TIMESTAMP_INVALID');
  if (validUntil && (!Number.isFinite(validUntil.getTime()) || validUntil > edition.deadlineTime))
    throw new ValidationError('validUntil exceeds deadline', 'EDITORIAL_VALID_UNTIL_INVALID');
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
          throw new ValidationError(
            `Frozen Story ${item.storyId} is missing ${locale}`,
            'EDITORIAL_LOCALES_REQUIRED',
          );
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
  const expectedFrozenSha256 = requireSha256(input.expectedFrozenSha256, 'expectedFrozenSha256');
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
        expectedFrozenSha256,
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
    if (!edition) throw new NotFoundError('Week edition not found', 'EDITORIAL_EDITION_NOT_FOUND');
    if (edition.status !== 'ready')
      throw new ConflictError(
        'Week edition must be READY before publish',
        'EDITORIAL_STATE_CONFLICT',
      );
    if (edition.frozenSha256 !== expectedFrozenSha256)
      throw new ConflictError('Frozen Week hash does not match', 'FROZEN_HASH_MISMATCH');
    // Allocate the next revision only after taking the same PostgreSQL scope
    // lock used by publication persistence. Otherwise concurrent publishers
    // can both observe the same MAX(revision) and race into a unique-key error.
    await lockWeekPublicationScope(tx);
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
      expectedFrozenSha256,
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
      throw new NotFoundError(
        'Persisted Week publication payload pair is incomplete',
        'EDITORIAL_PUBLICATION_PAYLOAD_NOT_FOUND',
      );
    assertWeekPublication(pair.en);
    assertWeekPublication(pair['zh-CN']);
    if (
      pair.en.publicationId !== replayedResult.publicationId ||
      pair['zh-CN'].publicationId !== replayedResult.publicationId ||
      pair.en.revision !== replayedResult.revision ||
      pair['zh-CN'].revision !== replayedResult.revision
    )
      throw new ConflictError(
        'Persisted Week publication payload pair is inconsistent',
        'EDITORIAL_PUBLICATION_PAYLOAD_CONFLICT',
      );
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
