import { describe, expect, test } from 'bun:test';

import {
  createSourceMediaStorage,
  sourceMediaStorageContract,
} from '../../../src/content/media/source-media-storage';

const config = {
  supabaseUrl: 'https://project.supabase.co',
  secretKey: 'test-secret',
  bucket: 'briefing-source-media',
};

describe('source-media private Storage client', () => {
  test('provisions exact bucket restrictions and removes its roundtrip probe', async () => {
    let bucket: Record<string, unknown> | null = null;
    const objects = new Map<string, Uint8Array>();
    let sawNoUpsert = false;
    const probeSizes: number[] = [];
    const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === '/storage/v1/bucket/briefing-source-media' && init.method === 'GET') {
        return bucket
          ? Response.json(bucket)
          : Response.json({ message: 'not found' }, { status: 404 });
      }
      if (url.pathname === '/storage/v1/bucket' && init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bucket = {
          id: body.id,
          name: body.name,
          public: body.public,
          file_size_limit: body.file_size_limit,
          allowed_mime_types: body.allowed_mime_types,
        };
        return Response.json({ name: body.name });
      }
      if (url.pathname === '/storage/v1/bucket/briefing-source-media' && init.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bucket = {
          id: bucket?.id,
          name: bucket?.name,
          public: body.public,
          file_size_limit: body.file_size_limit,
          allowed_mime_types: body.allowed_mime_types,
        };
        return Response.json({ message: 'updated' });
      }
      const prefix = '/storage/v1/object/briefing-source-media/';
      if (url.pathname.startsWith(prefix)) {
        const key = decodeURIComponent(url.pathname.slice(prefix.length));
        if (init.method === 'POST') {
          sawNoUpsert = new Headers(init.headers).get('x-upsert') === 'false';
          const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
          if (objects.has(key))
            return Response.json({ message: 'already exists' }, { status: 400 });
          objects.set(key, bytes);
          return Response.json({ Key: `${config.bucket}/${key}` });
        }
        if (init.method === 'DELETE') {
          if (!objects.delete(key)) return Response.json({ message: 'not found' }, { status: 404 });
          return Response.json({ message: 'deleted' });
        }
        if (init.method === 'GET') {
          const bytes = objects.get(key);
          return bytes
            ? new Response(bytes)
            : Response.json({ message: 'not found' }, { status: 404 });
        }
      }
      return Response.json({ message: 'unexpected request' }, { status: 500 });
    };

    const storage = createSourceMediaStorage(config, fetchImpl, async (input) => {
      sawNoUpsert = input.headers['x-upsert'] === 'false';
      probeSizes.push(input.bytes.byteLength);
      objects.set(input.metadata.objectName, input.bytes);
    });
    await storage.provisionAndProbe();
    await storage.provisionAndProbe();
    expect(bucket as Record<string, unknown> | null).toEqual({
      id: config.bucket,
      name: config.bucket,
      public: false,
      file_size_limit: 25_165_824,
      allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    });
    expect(sawNoUpsert).toBeTrue();
    expect(probeSizes).toEqual([
      sourceMediaStorageContract.bucketFileSizeLimit,
      sourceMediaStorageContract.bucketFileSizeLimit,
    ]);
    expect(objects.size).toBe(0);
  });

  test('locks the 6 MiB standard/TUS boundary and 24 MiB bucket cap', () => {
    expect(sourceMediaStorageContract.standardUploadLimit).toBe(6 * 1_024 * 1_024);
    expect(sourceMediaStorageContract.tusChunkSize).toBe(6 * 1_024 * 1_024);
    expect(sourceMediaStorageContract.bucketFileSizeLimit).toBe(24 * 1_024 * 1_024);
  });

  test('routes objects above 6 MiB through direct-host TUS without upsert', async () => {
    let captured:
      | Parameters<NonNullable<Parameters<typeof createSourceMediaStorage>[2]>>[0]
      | null = null;
    const storage = createSourceMediaStorage(
      config,
      async () => {
        throw new Error('standard Storage fetch must not run for a large object');
      },
      async (input) => {
        captured = input;
      },
    );
    await storage.upload(
      'x/images/sha256/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
      new Uint8Array(sourceMediaStorageContract.standardUploadLimit + 1),
      'image/png',
    );
    expect(captured).toMatchObject({
      endpoint: 'https://project.storage.supabase.co/storage/v1/upload/resumable',
      chunkSize: 6 * 1_024 * 1_024,
      headers: { 'x-upsert': 'false' },
      metadata: {
        bucketName: 'briefing-source-media',
        contentType: 'image/png',
      },
    });
  });

  test('does not start a Storage request after graceful shutdown aborts it', async () => {
    let fetchCalls = 0;
    const storage = createSourceMediaStorage(config, async () => {
      fetchCalls += 1;
      return new Response();
    });
    const controller = new AbortController();
    controller.abort('media-worker shutdown');
    await expect(
      storage.download('x/images/already-aborted.png', controller.signal),
    ).rejects.toMatchObject({
      failureClass: 'STORAGE_ABORTED',
    });
    expect(fetchCalls).toBe(0);
  });

  test('retains a bounded provider error code for Storage diagnostics', async () => {
    const storage = createSourceMediaStorage(config, async () =>
      Response.json(
        { statusCode: '400', error: 'InvalidRequest', message: 'Bucket request invalid' },
        { status: 400 },
      ),
    );

    await expect(storage.ensureBucket()).rejects.toMatchObject({
      failureClass: 'STORAGE_REQUEST_FAILED',
      status: 400,
      message: 'bucket lookup failed with 400 (InvalidRequest)',
    });
  });

  test('retains a bounded provider message when the error is not a code', async () => {
    const storage = createSourceMediaStorage(config, async () =>
      Response.json({ error: 'Bucket name invalid' }, { status: 400 }),
    );

    await expect(storage.ensureBucket()).rejects.toMatchObject({
      failureClass: 'STORAGE_REQUEST_FAILED',
      status: 400,
      message: 'bucket lookup failed with 400 (Bucket name invalid)',
    });
  });
});
