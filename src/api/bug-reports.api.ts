import { Elysia, t } from 'elysia';

import { createBugReport } from '../services/bug-report.service';
import { getErrorMessage, getHttpStatusFromError } from '../utils/errors';

const optionalPositiveInteger = t.Union([t.Number({ minimum: 1, multipleOf: 1 }), t.Null()]);

export const bugReportsAPI = new Elysia({ prefix: '/bug-reports' }).post(
  '/',
  async ({ body, set }) => {
    try {
      const result = await createBugReport({
        source: body.source,
        userId: body.userId,
        entryId: body.entryId,
        body: body.body,
        screenshotUrl: body.screenshotUrl,
        clientMeta: body.clientMeta,
      });
      set.status = 201;
      return { success: true, publicId: result.publicId };
    } catch (error) {
      const status = getHttpStatusFromError(error);
      set.status = status;
      return { success: false, error: getErrorMessage(error) };
    }
  },
  {
    body: t.Object({
      source: t.Union([t.Literal('website'), t.Literal('wechat_miniprogram')]),
      userId: t.Optional(t.Union([t.String(), t.Null()])),
      entryId: t.Optional(optionalPositiveInteger),
      body: t.String({ minLength: 1, maxLength: 500 }),
      screenshotUrl: t.Optional(t.Union([t.String(), t.Null()])),
      clientMeta: t.Optional(t.Object({}, { additionalProperties: true })),
    }),
  },
);
