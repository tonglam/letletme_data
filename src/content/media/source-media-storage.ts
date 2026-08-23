import { createHash, randomUUID } from 'node:crypto';

import { Upload } from 'tus-js-client';

const BUCKET_FILE_SIZE_LIMIT = 24 * 1_024 * 1_024;
const STANDARD_UPLOAD_LIMIT = 6 * 1_024 * 1_024;
const TUS_CHUNK_SIZE = 6 * 1_024 * 1_024;
const STORAGE_TIMEOUT_MS = 60_000;
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

export type SourceMediaStorageConfig = Readonly<{
  supabaseUrl: string;
  secretKey: string;
  bucket: string;
}>;

export type SourceMediaStorageFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type SourceMediaTusUpload = (
  input: Readonly<{
    endpoint: string;
    bytes: Uint8Array;
    headers: Readonly<Record<string, string>>;
    metadata: Readonly<Record<string, string>>;
    chunkSize: number;
    signal?: AbortSignal;
  }>,
) => Promise<void>;

export type SourceMediaBucket = Readonly<{
  id?: string;
  name?: string;
  public?: boolean;
  file_size_limit?: number | string | null;
  allowed_mime_types?: readonly string[] | null;
}>;

type ProviderErrorDetail = Readonly<{
  providerCode: string | null;
  providerDetail: string | null;
}>;

type TusResponseLike = Readonly<{
  getStatus?: () => number;
  getBody?: () => string;
}>;

type TusErrorLike = Readonly<{
  originalResponse?: TusResponseLike | null;
  causingError?: unknown;
  message?: unknown;
}>;

export class SourceMediaStorageError extends Error {
  readonly failureClass: string;
  readonly status: number | null;

  constructor(failureClass: string, message: string, status: number | null = null) {
    super(message);
    this.name = 'SourceMediaStorageError';
    this.failureClass = failureClass;
    this.status = status;
  }
}

function baseUrl(config: SourceMediaStorageConfig): string {
  const url = new URL(config.supabaseUrl);
  if (url.protocol !== 'https:') throw new Error('Source-media Supabase URL must use HTTPS');
  return url.toString().replace(/\/$/, '');
}

function directStorageOrigin(config: SourceMediaStorageConfig): string {
  const url = new URL(baseUrl(config));
  if (url.hostname.endsWith('.storage.supabase.co')) return url.origin;
  if (!url.hostname.endsWith('.supabase.co')) {
    throw new Error('TUS requires a Supabase project URL with a direct storage hostname');
  }
  url.hostname = url.hostname.replace(/\.supabase\.co$/, '.storage.supabase.co');
  return url.origin;
}

function encodedObjectPath(bucket: string, objectKey: string): string {
  return [bucket, ...objectKey.split('/')].map(encodeURIComponent).join('/');
}

function authHeaders(config: SourceMediaStorageConfig): Headers {
  return new Headers({
    apikey: config.secretKey,
    authorization: `Bearer ${config.secretKey}`,
  });
}

async function boundedBody(
  response: Response,
  signal?: AbortSignal,
  limit = BUCKET_FILE_SIZE_LIMIT,
): Promise<Uint8Array> {
  if (signal?.aborted) {
    throw new SourceMediaStorageError('STORAGE_ABORTED', 'Storage body download was aborted');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw new SourceMediaStorageError('STORAGE_BODY_TOO_LARGE', 'Storage body exceeds limit');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  let aborted = false;
  const cancel = (): void => {
    aborted = true;
    void reader.cancel('source-media Storage download aborted');
  };
  const timeout = setTimeout(cancel, STORAGE_TIMEOUT_MS);
  signal?.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > limit) {
        await reader.cancel('body limit exceeded').catch(() => undefined);
        throw new SourceMediaStorageError('STORAGE_BODY_TOO_LARGE', 'Storage body exceeds limit');
      }
      chunks.push(chunk.value);
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
  if (aborted) {
    throw new SourceMediaStorageError(
      signal?.aborted ? 'STORAGE_ABORTED' : 'STORAGE_TIMEOUT',
      'Storage body download was aborted',
    );
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function storageFetch(
  fetchImpl: SourceMediaStorageFetch,
  url: string,
  init: RequestInit,
  timeoutMs = STORAGE_TIMEOUT_MS,
): Promise<Response> {
  if (init.signal?.aborted) {
    throw new SourceMediaStorageError('STORAGE_ABORTED', 'Storage request was aborted');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = (): void => controller.abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw new SourceMediaStorageError(
      init.signal?.aborted
        ? 'STORAGE_ABORTED'
        : controller.signal.aborted
          ? 'STORAGE_TIMEOUT'
          : 'STORAGE_TRANSPORT',
      error instanceof Error ? error.message : 'Storage request failed',
    );
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', abort);
  }
}

function parseProviderErrorDetail(rawBody: string): ProviderErrorDetail {
  let providerCode: string | null = null;
  let providerDetail: string | null = null;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const providerPayload = parsed as { code?: unknown; error?: unknown; message?: unknown };
      const candidate = providerPayload.error ?? providerPayload.code;
      if (typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(candidate)) {
        providerCode = candidate;
      }
      const detail = providerPayload.message ?? providerPayload.error ?? providerPayload.code;
      if (
        typeof detail === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9 ._:/'()\-]{0,119}$/.test(detail.trim())
      ) {
        providerDetail = detail.trim();
      }
    }
  } catch {
    // Some Storage gateways return plain text. Keep the error bounded and generic.
  }
  return { providerCode, providerDetail };
}

function tusFailureDetail(
  error: unknown,
): Readonly<{ status: number | null; detail: string | null }> {
  if (!error || typeof error !== 'object') return { status: null, detail: null };
  const errorLike = error as TusErrorLike;
  const response = errorLike.originalResponse;
  let detail: string | null = null;
  const safeDetail = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const normalized = value
      .replace(/https?:\/\/[^\s,)]+/gi, 'url')
      .replace(/, originated from request.*$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    return /^[A-Za-z0-9][A-Za-z0-9 ._:/'()\-]{0,119}$/.test(normalized) ? normalized : null;
  };
  if (!response) {
    const cause = errorLike.causingError;
    if (cause && typeof cause === 'object') {
      const causeLike = cause as { code?: unknown; name?: unknown; message?: unknown };
      detail =
        safeDetail(causeLike.code) ?? safeDetail(causeLike.message) ?? safeDetail(causeLike.name);
    }
    return {
      status: null,
      detail: detail ?? safeDetail(errorLike.message),
    };
  }
  const status = typeof response.getStatus === 'function' ? response.getStatus() : null;
  const rawBody = typeof response.getBody === 'function' ? response.getBody().slice(0, 1_024) : '';
  const { providerCode, providerDetail } = parseProviderErrorDetail(rawBody);
  return { status, detail: providerCode ?? providerDetail };
}

function isMissingObjectCode(providerCode: string | null): boolean {
  return providerCode === 'not_found' || providerCode?.toLowerCase() === 'nosuchkey';
}

function isMissingObjectError(error: unknown): boolean {
  if (!(error instanceof SourceMediaStorageError)) return false;
  return error.status === 404 || /\((?:not_found|nosuchkey)\)$/i.test(error.message);
}

async function waitForProbeCleanup(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function storageError(
  response: Response,
  operation: string,
  bodyBytes?: Uint8Array,
): Promise<SourceMediaStorageError> {
  const errorBytes =
    bodyBytes ?? (await boundedBody(response, undefined, 1_024).catch(() => new Uint8Array()));
  const rawBody = new TextDecoder('utf-8', { fatal: false }).decode(errorBytes);
  const body = rawBody.toLowerCase();
  const { providerCode, providerDetail } = parseProviderErrorDetail(rawBody);
  const alreadyExists =
    response.status === 409 ||
    (response.status === 400 && /already exists|duplicate|resource exists/.test(body));
  return new SourceMediaStorageError(
    alreadyExists ? 'STORAGE_OBJECT_EXISTS' : 'STORAGE_REQUEST_FAILED',
    `${operation} failed with ${response.status}${providerCode ? ` (${providerCode})` : providerDetail ? ` (${providerDetail})` : ''}`,
    response.status,
  );
}

function assertBucket(bucket: SourceMediaBucket, expectedName: string): void {
  const limit = Number(bucket.file_size_limit);
  const mimeTypes = [...(bucket.allowed_mime_types ?? [])].sort();
  if (bucket.name !== expectedName && bucket.id !== expectedName) {
    throw new SourceMediaStorageError('STORAGE_BUCKET_MISMATCH', 'Storage returned wrong bucket');
  }
  if (bucket.public !== false) {
    throw new SourceMediaStorageError(
      'STORAGE_BUCKET_PUBLIC',
      'Source-media bucket must be private',
    );
  }
  if (limit !== BUCKET_FILE_SIZE_LIMIT) {
    throw new SourceMediaStorageError(
      'STORAGE_BUCKET_LIMIT',
      'Source-media bucket must allow exactly 24 MiB',
    );
  }
  if (JSON.stringify(mimeTypes) !== JSON.stringify([...ALLOWED_MIME_TYPES].sort())) {
    throw new SourceMediaStorageError(
      'STORAGE_BUCKET_MIME',
      'Source-media bucket MIME restrictions do not match',
    );
  }
}

const uploadWithTusClient: SourceMediaTusUpload = (input) =>
  new Promise<void>((resolve, reject) => {
    const upload = new Upload(Buffer.from(input.bytes), {
      endpoint: input.endpoint,
      retryDelays: [0, 3_000, 5_000, 10_000, 20_000],
      headers: { ...input.headers },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      storeFingerprintForResuming: false,
      chunkSize: input.chunkSize,
      metadata: { ...input.metadata },
      onError: (error) => {
        input.signal?.removeEventListener('abort', onAbort);
        const { status, detail } = tusFailureDetail(error);
        const statusText = status === null ? '' : ` with ${status}`;
        const detailText = detail ? ` (${detail})` : '';
        reject(
          new SourceMediaStorageError(
            status === 409 || /409|already exists/i.test(error.message)
              ? 'STORAGE_OBJECT_EXISTS'
              : 'STORAGE_TUS_FAILED',
            `Resumable Storage upload failed${statusText}${detailText}`,
            status,
          ),
        );
      },
      onSuccess: () => {
        input.signal?.removeEventListener('abort', onAbort);
        resolve();
      },
    });
    const onAbort = (): void => {
      void upload.abort(true).finally(() => {
        reject(new SourceMediaStorageError('STORAGE_ABORTED', 'Storage upload aborted'));
      });
    };
    if (input.signal?.aborted) {
      onAbort();
      return;
    }
    input.signal?.addEventListener('abort', onAbort, { once: true });
    upload.start();
  });

export interface SourceMediaStorage {
  ensureBucket(): Promise<SourceMediaBucket>;
  upload(
    objectKey: string,
    bytes: Uint8Array,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<void>;
  download(objectKey: string, signal?: AbortSignal): Promise<Uint8Array>;
  remove(objectKey: string, signal?: AbortSignal): Promise<'deleted' | 'missing'>;
  provisionAndProbe(): Promise<void>;
}

export function createSourceMediaStorage(
  config: SourceMediaStorageConfig,
  fetchImpl: SourceMediaStorageFetch = fetch,
  tusUploadImpl: SourceMediaTusUpload = uploadWithTusClient,
): SourceMediaStorage {
  const root = `${baseUrl(config)}/storage/v1`;
  const headers = authHeaders(config);

  const getBucket = async (): Promise<SourceMediaBucket | null> => {
    const response = await storageFetch(
      fetchImpl,
      `${root}/bucket/${encodeURIComponent(config.bucket)}`,
      { method: 'GET', headers },
    );
    if (response.status === 404) return null;
    if (response.status === 400) {
      const bodyBytes = await boundedBody(response, undefined, 1_024).catch(() => new Uint8Array());
      const body = new TextDecoder('utf-8', { fatal: false }).decode(bodyBytes).toLowerCase();
      if (/bucket[\s_-]+not[\s_-]+found/.test(body)) return null;
      throw await storageError(response, 'bucket lookup', bodyBytes);
    }
    if (!response.ok) throw await storageError(response, 'bucket lookup');
    const responseBytes = await boundedBody(response, undefined, 64 * 1_024);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(responseBytes));
    } catch {
      throw new SourceMediaStorageError('STORAGE_RESPONSE_INVALID', 'Bucket response is invalid');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new SourceMediaStorageError('STORAGE_RESPONSE_INVALID', 'Bucket response is invalid');
    }
    return body as SourceMediaBucket;
  };

  const writeBucket = async (method: 'POST' | 'PUT'): Promise<void> => {
    const requestHeaders = new Headers(headers);
    requestHeaders.set('content-type', 'application/json');
    const path =
      method === 'POST' ? `${root}/bucket` : `${root}/bucket/${encodeURIComponent(config.bucket)}`;
    const bucketBody = {
      public: false,
      file_size_limit: BUCKET_FILE_SIZE_LIMIT,
      allowed_mime_types: ALLOWED_MIME_TYPES,
      ...(method === 'POST' ? { id: config.bucket, name: config.bucket } : {}),
    };
    const response = await storageFetch(fetchImpl, path, {
      method,
      headers: requestHeaders,
      body: JSON.stringify(bucketBody),
    });
    if (!response.ok) throw await storageError(response, `${method} bucket`);
  };

  const uploadStandard = async (
    objectKey: string,
    bytes: Uint8Array,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    const uploadHeaders = new Headers(headers);
    uploadHeaders.set('content-type', contentType);
    uploadHeaders.set('cache-control', 'max-age=31536000');
    uploadHeaders.set('x-upsert', 'false');
    const response = await storageFetch(
      fetchImpl,
      `${root}/object/${encodedObjectPath(config.bucket, objectKey)}`,
      { method: 'POST', headers: uploadHeaders, body: bytes, signal },
    );
    if (!response.ok) throw await storageError(response, 'standard upload');
  };

  const uploadTus = (
    objectKey: string,
    bytes: Uint8Array,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<void> =>
    tusUploadImpl({
      endpoint: `${directStorageOrigin(config)}/storage/v1/upload/resumable`,
      bytes,
      headers: {
        apikey: config.secretKey,
        authorization: `Bearer ${config.secretKey}`,
        'x-upsert': 'false',
      },
      metadata: {
        bucketName: config.bucket,
        objectName: objectKey,
        contentType,
        cacheControl: '31536000',
      },
      chunkSize: TUS_CHUNK_SIZE,
      signal,
    });

  const storage: SourceMediaStorage = {
    async ensureBucket() {
      const current = await getBucket();
      await writeBucket(current ? 'PUT' : 'POST');
      const verified = await getBucket();
      if (!verified) {
        throw new SourceMediaStorageError(
          'STORAGE_BUCKET_MISSING',
          'Bucket disappeared after write',
        );
      }
      assertBucket(verified, config.bucket);
      return verified;
    },

    async upload(objectKey, bytes, contentType, signal) {
      if (bytes.byteLength > BUCKET_FILE_SIZE_LIMIT) {
        throw new SourceMediaStorageError(
          'STORAGE_OBJECT_TOO_LARGE',
          'Object exceeds bucket limit',
        );
      }
      if (!ALLOWED_MIME_TYPES.includes(contentType as (typeof ALLOWED_MIME_TYPES)[number])) {
        throw new SourceMediaStorageError('STORAGE_MIME_FORBIDDEN', 'Object MIME is not allowed');
      }
      if (bytes.byteLength <= STANDARD_UPLOAD_LIMIT) {
        await uploadStandard(objectKey, bytes, contentType, signal);
      } else {
        await uploadTus(objectKey, bytes, contentType, signal);
      }
    },

    async download(objectKey, signal) {
      const response = await storageFetch(
        fetchImpl,
        `${root}/object/${encodedObjectPath(config.bucket, objectKey)}`,
        { method: 'GET', headers, signal },
      );
      if (!response.ok) throw await storageError(response, 'authenticated download');
      return boundedBody(response, signal);
    },

    async remove(objectKey, signal) {
      const response = await storageFetch(
        fetchImpl,
        `${root}/object/${encodedObjectPath(config.bucket, objectKey)}`,
        { method: 'DELETE', headers, signal },
      );
      if (response.status === 404) return 'missing';
      if (response.status === 400) {
        const bodyBytes = await boundedBody(response, signal, 1_024).catch(() => new Uint8Array());
        const rawBody = new TextDecoder('utf-8', { fatal: false }).decode(bodyBytes);
        const body = rawBody.toLowerCase();
        const { providerCode } = parseProviderErrorDetail(rawBody);
        if (isMissingObjectCode(providerCode) && !/bucket[\s_-]+not[\s_-]+found/.test(body)) {
          return 'missing';
        }
        throw await storageError(response, 'object delete', bodyBytes);
      }
      if (!response.ok) throw await storageError(response, 'object delete');
      return 'deleted';
    },

    async provisionAndProbe() {
      await storage.ensureBucket();
      const objectKey = `probes/${randomUUID()}.png`;
      const pngPrefix = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      );
      // A tiny probe cannot prove the project-wide file limit. Exercise the
      // exact 24 MiB ceiling and the TUS path with a valid PNG plus inert
      // trailing bytes, then verify the private roundtrip by content hash.
      const bytes = new Uint8Array(BUCKET_FILE_SIZE_LIMIT);
      bytes.set(pngPrefix);
      let primaryError: unknown = null;
      try {
        await storage.upload(objectKey, bytes, 'image/png');
        const downloaded = await storage.download(objectKey);
        const expected = createHash('sha256').update(bytes).digest('hex');
        const actual = createHash('sha256').update(downloaded).digest('hex');
        if (actual !== expected) {
          throw new SourceMediaStorageError('STORAGE_PROBE_HASH', 'Storage probe hash mismatch');
        }
      } catch (error) {
        primaryError = error;
      }
      let cleanupError: unknown = null;
      for (const delayMs of [0, 1_000, 3_000]) {
        if (delayMs > 0) await waitForProbeCleanup(delayMs);
        try {
          await storage.remove(objectKey);
          try {
            await storage.download(objectKey);
            cleanupError = new SourceMediaStorageError(
              'STORAGE_PROBE_CLEANUP',
              'Storage probe object remains readable after deletion',
            );
          } catch (error) {
            if (isMissingObjectError(error)) {
              cleanupError = null;
              break;
            }
            cleanupError = error;
          }
        } catch (error) {
          cleanupError = error;
        }
      }
      if (cleanupError !== null && primaryError === null) {
        throw new SourceMediaStorageError(
          'STORAGE_PROBE_CLEANUP',
          'Storage probe cleanup could not prove the object was removed',
          cleanupError instanceof SourceMediaStorageError ? cleanupError.status : null,
        );
      }
      if (primaryError !== null) {
        throw primaryError;
      }
    },
  };
  return storage;
}

export const sourceMediaStorageContract = {
  bucketFileSizeLimit: BUCKET_FILE_SIZE_LIMIT,
  standardUploadLimit: STANDARD_UPLOAD_LIMIT,
  tusChunkSize: TUS_CHUNK_SIZE,
  allowedMimeTypes: ALLOWED_MIME_TYPES,
} as const;
