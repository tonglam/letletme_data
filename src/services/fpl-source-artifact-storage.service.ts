import { randomUUID } from 'node:crypto';

const MAX_OBJECT_BYTES = 8 * 1_024 * 1_024;
const STORAGE_TIMEOUT_MS = 45_000;
const CONTENT_TYPE = 'application/json';

export type FplSourceArtifactStorageConfig = Readonly<{
  supabaseUrl: string;
  secretKey: string;
  bucket: string;
}>;

export type FplSourceArtifactStorageFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type FplSourceArtifactObject = Readonly<{
  bytes: Uint8Array;
  contentType: string;
  declaredByteSize: number | null;
}>;

export type FplSourceArtifactBucket = Readonly<{
  id?: string;
  name?: string;
  public?: boolean;
  file_size_limit?: number | string | null;
  allowed_mime_types?: readonly string[] | null;
}>;

export class FplSourceArtifactStorageError extends Error {
  readonly status: number | null;
  readonly failureClass: string;

  constructor(failureClass: string, message: string, status: number | null = null) {
    super(message);
    this.name = 'FplSourceArtifactStorageError';
    this.failureClass = failureClass;
    this.status = status;
  }
}

function baseUrl(config: FplSourceArtifactStorageConfig): string {
  const url = new URL(config.supabaseUrl);
  if (url.protocol !== 'https:') {
    throw new Error('FPL raw snapshot Supabase URL must use HTTPS');
  }
  return url.toString().replace(/\/$/, '');
}

function authHeaders(config: FplSourceArtifactStorageConfig): Headers {
  return new Headers({
    apikey: config.secretKey,
    authorization: `Bearer ${config.secretKey}`,
  });
}

function encodedObjectPath(bucket: string, objectKey: string): string {
  return [bucket, ...objectKey.split('/')].map(encodeURIComponent).join('/');
}

function assertObjectKey(objectKey: string): void {
  if (
    !/^fpl\/bootstrap-static\/[0-9]{4}\/[0-9]{8}\/[0-9a-f]{64}\.json$/.test(objectKey) &&
    !/^probes\/[0-9a-f-]{36}\.json$/.test(objectKey)
  ) {
    throw new FplSourceArtifactStorageError(
      'STORAGE_OBJECT_KEY_INVALID',
      'FPL raw snapshot object key is invalid',
    );
  }
}

async function fetchWithTimeout(
  fetchImpl: FplSourceArtifactStorageFetch,
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error('FPL raw snapshot Storage request timed out')),
    STORAGE_TIMEOUT_MS,
  );
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch {
    throw new FplSourceArtifactStorageError(
      controller.signal.aborted ? 'STORAGE_TIMEOUT_OR_ABORT' : 'STORAGE_NETWORK',
      'FPL raw snapshot Storage request failed',
    );
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', abort);
  }
}

async function readBoundedBody(
  response: Response,
  limit = MAX_OBJECT_BYTES,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const declaredHeader = response.headers.get('content-length');
  const declared = declaredHeader === null ? null : Number(declaredHeader);
  if (declared !== null && Number.isFinite(declared) && declared > limit) {
    throw new FplSourceArtifactStorageError(
      'STORAGE_OBJECT_TOO_LARGE',
      'FPL raw snapshot Storage object exceeds the byte limit',
      response.status,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();

  let rejectStopped: (error: FplSourceArtifactStorageError) => void = () => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  let stopping = false;
  const stop = (failureClass: string, message: string) => {
    if (stopping) return;
    stopping = true;
    void reader.cancel().catch(() => undefined);
    rejectStopped(new FplSourceArtifactStorageError(failureClass, message, response.status));
  };
  const timeout = setTimeout(
    () => stop('STORAGE_BODY_TIMEOUT', 'FPL raw snapshot Storage response body timed out'),
    STORAGE_TIMEOUT_MS,
  );
  const onAbort = () =>
    stop('STORAGE_BODY_ABORTED', 'FPL raw snapshot Storage response body aborted');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([stopped, reader.read()]);
      if (done) break;
      if (!value) continue;
      byteLength += value.byteLength;
      if (byteLength > limit) {
        void reader.cancel().catch(() => undefined);
        throw new FplSourceArtifactStorageError(
          'STORAGE_OBJECT_TOO_LARGE',
          'FPL raw snapshot Storage object exceeds the byte limit',
          response.status,
        );
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readErrorText(response: Response, signal?: AbortSignal): Promise<string> {
  const bytes = await readBoundedBody(response, 4_096, signal).catch(() => new Uint8Array());
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function providerMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const value = parsed.message ?? parsed.error ?? parsed.code;
    return typeof value === 'string' ? value : '';
  } catch {
    return body;
  }
}

function isDuplicateResponse(status: number, body: string): boolean {
  return (
    (status === 400 || status === 409) && /duplicate|already exists/i.test(providerMessage(body))
  );
}

function isMissingResponse(status: number, body: string): boolean {
  return (
    status === 404 ||
    (status === 400 && /not[ _-]?found|does not exist/i.test(providerMessage(body)))
  );
}

function assertBucket(bucket: FplSourceArtifactBucket, expectedName: string): void {
  if ((bucket.id ?? bucket.name) !== expectedName || bucket.public !== false) {
    throw new FplSourceArtifactStorageError(
      'STORAGE_BUCKET_CONTRACT',
      'FPL raw snapshot bucket identity or privacy does not match the contract',
    );
  }
  if (Number(bucket.file_size_limit) !== MAX_OBJECT_BYTES) {
    throw new FplSourceArtifactStorageError(
      'STORAGE_BUCKET_CONTRACT',
      'FPL raw snapshot bucket byte limit does not match the contract',
    );
  }
  if (
    !Array.isArray(bucket.allowed_mime_types) ||
    bucket.allowed_mime_types.length !== 1 ||
    bucket.allowed_mime_types[0] !== CONTENT_TYPE
  ) {
    throw new FplSourceArtifactStorageError(
      'STORAGE_BUCKET_CONTRACT',
      'FPL raw snapshot bucket MIME allowlist does not match the contract',
    );
  }
}

export interface FplSourceArtifactStorage {
  ensureBucket(): Promise<FplSourceArtifactBucket>;
  uploadImmutable(
    objectKey: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<'created' | 'exists'>;
  download(objectKey: string, signal?: AbortSignal): Promise<FplSourceArtifactObject>;
  remove(objectKey: string, signal?: AbortSignal): Promise<'deleted' | 'missing'>;
  provisionAndProbe(): Promise<void>;
}

export function createFplSourceArtifactStorage(
  config: FplSourceArtifactStorageConfig,
  fetchImpl: FplSourceArtifactStorageFetch = fetch,
): FplSourceArtifactStorage {
  const root = `${baseUrl(config)}/storage/v1`;
  const headers = authHeaders(config);

  const getBucket = async (): Promise<FplSourceArtifactBucket | null> => {
    const response = await fetchWithTimeout(
      fetchImpl,
      `${root}/bucket/${encodeURIComponent(config.bucket)}`,
      { method: 'GET', headers },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await readErrorText(response);
      if (isMissingResponse(response.status, body)) return null;
      throw new FplSourceArtifactStorageError(
        'STORAGE_BUCKET_LOOKUP',
        'FPL raw snapshot bucket lookup failed',
        response.status,
      );
    }
    const bytes = await readBoundedBody(response, 64 * 1_024);
    try {
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return parsed as FplSourceArtifactBucket;
    } catch {
      throw new FplSourceArtifactStorageError(
        'STORAGE_RESPONSE_INVALID',
        'FPL raw snapshot bucket response is invalid',
        response.status,
      );
    }
  };

  const writeBucket = async (method: 'POST' | 'PUT'): Promise<void> => {
    const requestHeaders = new Headers(headers);
    requestHeaders.set('content-type', CONTENT_TYPE);
    const response = await fetchWithTimeout(
      fetchImpl,
      method === 'POST' ? `${root}/bucket` : `${root}/bucket/${encodeURIComponent(config.bucket)}`,
      {
        method,
        headers: requestHeaders,
        body: JSON.stringify({
          ...(method === 'POST' ? { id: config.bucket, name: config.bucket } : {}),
          public: false,
          file_size_limit: MAX_OBJECT_BYTES,
          allowed_mime_types: [CONTENT_TYPE],
        }),
      },
    );
    if (!response.ok) {
      throw new FplSourceArtifactStorageError(
        'STORAGE_BUCKET_WRITE',
        'FPL raw snapshot bucket provisioning failed',
        response.status,
      );
    }
  };

  const storage: FplSourceArtifactStorage = {
    async ensureBucket() {
      const existing = await getBucket();
      await writeBucket(existing ? 'PUT' : 'POST');
      const verified = await getBucket();
      if (!verified) {
        throw new FplSourceArtifactStorageError(
          'STORAGE_BUCKET_MISSING',
          'FPL raw snapshot bucket disappeared after provisioning',
        );
      }
      assertBucket(verified, config.bucket);
      return verified;
    },

    async uploadImmutable(objectKey, bytes, signal) {
      assertObjectKey(objectKey);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_OBJECT_BYTES) {
        throw new FplSourceArtifactStorageError(
          'STORAGE_OBJECT_SIZE_INVALID',
          'FPL raw snapshot object size is invalid',
        );
      }
      const uploadHeaders = new Headers(headers);
      uploadHeaders.set('content-type', CONTENT_TYPE);
      uploadHeaders.set('cache-control', 'max-age=31536000, immutable');
      uploadHeaders.set('x-upsert', 'false');
      const response = await fetchWithTimeout(
        fetchImpl,
        `${root}/object/${encodedObjectPath(config.bucket, objectKey)}`,
        { method: 'POST', headers: uploadHeaders, body: bytes, signal },
      );
      if (response.ok) return 'created';
      const body = await readErrorText(response);
      if (isDuplicateResponse(response.status, body)) return 'exists';
      throw new FplSourceArtifactStorageError(
        'STORAGE_UPLOAD',
        'FPL raw snapshot immutable upload failed',
        response.status,
      );
    },

    async download(objectKey, signal) {
      assertObjectKey(objectKey);
      const response = await fetchWithTimeout(
        fetchImpl,
        `${root}/object/${encodedObjectPath(config.bucket, objectKey)}`,
        { method: 'GET', headers, signal },
      );
      if (!response.ok) {
        throw new FplSourceArtifactStorageError(
          isMissingResponse(response.status, await readErrorText(response, signal))
            ? 'STORAGE_OBJECT_MISSING'
            : 'STORAGE_DOWNLOAD',
          'FPL raw snapshot authenticated download failed',
          response.status,
        );
      }
      const declaredHeader = response.headers.get('content-length');
      const declared = declaredHeader === null ? null : Number(declaredHeader);
      return {
        bytes: await readBoundedBody(response, MAX_OBJECT_BYTES, signal),
        contentType: response.headers.get('content-type') ?? '',
        declaredByteSize:
          declared !== null && Number.isSafeInteger(declared) && declared >= 0 ? declared : null,
      };
    },

    async remove(objectKey, signal) {
      assertObjectKey(objectKey);
      const response = await fetchWithTimeout(
        fetchImpl,
        `${root}/object/${encodedObjectPath(config.bucket, objectKey)}`,
        { method: 'DELETE', headers, signal },
      );
      if (response.ok) return 'deleted';
      const body = await readErrorText(response, signal);
      if (isMissingResponse(response.status, body)) return 'missing';
      throw new FplSourceArtifactStorageError(
        'STORAGE_DELETE',
        'FPL raw snapshot object deletion failed',
        response.status,
      );
    },

    async provisionAndProbe() {
      await storage.ensureBucket();
      const objectKey = `probes/${randomUUID()}.json`;
      const bytes = new TextEncoder().encode('{"probe":"fpl-raw-snapshot"}');
      let primaryError: unknown;
      try {
        await storage.uploadImmutable(objectKey, bytes);
        const downloaded = await storage.download(objectKey);
        if (
          downloaded.contentType.split(';', 1)[0]?.trim().toLowerCase() !== CONTENT_TYPE ||
          downloaded.bytes.byteLength !== bytes.byteLength ||
          !downloaded.bytes.every((value, index) => value === bytes[index])
        ) {
          throw new FplSourceArtifactStorageError(
            'STORAGE_PROBE_MISMATCH',
            'FPL raw snapshot Storage probe roundtrip mismatch',
          );
        }
      } catch (error) {
        primaryError = error;
      }
      await storage.remove(objectKey).catch((error) => {
        if (!primaryError) primaryError = error;
      });
      if (primaryError) throw primaryError;
    },
  };

  return storage;
}

export const fplSourceArtifactStorageContract = {
  bucket: 'fpl-raw-snapshots',
  maxObjectBytes: MAX_OBJECT_BYTES,
  contentType: CONTENT_TYPE,
} as const;
