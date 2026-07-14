import { Elysia, t } from 'elysia';
import { syncEntryInfo } from '../services/entry-info.service';

export const entryInfoAPI = new Elysia({ prefix: '/entry-info' }).post(
  '/:entryId/sync',
  async ({ params }) => {
    const res = await syncEntryInfo(params.entryId);
    return { success: true, data: res };
  },
  {
    params: t.Object({ entryId: t.Numeric() }),
  },
);
