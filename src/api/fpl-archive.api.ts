import { Elysia, t } from 'elysia';

import { enqueueFplSeasonArchiveJob } from '../jobs/data-sync-enqueue';
import { fplHistoryRepository } from '../repositories/fpl-history';
import { getFplArchiveStatus } from '../services/fpl-history.service';

const SeasonParams = t.Object({ season: t.String({ pattern: '^\\d{4}$' }) });

export const fplArchiveAPI = new Elysia({ prefix: '/fpl/archive' })
  .post(
    '/:season',
    async ({ params, set }) => {
      const archive = await fplHistoryRepository.markPending(params.season);
      if (archive.status === 'unavailable') {
        set.status = 409;
        return { success: false, season: params.season, archive };
      }
      if (archive.status === 'sealed') {
        return { success: true, season: params.season, noOp: true, archive };
      }
      const job = await enqueueFplSeasonArchiveJob(params.season, 'api');
      set.status = 202;
      return { success: true, season: params.season, jobId: job.id, archive };
    },
    { params: SeasonParams },
  )
  .get(
    '/status/:season',
    async ({ params }) => ({ success: true, ...(await getFplArchiveStatus(params.season)) }),
    { params: SeasonParams },
  );
