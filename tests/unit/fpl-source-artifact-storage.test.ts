import { describe, expect, mock, test } from 'bun:test';

import {
  createFplSourceArtifactStorage,
  FplSourceArtifactStorageError,
  type FplSourceArtifactStorageFetch,
} from '../../src/services/fpl-source-artifact-storage.service';

const config = {
  supabaseUrl: 'https://example.supabase.co',
  secretKey: 'test-secret',
  bucket: 'fpl-raw-snapshots',
};
const digest = 'a'.repeat(64);
const objectKey = `fpl/bootstrap-static/2627/20260825/${digest}.json`;

function bucketResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    id: config.bucket,
    name: config.bucket,
    public: false,
    file_size_limit: 8 * 1_024 * 1_024,
    allowed_mime_types: ['application/json'],
    ...overrides,
  });
}

describe('FPL raw source artifact Storage client', () => {
  test('provisions and verifies the exact private bucket contract', async () => {
    const methods: string[] = [];
    const fetchImpl = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      if (init?.method === 'PUT') {
        expect(JSON.parse(String(init.body))).toEqual({
          public: false,
          file_size_limit: 8 * 1_024 * 1_024,
          allowed_mime_types: ['application/json'],
        });
        return new Response(null, { status: 200 });
      }
      return bucketResponse();
    }) as FplSourceArtifactStorageFetch;

    const bucket = await createFplSourceArtifactStorage(config, fetchImpl).ensureBucket();

    expect(bucket.public).toBe(false);
    expect(methods).toEqual(['GET', 'PUT', 'GET']);
  });

  test('uploads without upsert and treats only an explicit duplicate as existing', async () => {
    const requests: RequestInit[] = [];
    const createdFetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(null, { status: 200 });
    }) as FplSourceArtifactStorageFetch;
    const bytes = new TextEncoder().encode('{"ok":true}');

    await expect(
      createFplSourceArtifactStorage(config, createdFetch).uploadImmutable(objectKey, bytes),
    ).resolves.toBe('created');
    const headers = new Headers(requests[0]?.headers);
    expect(headers.get('x-upsert')).toBe('false');
    expect(headers.get('content-type')).toBe('application/json');

    const duplicateFetch = mock(async () =>
      Response.json({ message: 'The resource already exists' }, { status: 400 }),
    ) as FplSourceArtifactStorageFetch;
    await expect(
      createFplSourceArtifactStorage(config, duplicateFetch).uploadImmutable(objectKey, bytes),
    ).resolves.toBe('exists');

    const ambiguousFetch = mock(async () =>
      Response.json({ message: 'bad request' }, { status: 400 }),
    ) as FplSourceArtifactStorageFetch;
    await expect(
      createFplSourceArtifactStorage(config, ambiguousFetch).uploadImmutable(objectKey, bytes),
    ).rejects.toMatchObject({ failureClass: 'STORAGE_UPLOAD', status: 400 });
  });

  test('returns actual object metadata for hash, size, and MIME verification', async () => {
    const raw = '{"events":[]}';
    const fetchImpl = mock(
      async () =>
        new Response(raw, {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(new TextEncoder().encode(raw).byteLength),
          },
        }),
    ) as FplSourceArtifactStorageFetch;

    const object = await createFplSourceArtifactStorage(config, fetchImpl).download(objectKey);

    expect(new TextDecoder().decode(object.bytes)).toBe(raw);
    expect(object.contentType).toBe('application/json; charset=utf-8');
    expect(object.declaredByteSize).toBe(object.bytes.byteLength);
  });

  test('rejects a public or incorrectly configured bucket', async () => {
    let lookup = 0;
    const fetchImpl = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PUT') return new Response(null, { status: 200 });
      lookup += 1;
      return lookup === 1 ? bucketResponse() : bucketResponse({ public: true });
    }) as FplSourceArtifactStorageFetch;

    await expect(
      createFplSourceArtifactStorage(config, fetchImpl).ensureBucket(),
    ).rejects.toBeInstanceOf(FplSourceArtifactStorageError);
  });

  test('rejects arbitrary object keys before making a storage request', async () => {
    const fetchImpl = mock(async () => new Response(null, { status: 200 }));

    await expect(
      createFplSourceArtifactStorage(config, fetchImpl).download('../secret'),
    ).rejects.toMatchObject({ failureClass: 'STORAGE_OBJECT_KEY_INVALID' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
