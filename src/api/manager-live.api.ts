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
      requestedCalculationMode: t.Optional(
        t.Union([t.Literal('OFFICIAL_CURRENT_MULTIPLIERS'), t.Literal('PROJECTED_AUTOSUBS')]),
      ),
      includeEffectiveLineup: t.Optional(t.Boolean()),
      liveRef: t.Optional(
        t.Object({
          publicationId: t.String({ minLength: 1 }),
          revision: t.Union([t.String({ minLength: 1 }), positiveInteger]),
        }),
      ),
    }),
  },
);
