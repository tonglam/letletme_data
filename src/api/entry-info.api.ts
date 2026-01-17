import { Elysia, t } from 'elysia';
import { syncEntryInfo } from '../services/entry-info.service';

export const entryInfoAPI = new Elysia({ prefix: '/entry-info' }).post(
  '/:entryId/sync',
  async ({ params }) => {
    const id = Number(params.entryId);
    const res = await syncEntryInfo(id);
    return { success: true, data: res };
  },
  {
    params: t.Object({ entryId: t.String() }),
  },
);
