import { Elysia, t } from 'elysia';

import { getPriceChangePredictions } from '../services/price-change-predictions.service';

export const priceChangePredictionsAPI = new Elysia({
  prefix: '/internal/price-change-predictions',
}).post(
  '/resolve',
  async () => {
    const data = await getPriceChangePredictions();
    return { success: true, data };
  },
  {
    body: t.Object({}),
  },
);
