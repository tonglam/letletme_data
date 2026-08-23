import { Elysia, t } from 'elysia';

import { resolveManagerLiveScores } from '../services/manager-live.service';

const positiveInteger = t.Number({ minimum: 1, multipleOf: 1 });

export const managerLiveAPI = new Elysia({ prefix: '/internal/manager-live' }).post(
  '/resolve',
  async ({ body }) => {
    const data = await resolveManagerLiveScores(body);
    return { success: true, data };
  },
  {
    body: t.Object({
      eventId: positiveInteger,
      entryIds: t.Array(positiveInteger, { minItems: 1, maxItems: 500 }),
      tournamentId: t.Optional(positiveInteger),
      readMode: t.Optional(t.Union([t.Literal('CACHE_ONLY'), t.Literal('READ_THROUGH')])),
    }),
  },
);
