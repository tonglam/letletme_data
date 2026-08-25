import { createHash } from 'node:crypto';

import { describe, expect, mock, test } from 'bun:test';

import type { FPLBootstrapResponse } from '../../src/clients/fpl';
import type { FplSourceArtifact } from '../../src/repositories/fpl-source-artifacts';
import {
  FplBootstrapSourceArtifactError,
  resolveFplBootstrapSourceArtifact,
  type FplBootstrapSourceArtifactDependencies,
} from '../../src/services/fpl-bootstrap-source-artifact.service';
import type { FplSourceArtifactStorage } from '../../src/services/fpl-source-artifact-storage.service';
import { buildCoreSnapshotFixture } from '../fixtures/core-snapshot.fixtures';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const sourceDay = '20260825';
const retrievedAt = new Date('2026-08-25T01:25:00.000Z');
const now = new Date('2026-08-25T08:00:00.000Z');

function bytesFor(payload: FPLBootstrapResponse): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function counts(payload: FPLBootstrapResponse) {
  return {
    events: payload.events.length,
    teams: payload.teams.length,
    elements: payload.elements.length,
    phases: payload.phases.length,
  };
}

function artifactFor(payload: FPLBootstrapResponse, bytes = bytesFor(payload)): FplSourceArtifact {
  const sha256 = digest(bytes);
  return {
    artifactId: '11111111-1111-4111-8111-111111111111',
    seasonId: TEST_SEASON.seasonId,
    sourceDay,
    sourceTimezone: 'Asia/Shanghai',
    sourceUrl: 'https://fantasy.premierleague.com/api/bootstrap-static/',
    bucket: 'fpl-raw-snapshots',
    objectKey: `fpl/bootstrap-static/${TEST_SEASON.seasonCode}/${sourceDay}/${sha256}.json`,
    sha256,
    byteSize: bytes.byteLength,
    contentType: 'application/json',
    retrievedAt,
    schemaVersion: 1,
    itemCounts: counts(payload),
    createdAt: retrievedAt,
  };
}

function memoryStorage(
  objects: Map<string, Uint8Array>,
  calls: string[] = [],
  contentType = 'application/json',
): FplSourceArtifactStorage {
  return {
    ensureBucket: async () => ({
      id: 'fpl-raw-snapshots',
      public: false,
      file_size_limit: 8 * 1_024 * 1_024,
      allowed_mime_types: ['application/json'],
    }),
    uploadImmutable: async (objectKey, bytes) => {
      calls.push('upload');
      const outcome = objects.has(objectKey) ? 'exists' : 'created';
      objects.set(objectKey, bytes.slice());
      return outcome;
    },
    download: async (objectKey) => {
      calls.push('download');
      const bytes = objects.get(objectKey);
      if (!bytes) throw new Error('missing');
      return { bytes: bytes.slice(), contentType, declaredByteSize: bytes.byteLength };
    },
    remove: async (objectKey) => (objects.delete(objectKey) ? 'deleted' : 'missing'),
    provisionAndProbe: async () => undefined,
  };
}

function dependencies(
  payload: FPLBootstrapResponse,
  overrides: Partial<FplBootstrapSourceArtifactDependencies> = {},
): FplBootstrapSourceArtifactDependencies {
  const bytes = bytesFor(payload);
  const objects = new Map<string, Uint8Array>();
  return {
    captureBootstrap: async () => ({
      bytes,
      payload,
      sourceUrl: 'https://fantasy.premierleague.com/api/bootstrap-static/',
      contentType: 'application/json',
      retrievedAt,
    }),
    findLatestForDay: async () => null,
    insertIfAbsent: async (input) => ({ ...input, createdAt: retrievedAt }),
    getStorage: () => memoryStorage(objects),
    bucket: 'fpl-raw-snapshots',
    now: () => now,
    ...overrides,
  };
}

describe('FPL bootstrap source-day archive', () => {
  test('archives and verifies exact current-day bytes before committing the manifest', async () => {
    const payload = buildCoreSnapshotFixture({ playerCount: 2 }).bootstrap;
    const calls: string[] = [];
    const objects = new Map<string, Uint8Array>();
    const insertIfAbsent = mock(
      async (input: Parameters<FplBootstrapSourceArtifactDependencies['insertIfAbsent']>[0]) => {
        calls.push('insert');
        expect(calls.slice(0, 2)).toEqual(['upload', 'download']);
        return { ...input, createdAt: retrievedAt };
      },
    );

    const result = await resolveFplBootstrapSourceArtifact(
      TEST_SEASON,
      sourceDay,
      dependencies(payload, {
        getStorage: () => memoryStorage(objects, calls),
        insertIfAbsent,
      }),
    );

    expect(result.provenance).toBe('captured');
    expect(result.bootstrap.elements).toHaveLength(2);
    expect(result.artifact.objectKey).toMatch(
      /^fpl\/bootstrap-static\/2627\/20260825\/[0-9a-f]{64}\.json$/,
    );
    expect(calls).toEqual(['upload', 'download', 'insert', 'download']);
  });

  test('historical replay is archive-only and never calls the provider', async () => {
    const payload = buildCoreSnapshotFixture({ playerCount: 1 }).bootstrap;
    const bytes = bytesFor(payload);
    const artifact = artifactFor(payload, bytes);
    const objects = new Map([[artifact.objectKey, bytes]]);
    const captureBootstrap = mock(async () => {
      throw new Error('provider must not be called');
    });

    const result = await resolveFplBootstrapSourceArtifact(
      TEST_SEASON,
      sourceDay,
      dependencies(payload, {
        now: () => new Date('2026-08-26T08:00:00.000Z'),
        captureBootstrap,
        findLatestForDay: async () => artifact,
        getStorage: () => memoryStorage(objects),
      }),
    );

    expect(result.provenance).toBe('archive');
    expect(result.artifact.artifactId).toBe(artifact.artifactId);
    expect(captureBootstrap).not.toHaveBeenCalled();
  });

  test('fails closed when a historical source day has no archive', async () => {
    const payload = buildCoreSnapshotFixture({ playerCount: 1 }).bootstrap;
    const captureBootstrap = mock(async () => {
      throw new Error('provider must not be called');
    });

    try {
      await resolveFplBootstrapSourceArtifact(
        TEST_SEASON,
        sourceDay,
        dependencies(payload, {
          now: () => new Date('2026-08-26T08:00:00.000Z'),
          captureBootstrap,
          findLatestForDay: async () => null,
        }),
      );
      throw new Error('expected missing archive failure');
    } catch (error) {
      expect(error).toBeInstanceOf(FplBootstrapSourceArtifactError);
      expect((error as FplBootstrapSourceArtifactError).code).toBe('FPL_SOURCE_ARCHIVE_MISSING');
    }
    expect(captureBootstrap).not.toHaveBeenCalled();
  });

  test('rejects future source days before provider, database, or storage access', async () => {
    const payload = buildCoreSnapshotFixture({ playerCount: 1 }).bootstrap;
    const captureBootstrap = mock(async () => {
      throw new Error('unexpected');
    });
    const findLatestForDay = mock(async () => null);

    await expect(
      resolveFplBootstrapSourceArtifact(
        TEST_SEASON,
        '20260826',
        dependencies(payload, { captureBootstrap, findLatestForDay }),
      ),
    ).rejects.toMatchObject({ code: 'FPL_SOURCE_DAY_FUTURE' });
    expect(captureBootstrap).not.toHaveBeenCalled();
    expect(findLatestForDay).not.toHaveBeenCalled();
  });

  test('rejects corrupt historical bytes and wrong actual media type', async () => {
    const payload = buildCoreSnapshotFixture({ playerCount: 1 }).bootstrap;
    const bytes = bytesFor(payload);
    const artifact = artifactFor(payload, bytes);
    const corrupt = bytes.slice();
    corrupt[0] = corrupt[0] === 123 ? 91 : 123;

    await expect(
      resolveFplBootstrapSourceArtifact(
        TEST_SEASON,
        sourceDay,
        dependencies(payload, {
          now: () => new Date('2026-08-26T08:00:00.000Z'),
          findLatestForDay: async () => artifact,
          getStorage: () => memoryStorage(new Map([[artifact.objectKey, corrupt]])),
        }),
      ),
    ).rejects.toMatchObject({ code: 'FPL_SOURCE_ARCHIVE_HASH_MISMATCH' });

    await expect(
      resolveFplBootstrapSourceArtifact(
        TEST_SEASON,
        sourceDay,
        dependencies(payload, {
          now: () => new Date('2026-08-26T08:00:00.000Z'),
          findLatestForDay: async () => artifact,
          getStorage: () => memoryStorage(new Map([[artifact.objectKey, bytes]]), [], 'text/html'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'FPL_SOURCE_ARCHIVE_CONTENT_TYPE_MISMATCH' });
  });

  test('rejects an archived bootstrap whose event calendar belongs to another season', async () => {
    const payload = buildCoreSnapshotFixture({ playerCount: 1 }).bootstrap;
    const wrongSeason = {
      ...payload,
      events: payload.events.map((event) => ({
        ...event,
        deadline_time: event.deadline_time?.replace(/^2026/, '2025') ?? null,
      })),
    };
    const bytes = bytesFor(wrongSeason);
    const artifact = artifactFor(wrongSeason, bytes);

    await expect(
      resolveFplBootstrapSourceArtifact(
        TEST_SEASON,
        sourceDay,
        dependencies(wrongSeason, {
          now: () => new Date('2026-08-26T08:00:00.000Z'),
          findLatestForDay: async () => artifact,
          getStorage: () => memoryStorage(new Map([[artifact.objectKey, bytes]])),
        }),
      ),
    ).rejects.toMatchObject({ code: 'FPL_SOURCE_SEASON_MISMATCH' });
  });
});
