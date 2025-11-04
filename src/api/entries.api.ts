import { Elysia, t } from 'elysia';
import { getEntryInfo, syncEntryInfo } from '../services/entries.service';

export const entriesAPI = new Elysia({ prefix: '/entries' })
  .get(
    '/:entryId/info',
    async ({ params }) => {
      const id = Number(params.entryId);
      const info = await getEntryInfo(id);
      return { success: true, data: info };
    },
    {
      params: t.Object({ entryId: t.String() }),
    },
  )
  .post(
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

