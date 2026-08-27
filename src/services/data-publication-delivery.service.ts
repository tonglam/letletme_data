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

async function recordPublicationEvidenceBestEffort(input: {
  row: ClaimedDataPublicationOutbox;
  pgPublishedAt?: Date | null;
  redisSeenAt?: Date | null;
}): Promise<void> {
  try {
    await recordDataPublicationEvidence({
      manifest: input.row.manifest,
      sourceRunId: input.row.sourceRunId,
      payloads: decodePublicationPayloads(input.row.items),
      pgPublishedAt: input.pgPublishedAt,
      redisSeenAt: input.redisSeenAt,
    });
  } catch (error) {
    // Governance evidence is additive. A telemetry outage must not turn a
    // successfully staged publication into a failed delivery.
    logError('Data publication freshness evidence update failed', error, {
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
export async function markDataPublicationOutboxReconciled(input: {
  publicationId: string;
  db?: Parameters<typeof reconcileDataPublicationOutbox>[0]['db'];
}): Promise<boolean> {
  const receipt = await reconcileDataPublicationOutbox(input);
  if (!receipt) return false;
  try {
    const prepared = await loadDataPublicationDelivery(input.publicationId);
    await recordDataPublicationEvidence({
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
      redisSeenAt: new Date(),
    });
  } catch (error) {
    logError('Reconciled publication freshness evidence update failed', error, {
      publicationId: input.publicationId,
    });
  }
  return true;
}

export async function dispatchDataPublicationOutbox(
  input: Parameters<typeof claimDataPublicationOutbox>[0] = {},
): Promise<{ claimed: number; delivered: number; failed: number }> {
  const claimed = await claimDataPublicationOutbox(input);
  let delivered = 0;
  let failed = 0;
  await Promise.all(
    claimed.map(async (row) => {
      try {
        // Canonical DB activation happened before this dispatcher was called.
        // Redis is staged and CAS-activated only after the proof is complete.
        await recordPublicationEvidenceBestEffort({
          row,
          pgPublishedAt: row.dbActivatedAt,
        });
        await stageDataPublication({ manifest: row.manifest, items: row.items });
        if (
          !(await markDataPublicationOutboxStage({
            outboxId: row.outboxId,
            owner: row.owner,
            status: 'staged',
            db: input.db,
          }))
        ) {
          throw new Error(`Outbox lease lost while staging ${row.outboxId}`);
        }
        const activation = await activateDataPublicationPointer(row.manifest);
        if (activation.status === 'stale') {
          throw new Error(
            `Redis publication is newer than canonical publication ${row.publicationId}; reconciliation required`,
          );
        }
        if (
          !(await markDataPublicationOutboxStage({
            outboxId: row.outboxId,
            owner: row.owner,
            status: 'redis_activated',
            db: input.db,
          }))
        ) {
          throw new Error(`Outbox lease lost while activating ${row.outboxId}`);
        }
        await recordPublicationEvidenceBestEffort({ row, redisSeenAt: new Date() });
        if (await markDataPublicationOutboxDelivered({ ...row, db: input.db })) delivered += 1;
      } catch (error) {
        failed += 1;
        logError('Data publication outbox delivery failed', error, {
          outboxId: row.outboxId,
          publicationId: row.publicationId,
        });
        if (error instanceof Error && error.message.includes('Redis publication is newer')) {
          // The DB publication is superseded; retrying it forever can never
          // legitimately move the pointer backwards.
          await failDataPublicationOutbox({
            outboxId: row.outboxId,
            owner: row.owner,
            error,
            db: input.db,
          });
        } else {
          await releaseDataPublicationOutbox({
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
