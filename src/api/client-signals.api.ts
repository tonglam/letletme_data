import { Elysia, t } from 'elysia';

import { apiKeyFailureHttpResponse, verifyRequestApiKey } from './auth.guard';
import {
  ClientSignalValidationError,
  ingestClientSignalBatch,
} from '../services/client-signals.service';
import { logError } from '../utils/logger';

export const clientSignalsAPI = new Elysia({ prefix: '/internal/ops' }).post(
  '/client-signals',
  async ({ body, request, set }) => {
    const verification = await verifyRequestApiKey(request);
    if (verification.status !== 'ok') {
      const failure = apiKeyFailureHttpResponse(verification.status);
      set.status = failure.httpStatus;
      return { accepted: false, error: failure.error };
    }

    try {
      const result = await ingestClientSignalBatch(body);
      set.status = 202;
      return { accepted: true, duplicate: result.duplicate };
    } catch (error) {
      if (error instanceof ClientSignalValidationError) {
        set.status = 422;
        return { accepted: false, error: error.message };
      }
      logError('Client signal ingestion failed', error);
      set.status = 503;
      return { accepted: false, error: 'Client signal ingestion unavailable' };
    }
  },
  {
    body: t.Any(),
  },
);
