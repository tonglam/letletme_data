import { Elysia, t } from 'elysia';

import { createBugReport, updateBugReportStatus } from '../services/bug-report.service';
import {
  getHttpStatusFromError,
  getOrCreateRequestId,
  getPublicErrorCode,
  getPublicErrorMessage,
} from '../utils/errors';
import { logError } from '../utils/logger';

const optionalPositiveInteger = t.Union([t.Number({ minimum: 1, multipleOf: 1 }), t.Null()]);

export const bugReportsAPI = new Elysia({ prefix: '/bug-reports' }).post(
  '/',
  async ({ body, request, set }) => {
    try {
      const result = await createBugReport({
        source: body.source,
        userId: body.userId,
        entryId: body.entryId,
        body: body.body,
        submissionId: body.submissionId,
        screenshotObjectKey: body.screenshotObjectKey,
        screenshotUrl: body.screenshotUrl,
        clientMeta: body.clientMeta,
      });
      set.status = 201;
      return { success: true, publicId: result.publicId };
    } catch (error) {
      const status = getHttpStatusFromError(error);
      set.status = status;
      const requestId = getOrCreateRequestId(request);
      logError('Bug report request failed', error, { requestId });
      set.headers['x-request-id'] = requestId;
      const code = getPublicErrorCode(error, status);
      return {
        success: false,
        error: getPublicErrorMessage(error, status),
        ...(code ? { code } : {}),
        ...(status >= 500 && process.env.NODE_ENV === 'production' ? { requestId } : {}),
      };
    }
  },
  {
    body: t.Object({
      source: t.Union([t.Literal('website'), t.Literal('wechat_miniprogram')]),
      userId: t.Optional(t.Union([t.String(), t.Null()])),
      entryId: t.Optional(optionalPositiveInteger),
      body: t.String({ minLength: 1, maxLength: 500 }),
      submissionId: t.Optional(t.Union([t.String(), t.Null()])),
      screenshotObjectKey: t.Optional(t.Union([t.String(), t.Null()])),
      screenshotUrl: t.Optional(t.Union([t.String(), t.Null()])),
      clientMeta: t.Optional(t.Object({}, { additionalProperties: true })),
    }),
  },
);

export const bugReportsStatusAPI = new Elysia({ prefix: '/bug-reports' }).patch(
  '/:publicId/status',
  async ({ params, body, request, set }) => {
    try {
      const result = await updateBugReportStatus(params.publicId, body.status);
      if (!result) {
        set.status = 404;
        return { success: false, error: 'Bug report not found' };
      }
      return {
        success: true,
        publicId: result.publicId,
        status: result.status,
        closedAt: result.closedAt?.toISOString() ?? null,
        expiresAt: result.expiresAt.toISOString(),
      };
    } catch (error) {
      const status = getHttpStatusFromError(error);
      set.status = status;
      const requestId = getOrCreateRequestId(request);
      logError('Bug report status request failed', error, { requestId });
      set.headers['x-request-id'] = requestId;
      const code = getPublicErrorCode(error, status);
      return {
        success: false,
        error: getPublicErrorMessage(error, status),
        ...(code ? { code } : {}),
        ...(status >= 500 && process.env.NODE_ENV === 'production' ? { requestId } : {}),
      };
    }
  },
  {
    params: t.Object({ publicId: t.String({ pattern: '^LL-([0-9A-F]{6}|[0-9A-F]{12})$' }) }),
    body: t.Object({
      status: t.Union([t.Literal('open'), t.Literal('ack'), t.Literal('closed')]),
    }),
  },
);
