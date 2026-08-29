import { createHash } from 'node:crypto';
import { describe, expect, mock, test } from 'bun:test';

import {
  dataPublicationItemKey,
  type DataPublicationManifest,
} from '../../src/cache/data-publication';
import type { ClaimedDataPublicationOutbox } from '../../src/repositories/data-publication-outbox';
import {
  dispatchDataPublicationOutbox,
  markDataPublicationOutboxReconciled,
  type DataPublicationDeliveryDependencies,
} from '../../src/services/data-publication-delivery.service';

const payload = JSON.stringify([{ id: 1 }]);
const manifest: DataPublicationManifest = {
  dataset: 'fpl:market',
  seasonCode: '2627',
  eventId: null,
  revision: 7,
  publicationId: '00000000-0000-4000-8000-000000000007',
  sourceCheckedAt: '2026-08-28T00:00:00.000Z',
  publishedAt: '2026-08-28T00:00:01.000Z',
  state: 'active',
  items: [
    {
      name: 'context',
      key: dataPublicationItemKey({ dataset: 'fpl:market', seasonCode: '2627' }, 7, 'context'),
      type: 'string',
      count: 1,
      bytes: Buffer.byteLength(payload),
      sha256: createHash('sha256').update(payload).digest('hex'),
    },
  ],
};

const claimedRow: ClaimedDataPublicationOutbox = {
  outboxId: '10000000-0000-4000-8000-000000000001',
  owner: 'worker-1',
  publicationId: manifest.publicationId,
  sourceRunId: '20000000-0000-4000-8000-000000000002',
  dbActivatedAt: new Date('2026-08-28T00:00:02.000Z'),
  manifest,
  items: [
    { manifest: manifest.items[0]!, payload },
    {
      manifest: { ...manifest.items[0]!, name: 'invalid-json' },
      payload: '{',
    },
  ],
};

function dependencies(
  overrides: Partial<DataPublicationDeliveryDependencies> = {},
): DataPublicationDeliveryDependencies {
  return {
    clock: { now: () => new Date('2026-08-28T00:00:03.000Z') },
    claim: async () => [claimedRow],
    fail: async () => true,
    load: async () => ({ manifest, items: claimedRow.items }),
    markDelivered: async () => true,
    reconcile: async () => ({
      publicationId: manifest.publicationId,
      sourceRunId: claimedRow.sourceRunId,
      dbActivatedAt: claimedRow.dbActivatedAt,
    }),
    markStage: async () => true,
    release: async () => true,
    stage: async () => undefined,
    activate: async () => ({ status: 'published', manifest, previousManifest: null }),
    recordEvidence: async () => 1,
    reportError: () => undefined,
    ...overrides,
  };
}

describe('data publication delivery service', () => {
  test('returns an empty receipt when no rows are claimable', async () => {
    const result = await dispatchDataPublicationOutbox({}, dependencies({ claim: async () => [] }));
    expect(result).toEqual({ claimed: 0, delivered: 0, failed: 0 });
  });

  test('stages, CAS-activates and delivers while evidence remains best effort', async () => {
    const recordEvidence = mock(
      async (
        _input: Parameters<DataPublicationDeliveryDependencies['recordEvidence']>[0],
      ): Promise<number> => 1,
    );
    recordEvidence.mockImplementationOnce(async () => {
      throw new Error('telemetry unavailable');
    });
    const markStage = mock(
      async (
        _input: Parameters<DataPublicationDeliveryDependencies['markStage']>[0],
      ): Promise<boolean> => true,
    );
    const markDelivered = mock(async () => true);
    const reportError = mock(() => undefined);

    const result = await dispatchDataPublicationOutbox(
      {},
      dependencies({ recordEvidence, markStage, markDelivered, reportError }),
    );

    expect(result).toEqual({ claimed: 1, delivered: 1, failed: 0 });
    expect(markStage.mock.calls.map((call) => call[0].status)).toEqual([
      'staged',
      'redis_activated',
    ]);
    expect(recordEvidence).toHaveBeenCalledTimes(2);
    expect(recordEvidence.mock.calls[1]?.[0].payloads).toEqual({ context: [{ id: 1 }] });
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  test('releases a retryable lease loss and permanently fails a superseded pointer', async () => {
    const release = mock(async () => true);
    const lost = await dispatchDataPublicationOutbox(
      {},
      dependencies({ markStage: async () => false, release }),
    );
    expect(lost).toEqual({ claimed: 1, delivered: 0, failed: 1 });
    expect(release).toHaveBeenCalledTimes(1);

    const fail = mock(async () => true);
    const superseded = await dispatchDataPublicationOutbox(
      {},
      dependencies({
        activate: async () => ({ status: 'stale', manifest, previousManifest: null }),
        fail,
      }),
    );
    expect(superseded).toEqual({ claimed: 1, delivered: 0, failed: 1 });
    expect(fail).toHaveBeenCalledTimes(1);
  });

  test('reconciles an existing receipt and treats evidence failure as non-fatal', async () => {
    expect(
      await markDataPublicationOutboxReconciled(
        { publicationId: manifest.publicationId },
        dependencies({ reconcile: async () => null }),
      ),
    ).toBe(false);

    const reportError = mock(() => undefined);
    expect(
      await markDataPublicationOutboxReconciled(
        { publicationId: manifest.publicationId },
        dependencies({
          recordEvidence: async () => {
            throw new Error('evidence unavailable');
          },
          reportError,
        }),
      ),
    ).toBe(true);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
