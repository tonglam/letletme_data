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

type PublishBody = { en?: unknown; 'zh-CN'?: unknown };

function hasContentRole(request: Request, role: 'editor' | 'publisher'): boolean {
  if (process.env.NODE_ENV !== 'production' && !getAuthConfig().ENABLE_AUTH) return true;
  const key = request.headers.get('x-api-key');
  if (!key) return false;
  const flags = getContentRuntimeFlags();
  const hashes = role === 'publisher' ? flags.publisherApiKeyHashes : flags.editorApiKeyHashes;
  return matchesApiKeyHash(key, hashes);
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
    const value = body as PublishBody;
    assertWeekPublication(value.en);
    assertWeekPublication(value['zh-CN']);
    const result = await publishWeekPublication(
      value.en as WeekPublicationEnvelope,
      value['zh-CN'] as WeekPublicationEnvelope,
    );
    set.status = 201;
    return { success: true, data: result };
  });
