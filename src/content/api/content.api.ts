import { Elysia } from 'elysia';

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
import { readActiveWeekPublication, publishWeekPublication } from '../publication/week-publication';
import { assertWeekPublication, type WeekPublicationEnvelope } from '../contracts/week-publication';
import {
  acceptCandidate,
  addWeekEditionItem,
  attachStoryEvidence,
  compileWeekEdition,
  createCandidateFromReceipts,
  createDraftStory,
  createWeekEdition,
  markStoryReady,
  markWeekEditionReady,
  mergeCandidates,
  type EditorialActor,
  type StoryLocalizationInput,
} from '../editorial/editorial-repository';

type PublishBody = { en?: unknown; 'zh-CN'?: unknown };

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
  if (!idempotencyKey) return null;
  return {
    actorId: request.headers.get('x-actor-id')?.trim() || 'content-api-key',
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

export const contentAPI = new Elysia({ prefix: '/content' })
  .get('/briefing/week/active', async ({ query, set }) => {
    const locale = query.locale === 'zh-CN' ? 'zh-CN' : 'en';
    const publication = await readActiveWeekPublication(locale);
    if (!publication) {
      set.status = 404;
      return { success: false, error: 'No active Week publication' };
    }
    return { success: true, data: publication };
  })
  .post('/sources/groups', async ({ body, request, set }) => {
    if (!hasContentRole(request, 'editor')) {
      set.status = 403;
      return { success: false, error: 'Content editor role required' };
    }
    const value = body as ContentSourceGroupInput;
    if (!value.groupKey || !value.displayName) {
      set.status = 400;
      return { success: false, error: 'groupKey and displayName are required' };
    }
    const groupId = await upsertContentSourceGroup(value);
    return { success: true, data: { groupId } };
  })
  .post('/sources', async ({ body, request, set }) => {
    if (!hasContentRole(request, 'editor')) {
      set.status = 403;
      return { success: false, error: 'Content editor role required' };
    }
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
    const sourceId = await upsertContentSource(value);
    return { success: true, data: { sourceId } };
  })
  .post('/sources/groups/:groupKey/members/:sourceId', async ({ params, request, set }) => {
    if (!hasContentRole(request, 'editor')) {
      set.status = 403;
      return { success: false, error: 'Content editor role required' };
    }
    await addSourceToGroup(params.groupKey, params.sourceId);
    return { success: true };
  })
  .post('/briefing/week/publish', async ({ body, request, set }) => {
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
    void actor;
    const value = body as PublishBody;
    assertWeekPublication(value.en);
    assertWeekPublication(value['zh-CN']);
    const result = await publishWeekPublication(
      value.en as WeekPublicationEnvelope,
      value['zh-CN'] as WeekPublicationEnvelope,
    );
    set.status = 201;
    return { success: true, data: result };
  })
  .post('/editorial/candidates', async ({ body, request, set }) => {
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
  })
  .post('/editorial/candidates/:candidateId/accept', async ({ params, request, set }) => {
    if (!hasContentRole(request, 'editor')) {
      set.status = 403;
      return { success: false, error: 'Content editor role required' };
    }
    const actor = requireActor(request, 'content_editor', set);
    if (!actor) return { success: false, error: 'Idempotency-Key is required' };
    await acceptCandidate(params.candidateId, actor);
    return { success: true };
  })
  .post('/editorial/candidates/:candidateId/merge', async ({ params, body, request, set }) => {
    if (!hasContentRole(request, 'editor')) {
      set.status = 403;
      return { success: false, error: 'Content editor role required' };
    }
    const actor = requireActor(request, 'content_editor', set);
    if (!actor) return { success: false, error: 'Idempotency-Key is required' };
    const value = body as { sourceCandidateIds?: string[] };
    await mergeCandidates(params.candidateId, value.sourceCandidateIds ?? [], actor);
    return { success: true };
  })
  .post('/editorial/stories', async ({ body, request, set }) => {
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
  })
  .post('/editorial/stories/:storyId/evidence', async ({ params, body, request, set }) => {
    if (!hasContentRole(request, 'editor')) {
      set.status = 403;
      return { success: false, error: 'Content editor role required' };
    }
    const actor = requireActor(request, 'content_editor', set);
    if (!actor) return { success: false, error: 'Idempotency-Key is required' };
    const value = body as { receiptIds?: string[] };
    const inserted = await attachStoryEvidence(params.storyId, value.receiptIds ?? [], actor);
    return { success: true, data: { inserted } };
  })
  .post('/editorial/stories/:storyId/ready', async ({ params, request, set }) => {
    if (!hasContentRole(request, 'editor')) {
      set.status = 403;
      return { success: false, error: 'Content editor role required' };
    }
    const actor = requireActor(request, 'content_editor', set);
    if (!actor) return { success: false, error: 'Idempotency-Key is required' };
    await markStoryReady(params.storyId, actor);
    return { success: true };
  })
  .post('/editorial/week-editions', async ({ body, request, set }) => {
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
    };
    const editionId = await createWeekEdition({
      seasonCode: value.seasonCode ?? '',
      eventId: value.eventId ?? 0,
      eventName: value.eventName ?? '',
      deadlineTime: value.deadlineTime ?? '',
      sourceSnapshotRevision: value.sourceSnapshotRevision ?? '',
      actor,
    });
    set.status = 201;
    return { success: true, data: { editionId } };
  })
  .post('/editorial/week-editions/:editionId/items', async ({ params, body, request, set }) => {
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
  })
  .post('/editorial/week-editions/:editionId/ready', async ({ params, request, set }) => {
    if (!hasContentRole(request, 'editor')) {
      set.status = 403;
      return { success: false, error: 'Content editor role required' };
    }
    const actor = requireActor(request, 'content_editor', set);
    if (!actor) return { success: false, error: 'Idempotency-Key is required' };
    await markWeekEditionReady(params.editionId, actor);
    return { success: true };
  })
  .post('/briefing/week/editions/:editionId/publish', async ({ params, body, request, set }) => {
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
      revision?: number;
      publicationId?: string;
      sourceCheckedAt?: string;
      publishedAt?: string;
      validUntil?: string | null;
    };
    const pair = await compileWeekEdition({
      editionId: params.editionId,
      revision: value.revision ?? 0,
      publicationId: value.publicationId ?? '',
      sourceCheckedAt: value.sourceCheckedAt ?? '',
      publishedAt: value.publishedAt ?? '',
      validUntil: value.validUntil,
      actor,
    });
    const result = await publishWeekPublication(pair.en, pair['zh-CN']);
    set.status = 201;
    return { success: true, data: result };
  });
