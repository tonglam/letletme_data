import { Elysia, t } from 'elysia';

import { getContentRuntimeFlags } from '../config';
import { getAuthConfig } from '../../utils/config';
import { matchesApiKeyHash } from '../../api/auth.guard';
import {
  addSourceToGroup,
  upsertContentSource,
  upsertContentSourceGroup,
  type ContentSourceGroupInput,
  type ContentSourceInput,
} from '../acquisition/source-registry';
import { readActiveWeekPublication } from '../publication/week-publication';
import {
  acceptCandidate,
  addWeekEditionItem,
  attachStoryEvidence,
  createCandidateFromReceipts,
  createDraftStory,
  createWeekEdition,
  markStoryReady,
  markWeekEditionReady,
  mergeCandidates,
  publishFrozenWeekEdition,
  type EditorialActor,
  type StoryLocalizationInput,
} from '../editorial/editorial-repository';

function hasContentRole(request: Request, role: 'editor' | 'publisher'): boolean {
  if (process.env.NODE_ENV !== 'production' && !getAuthConfig().ENABLE_AUTH) return true;
  const key = request.headers.get('x-api-key');
  if (!key) return false;
  const flags = getContentRuntimeFlags();
  const hashes = role === 'publisher' ? flags.publisherApiKeyHashes : flags.editorApiKeyHashes;
  return matchesApiKeyHash(key, hashes);
}

function editorialActor(request: Request, role: EditorialActor['role']): EditorialActor | null {
  const idempotencyKey =
    request.headers.get('idempotency-key')?.trim() ||
    request.headers.get('x-idempotency-key')?.trim();
  const actorId = request.headers.get('x-actor-id')?.trim();
  if (!idempotencyKey || !actorId) return null;
  return {
    actorId,
    role,
    idempotencyKey,
  };
}

function requireActor(request: Request, role: EditorialActor['role'], set: { status?: unknown }) {
  const actor = editorialActor(request, role);
  if (!actor) {
    set.status = 400;
    return null;
  }
  return actor;
}

const uuid = t.String({ format: 'uuid' });
const sha256 = t.String({ pattern: '^[0-9a-fA-F]{64}$' });
const dateTime = t.String({ format: 'date-time' });
const locale = t.Union([t.Literal('en'), t.Literal('zh-CN')]);
const localization = t.Object({
  locale,
  title: t.String({ minLength: 1, maxLength: 240 }),
  summary: t.String({ minLength: 1, maxLength: 1_000 }),
  body: t.String({ minLength: 1, maxLength: 50_000 }),
  sourceAttribution: t.Optional(t.Union([t.String({ maxLength: 500 }), t.Null()])),
  claims: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 1_000 }), { maxItems: 100 })),
});
const editorialIdParams = (name: string) => t.Object({ [name]: uuid });
const candidateCreateBody = t.Object({
  runId: uuid,
  canonicalHash: sha256,
  materiality: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  receiptIds: t.Array(uuid, { minItems: 1, maxItems: 100, uniqueItems: true }),
});
const candidateMergeBody = t.Object({
  sourceCandidateIds: t.Array(uuid, { minItems: 1, maxItems: 100, uniqueItems: true }),
});
const storyCreateBody = t.Object({
  candidateId: uuid,
  slug: t.String({ minLength: 1, maxLength: 200 }),
  expiresAt: t.Optional(t.Union([dateTime, t.Null()])),
  localizations: t.Array(localization, { minItems: 2, maxItems: 2 }),
});
const evidenceBody = t.Object({
  receiptIds: t.Array(uuid, { minItems: 1, maxItems: 100, uniqueItems: true }),
});
const editionCreateBody = t.Object({
  seasonCode: t.String({ pattern: '^\\d{4}$' }),
  eventId: t.Integer({ minimum: 1 }),
  eventName: t.String({ minLength: 1, maxLength: 240 }),
  deadlineTime: dateTime,
  sourceSnapshotRevision: sha256,
  sourceRunIds: t.Array(uuid, { minItems: 1, maxItems: 100, uniqueItems: true }),
});
const editionItemBody = t.Object({
  storyId: uuid,
  sectionKey: t.String({ minLength: 1, maxLength: 64 }),
  placement: t.Optional(t.Union([t.Literal('featured'), t.Literal('standard')])),
  position: t.Integer({ minimum: 0 }),
});
const publishBody = t.Object({
  reason: t.String({ minLength: 1, maxLength: 1_000 }),
  expectedFrozenSha256: sha256,
  validUntil: t.Optional(t.Union([dateTime, t.Null()])),
});
const sourceGroupBody = t.Object({
  groupKey: t.String({ minLength: 1, maxLength: 100 }),
  displayName: t.String({ minLength: 1, maxLength: 240 }),
  pollPolicy: t.Optional(t.Object({}, { additionalProperties: true })),
});
const sourceBody = t.Object({
  platform: t.String({ minLength: 1, maxLength: 32 }),
  externalId: t.String({ minLength: 1, maxLength: 128 }),
  handle: t.Optional(t.Union([t.String({ maxLength: 128 }), t.Null()])),
  displayName: t.String({ minLength: 1, maxLength: 200 }),
  sourceType: t.String({ minLength: 1, maxLength: 64 }),
  reportingFamily: t.String({ minLength: 1, maxLength: 64 }),
  rightsPolicy: t.Optional(t.Object({}, { additionalProperties: true })),
});
const sourceMemberParams = t.Object({
  groupKey: t.String({ minLength: 1, maxLength: 100 }),
  sourceId: uuid,
});

export const contentAPI = new Elysia({ prefix: '/content' })
  .get('/briefing/week/active', async ({ query, set }) => {
    const flags = getContentRuntimeFlags();
    if (!flags.briefingPublicEnabled) {
      set.status = 404;
      return { success: false, error: 'Briefing Week is not publicly enabled' };
    }
    const locale = query.locale === 'zh-CN' ? 'zh-CN' : 'en';
    const publication = await readActiveWeekPublication(locale);
    if (!publication) {
      set.status = 404;
      return { success: false, error: 'No active Week publication' };
    }
    return { success: true, data: publication };
  })
  .post(
    '/sources/groups',
    async ({ body, request, set }) => {
      if (!hasContentRole(request, 'editor')) {
        set.status = 403;
        return { success: false, error: 'Content editor role required' };
      }
      const actor = requireActor(request, 'content_editor', set);
      if (!actor) return { success: false, error: 'Idempotency-Key is required' };
      const value = body as ContentSourceGroupInput;
      if (!value.groupKey || !value.displayName) {
        set.status = 400;
        return { success: false, error: 'groupKey and displayName are required' };
      }
      const groupId = await upsertContentSourceGroup(value, actor);
      return { success: true, data: { groupId } };
    },
    { body: sourceGroupBody },
  )
  .post(
    '/sources',
    async ({ body, request, set }) => {
      if (!hasContentRole(request, 'editor')) {
        set.status = 403;
        return { success: false, error: 'Content editor role required' };
      }
      const actor = requireActor(request, 'content_editor', set);
      if (!actor) return { success: false, error: 'Idempotency-Key is required' };
      const value = body as ContentSourceInput;
      if (
        !value.platform ||
        !value.externalId ||
        !value.displayName ||
        !value.sourceType ||
        !value.reportingFamily
      ) {
        set.status = 400;
        return {
          success: false,
          error: 'platform, externalId, displayName, sourceType and reportingFamily are required',
        };
      }
      const sourceId = await upsertContentSource(value, actor);
      return { success: true, data: { sourceId } };
    },
    { body: sourceBody },
  )
  .post(
    '/sources/groups/:groupKey/members/:sourceId',
    async ({ params, request, set }) => {
      if (!hasContentRole(request, 'editor')) {
        set.status = 403;
        return { success: false, error: 'Content editor role required' };
      }
      const actor = requireActor(request, 'content_editor', set);
      if (!actor) return { success: false, error: 'Idempotency-Key is required' };
      await addSourceToGroup(params.groupKey, params.sourceId, 100, actor);
      return { success: true };
    },
    { params: sourceMemberParams },
  )
  .post(
    '/editorial/candidates',
    async ({ body, request, set }) => {
      if (!hasContentRole(request, 'editor')) {
        set.status = 403;
        return { success: false, error: 'Content editor role required' };
      }
      const actor = requireActor(request, 'content_editor', set);
      if (!actor) return { success: false, error: 'Idempotency-Key is required' };
      const value = body as {
        runId?: string;
        canonicalHash?: string;
        materiality?: string;
        receiptIds?: string[];
      };
      const candidateId = await createCandidateFromReceipts({
        runId: value.runId ?? '',
        canonicalHash: value.canonicalHash ?? '',
        materiality: value.materiality,
        receiptIds: value.receiptIds ?? [],
        actor,
      });
      set.status = 201;
      return { success: true, data: { candidateId } };
    },
    { body: candidateCreateBody },
  )
  .post(
    '/editorial/candidates/:candidateId/accept',
    async ({ params, request, set }) => {
      if (!hasContentRole(request, 'editor')) {
        set.status = 403;
        return { success: false, error: 'Content editor role required' };
      }
      const actor = requireActor(request, 'content_editor', set);
      if (!actor) return { success: false, error: 'Idempotency-Key is required' };
      await acceptCandidate(params.candidateId, actor);
      return { success: true };
    },
    { params: editorialIdParams('candidateId') },
  )
  .post(
    '/editorial/candidates/:candidateId/merge',
    async ({ params, body, request, set }) => {
      if (!hasContentRole(request, 'editor')) {
        set.status = 403;
        return { success: false, error: 'Content editor role required' };
      }
      const actor = requireActor(request, 'content_editor', set);
      if (!actor) return { success: false, error: 'Idempotency-Key is required' };
      const value = body as { sourceCandidateIds?: string[] };
      await mergeCandidates(params.candidateId, value.sourceCandidateIds ?? [], actor);
      return { success: true };
    },
    { params: editorialIdParams('candidateId'), body: candidateMergeBody },
  )
  .post(
    '/editorial/stories',
    async ({ body, request, set }) => {
      if (!hasContentRole(request, 'editor')) {
        set.status = 403;
        return { success: false, error: 'Content editor role required' };
      }
      const actor = requireActor(request, 'content_editor', set);
      if (!actor) return { success: false, error: 'Idempotency-Key is required' };
      const value = body as {
        candidateId?: string;
        slug?: string;
        expiresAt?: string | null;
        localizations?: StoryLocalizationInput[];
      };
      const storyId = await createDraftStory({
        candidateId: value.candidateId ?? '',
        slug: value.slug ?? '',
        expiresAt: value.expiresAt,
        localizations: value.localizations ?? [],
        actor,
      });
      set.status = 201;
      return { success: true, data: { storyId } };
    },
    { body: storyCreateBody },
  )
  .post(
    '/editorial/stories/:storyId/evidence',
    async ({ params, body, request, set }) => {
      if (!hasContentRole(request, 'editor')) {
        set.status = 403;
        return { success: false, error: 'Content editor role required' };
      }
      const actor = requireActor(request, 'content_editor', set);
      if (!actor) return { success: false, error: 'Idempotency-Key is required' };
      const value = body as { receiptIds?: string[] };
      const inserted = await attachStoryEvidence(params.storyId, value.receiptIds ?? [], actor);
      return { success: true, data: { inserted } };
    },
    { params: editorialIdParams('storyId'), body: evidenceBody },
  )
  .post(
    '/editorial/stories/:storyId/ready',
    async ({ params, request, set }) => {
      if (!hasContentRole(request, 'editor')) {
        set.status = 403;
        return { success: false, error: 'Content editor role required' };
      }
      const actor = requireActor(request, 'content_editor', set);
      if (!actor) return { success: false, error: 'Idempotency-Key is required' };
      await markStoryReady(params.storyId, actor);
      return { success: true };
    },
    { params: editorialIdParams('storyId') },
  )
  .post(
    '/editorial/week-editions',
    async ({ body, request, set }) => {
      if (!hasContentRole(request, 'editor')) {
        set.status = 403;
        return { success: false, error: 'Content editor role required' };
      }
      const actor = requireActor(request, 'content_editor', set);
      if (!actor) return { success: false, error: 'Idempotency-Key is required' };
      const value = body as {
        seasonCode?: string;
        eventId?: number;
        eventName?: string;
        deadlineTime?: string;
        sourceSnapshotRevision?: string;
        sourceRunIds?: string[];
      };
      const editionId = await createWeekEdition({
        seasonCode: value.seasonCode ?? '',
        eventId: value.eventId ?? 0,
        eventName: value.eventName ?? '',
        deadlineTime: value.deadlineTime ?? '',
        sourceSnapshotRevision: value.sourceSnapshotRevision ?? '',
        sourceRunIds: value.sourceRunIds ?? [],
        actor,
      });
      set.status = 201;
      return { success: true, data: { editionId } };
    },
    { body: editionCreateBody },
  )
  .post(
    '/editorial/week-editions/:editionId/items',
    async ({ params, body, request, set }) => {
      if (!hasContentRole(request, 'editor')) {
        set.status = 403;
        return { success: false, error: 'Content editor role required' };
      }
      const actor = requireActor(request, 'content_editor', set);
      if (!actor) return { success: false, error: 'Idempotency-Key is required' };
      const value = body as {
        storyId?: string;
        sectionKey?: string;
        placement?: 'featured' | 'standard';
        position?: number;
      };
      await addWeekEditionItem({
        editionId: params.editionId,
        storyId: value.storyId ?? '',
        sectionKey: value.sectionKey ?? '',
        placement: value.placement,
        position: value.position ?? -1,
        actor,
      });
      return { success: true };
    },
    { params: editorialIdParams('editionId'), body: editionItemBody },
  )
  .post(
    '/editorial/week-editions/:editionId/ready',
    async ({ params, request, set }) => {
      if (!hasContentRole(request, 'editor')) {
        set.status = 403;
        return { success: false, error: 'Content editor role required' };
      }
      const actor = requireActor(request, 'content_editor', set);
      if (!actor) return { success: false, error: 'Idempotency-Key is required' };
      const ready = await markWeekEditionReady(params.editionId, actor);
      return {
        success: true,
        data: {
          editionId: params.editionId,
          status: 'ready',
          frozenSha256: ready.frozenSha256,
          replayed: ready.replayed,
        },
      };
    },
    { params: editorialIdParams('editionId') },
  )
  .post(
    '/briefing/week/editions/:editionId/publish',
    async ({ params, body, request, set }) => {
      if (!hasContentRole(request, 'publisher')) {
        set.status = 403;
        return { success: false, error: 'Content publisher role required' };
      }
      if (!getContentRuntimeFlags().publicationEnabled) {
        set.status = 409;
        return { success: false, error: 'Content publication is disabled' };
      }
      const actor = requireActor(request, 'content_publisher', set);
      if (!actor) return { success: false, error: 'Idempotency-Key is required' };
      const value = body as {
        reason?: string;
        expectedFrozenSha256?: string;
        validUntil?: string | null;
      };
      const result = await publishFrozenWeekEdition({
        editionId: params.editionId,
        reason: value.reason ?? '',
        expectedFrozenSha256: value.expectedFrozenSha256 ?? '',
        validUntil: value.validUntil,
        actor,
      });
      set.status = result.replayed ? 200 : 201;
      return { success: true, data: result };
    },
    { params: editorialIdParams('editionId'), body: publishBody },
  );
