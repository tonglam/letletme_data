import { activateDataPublicationPointer, stageDataPublication } from '../cache/data-publication';
import {
  claimDataPublicationOutbox,
  failDataPublicationOutbox,
  loadDataPublicationDelivery,
  markDataPublicationOutboxDelivered,
  reconcileDataPublicationOutbox,
  markDataPublicationOutboxStage,
  releaseDataPublicationOutbox,
  type ClaimedDataPublicationOutbox,
} from '../repositories/data-publication-outbox';
import { recordDataPublicationEvidence } from './data-governance.service';
import { logError } from '../utils/logger';
import { classifyDataPublicationDeliveryFailure } from '../domain/data-publication-delivery';

export type DataPublicationDeliveryDependencies = Readonly<{
  clock: { now(): Date };
  claim: typeof claimDataPublicationOutbox;
  fail: typeof failDataPublicationOutbox;
  load: typeof loadDataPublicationDelivery;
  markDelivered: typeof markDataPublicationOutboxDelivered;
  reconcile: typeof reconcileDataPublicationOutbox;
  markStage: typeof markDataPublicationOutboxStage;
  release: typeof releaseDataPublicationOutbox;
  stage: typeof stageDataPublication;
  activate: typeof activateDataPublicationPointer;
  recordEvidence: typeof recordDataPublicationEvidence;
  reportError: typeof logError;
}>;

const productionDependencies: DataPublicationDeliveryDependencies = {
  clock: { now: () => new Date() },
  claim: claimDataPublicationOutbox,
  fail: failDataPublicationOutbox,
  load: loadDataPublicationDelivery,
  markDelivered: markDataPublicationOutboxDelivered,
  reconcile: reconcileDataPublicationOutbox,
  markStage: markDataPublicationOutboxStage,
  release: releaseDataPublicationOutbox,
  stage: stageDataPublication,
  activate: activateDataPublicationPointer,
  recordEvidence: recordDataPublicationEvidence,
  reportError: logError,
};

function decodePublicationPayloads(
  items: ClaimedDataPublicationOutbox['items'],
): Readonly<Record<string, unknown>> {
  const payloads: Record<string, unknown> = {};
  for (const item of items) {
    try {
      payloads[item.manifest.name] = JSON.parse(item.payload) as unknown;
    } catch {
      // The checksum/byte proof remains authoritative. Telemetry can fall
      // back to manifest counts when an item is not JSON-decodable.
    }
  }
  return payloads;
}

async function recordPublicationEvidenceBestEffort(
  input: {
    row: ClaimedDataPublicationOutbox;
    pgPublishedAt?: Date | null;
    redisSeenAt?: Date | null;
  },
  dependencies: DataPublicationDeliveryDependencies,
): Promise<void> {
  try {
    await dependencies.recordEvidence({
      manifest: input.row.manifest,
      sourceRunId: input.row.sourceRunId,
      payloads: decodePublicationPayloads(input.row.items),
      pgPublishedAt: input.pgPublishedAt,
      redisSeenAt: input.redisSeenAt,
    });
  } catch (error) {
    // Governance evidence is additive. A telemetry outage must not turn a
    // successfully staged publication into a failed delivery.
    dependencies.reportError('Data publication freshness evidence update failed', error, {
      publicationId: input.row.publicationId,
      dataset: input.row.manifest.dataset,
    });
  }
}

/**
 * Close a receipt after a reconciler has already compare-and-swap repaired
 * the Redis pointer. The SQL repository only changes durable state; this
 * service owns the optional governance evidence side effect.
 */
export async function markDataPublicationOutboxReconciled(
  input: {
    publicationId: string;
    db?: Parameters<typeof reconcileDataPublicationOutbox>[0]['db'];
  },
  dependencies: DataPublicationDeliveryDependencies = productionDependencies,
): Promise<boolean> {
  const receipt = await dependencies.reconcile(input);
  if (!receipt) return false;
  try {
    const prepared = await dependencies.load(input.publicationId);
    await dependencies.recordEvidence({
      manifest: prepared.manifest,
      sourceRunId: receipt.sourceRunId,
      payloads: Object.fromEntries(
        prepared.items.flatMap((item) => {
          try {
            return [[item.manifest.name, JSON.parse(item.payload) as unknown]];
          } catch {
            return [];
          }
        }),
      ),
      pgPublishedAt: receipt.dbActivatedAt,
      redisSeenAt: dependencies.clock.now(),
    });
  } catch (error) {
    dependencies.reportError('Reconciled publication freshness evidence update failed', error, {
      publicationId: input.publicationId,
    });
  }
  return true;
}

export async function dispatchDataPublicationOutbox(
  input: Parameters<typeof claimDataPublicationOutbox>[0] = {},
  dependencies: DataPublicationDeliveryDependencies = productionDependencies,
): Promise<{ claimed: number; delivered: number; failed: number }> {
  const claimed = await dependencies.claim(input);
  let delivered = 0;
  let failed = 0;
  await Promise.all(
    claimed.map(async (row) => {
      try {
        // Canonical DB activation happened before this dispatcher was called.
        // Redis is staged and CAS-activated only after the proof is complete.
        await recordPublicationEvidenceBestEffort(
          {
            row,
            pgPublishedAt: row.dbActivatedAt,
          },
          dependencies,
        );
        await dependencies.stage({ manifest: row.manifest, items: row.items });
        if (
          !(await dependencies.markStage({
            outboxId: row.outboxId,
            owner: row.owner,
            status: 'staged',
            db: input.db,
          }))
        ) {
          throw new Error(`Outbox lease lost while staging ${row.outboxId}`);
        }
        const activation = await dependencies.activate(row.manifest);
        if (activation.status === 'stale') {
          throw new Error(
            `Redis publication is newer than canonical publication ${row.publicationId}; reconciliation required`,
          );
        }
        if (
          !(await dependencies.markStage({
            outboxId: row.outboxId,
            owner: row.owner,
            status: 'redis_activated',
            db: input.db,
          }))
        ) {
          throw new Error(`Outbox lease lost while activating ${row.outboxId}`);
        }
        await recordPublicationEvidenceBestEffort(
          { row, redisSeenAt: dependencies.clock.now() },
          dependencies,
        );
        if (await dependencies.markDelivered({ ...row, db: input.db })) delivered += 1;
      } catch (error) {
        failed += 1;
        dependencies.reportError('Data publication outbox delivery failed', error, {
          outboxId: row.outboxId,
          publicationId: row.publicationId,
        });
        if (classifyDataPublicationDeliveryFailure(error) === 'superseded') {
          // The DB publication is superseded; retrying it forever can never
          // legitimately move the pointer backwards.
          await dependencies.fail({
            outboxId: row.outboxId,
            owner: row.owner,
            error,
            db: input.db,
          });
        } else {
          await dependencies.release({
            outboxId: row.outboxId,
            owner: row.owner,
            error,
            db: input.db,
          });
        }
      }
    }),
  );
  return { claimed: claimed.length, delivered, failed };
}
