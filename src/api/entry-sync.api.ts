import { Elysia, t } from 'elysia';

import {
  syncEntryAllBatch,
  syncEntryPicksBatch,
  syncEntryResultsBatch,
  syncEntryTransfersBatch,
} from '../services/entry-sync.service';

const entrySyncBodySchema = t.Object({
  entryIds: t.Array(t.Number(), { minItems: 1, maxItems: 100 }),
  eventId: t.Optional(t.Number()),
});

export const entrySyncAPI = new Elysia({ prefix: '/entry-sync' })
  .post('/picks', async ({ body }) => syncEntryPicksBatch(body.entryIds, body.eventId), {
    body: entrySyncBodySchema,
  })
  .post('/transfers', async ({ body }) => syncEntryTransfersBatch(body.entryIds, body.eventId), {
    body: entrySyncBodySchema,
  })
  .post('/results', async ({ body }) => syncEntryResultsBatch(body.entryIds, body.eventId), {
    body: entrySyncBodySchema,
  })
  .post('/all', async ({ body }) => syncEntryAllBatch(body.entryIds, body.eventId), {
    body: entrySyncBodySchema,
  });
