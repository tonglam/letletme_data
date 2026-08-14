import { Elysia, t } from 'elysia';

import {
  getPublicTrendsCatalog,
  updatePublicTrendsCatalog,
} from '../services/trends-catalog.service';

export const trendsAPI = new Elysia({ prefix: '/trends' })
  .get(
    '/public-catalog/:seasonCode',
    async ({ params }) => ({
      success: true,
      data: await getPublicTrendsCatalog(params.seasonCode),
    }),
    { params: t.Object({ seasonCode: t.String({ pattern: '^\\d{4}$' }) }) },
  )
  .put(
    '/public-catalog/:seasonCode/:tournamentId',
    async ({ params, body, set }) => {
      const result = await updatePublicTrendsCatalog(params.seasonCode, params.tournamentId, body);
      if (!result) {
        set.status = 404;
        return { success: false, error: 'Prepared tournament not found' };
      }
      return { success: true, data: result };
    },
    {
      params: t.Object({
        seasonCode: t.String({ pattern: '^\\d{4}$' }),
        tournamentId: t.Integer({ minimum: 1 }),
      }),
      body: t.Object({
        displayName: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
        sortOrder: t.Optional(t.Integer({ minimum: 0 })),
        enabled: t.Optional(t.Boolean()),
      }),
    },
  );
