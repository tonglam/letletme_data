import { Elysia, t } from 'elysia';

import { createBugReport } from '../services/bug-report.service';
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
