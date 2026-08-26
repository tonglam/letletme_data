import { Elysia, t } from 'elysia';

import { apiKeyFailureHttpResponse, verifyRequestApiKey } from './auth.guard';
import {
  CLIENT_SIGNAL_MAX_BYTES,
  ClientSignalValidationError,
  ingestClientSignalBatch,
} from '../services/client-signals.service';
import { logError } from '../utils/logger';

type ClientSignalBodyProblem = {
  status: 413 | 422;
  message: 'payload exceeds 16 KiB' | 'invalid JSON body';
};

const bodyProblems = new WeakMap<Request, ClientSignalBodyProblem>();

function declaredBodyBytes(request: Request): number | null {
  const value = request.headers.get('content-length');
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number.POSITIVE_INFINITY;
}

async function parseJsonBodyWithLimit(request: Request): Promise<unknown | undefined> {
  const declared = declaredBodyBytes(request);
  if (declared !== null && declared > CLIENT_SIGNAL_MAX_BYTES) {
    bodyProblems.set(request, { status: 413, message: 'payload exceeds 16 KiB' });
    return null;
  }

  const stream = request.body;
  if (!stream) {
    bodyProblems.set(request, { status: 422, message: 'invalid JSON body' });
    return null;
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!part.value) continue;
      byteLength += part.value.byteLength;
      if (byteLength > CLIENT_SIGNAL_MAX_BYTES) {
        await reader.cancel();
        bodyProblems.set(request, { status: 413, message: 'payload exceeds 16 KiB' });
        return null;
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(raw) as unknown;
  } catch {
    bodyProblems.set(request, { status: 422, message: 'invalid JSON body' });
    return null;
  }
}

export const clientSignalsAPI = new Elysia({ prefix: '/internal/ops' })
  .onParse(async ({ request, contentType }) => {
    // Returning undefined delegates to Elysia's default parser, which would
    // buffer an unsupported body before the handler can enforce the 16 KiB
    // transport budget. Claim every content type here and fail closed.
    if (contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      bodyProblems.set(request, { status: 422, message: 'invalid JSON body' });
      return null;
    }
    return parseJsonBodyWithLimit(request);
  })
  .post(
    '/client-signals',
    async ({ body, request, set }) => {
      const bodyProblem = bodyProblems.get(request);
      bodyProblems.delete(request);
      if (bodyProblem) {
        set.status = bodyProblem.status;
        return { accepted: false, error: bodyProblem.message };
      }

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
