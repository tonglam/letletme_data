import { Elysia, t } from 'elysia';

import { seasonRepository } from '../repositories/seasons';
import {
  isPriceChangeHotSnapshotNewer,
  readPriceChangeHotSnapshot,
} from '../services/price-change-hot.service';
import { getPriceChangePredictions } from '../services/price-change-predictions.service';

export const priceChangePredictionsAPI = new Elysia({
  prefix: '/internal/price-change-predictions',
}).post(
  '/resolve',
  async () => {
    const durable = await getPriceChangePredictions();
    const season = await seasonRepository.findCurrent();
    const hot = await readPriceChangeHotSnapshot(season.seasonCode).catch(() => null);
    const data = isPriceChangeHotSnapshotNewer(hot, durable) ? hot.board : durable;
    return { success: true, data };
  },
  {
    body: t.Object({}),
  },
);
