import { logInfo, logWarn } from '../../utils/logger';
import { getDbClient } from '../../db/singleton';
import { sha256CanonicalJson } from '../acquisition/canonicalization';
import { SourceMediaStorageError, type SourceMediaStorage } from './source-media-storage';

const RETENTION_BATCH_SIZE = 100;
const RETENTION_LEASE_MS = 10 * 60_000;

type RetentionAsset = Readonly<{ assetId: string; objectKey: string }>;

export async function runSourceMediaRetention(input: {
  workerId: string;
  storage: SourceMediaStorage;
  signal?: AbortSignal;
}): Promise<{ claimed: number; deleted: number; failed: number }> {
  const client = await getDbClient();
  const lockClient = await client.reserve();
  let lockAcquired = false;
  try {
    const rows = await lockClient<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtext('content-source-media-retention-v1')) AS acquired
    `;
    lockAcquired = rows[0]?.acquired === true;
    if (!lockAcquired) return { claimed: 0, deleted: 0, failed: 0 };
    await lockClient`
      UPDATE content.source_media_assets
      SET upload_lease_owner = NULL,
          upload_lease_expires_at = NULL,
          updated_at = now()
      WHERE storage_state = 'AVAILABLE'
        AND upload_lease_expires_at <= now()
    `;
    const candidates = await lockClient<{ assetId: string }[]>`
      SELECT asset.asset_id AS "assetId"
      FROM content.source_media_assets AS asset
      LEFT JOIN content.source_media_items AS item ON item.asset_id = asset.asset_id
      LEFT JOIN content.source_media_gates AS gate ON gate.gate_id = item.gate_id
      WHERE asset.storage_state = 'AVAILABLE'
        AND asset.upload_lease_owner IS NULL
      GROUP BY asset.asset_id
      HAVING (
        count(item.item_id) = 0
        AND asset.available_at < now() - interval '24 hours'
      ) OR (
        count(item.item_id) > 0
        AND bool_and(gate.retain_until IS NOT NULL)
        AND max(gate.retain_until) < current_date
      )
      ORDER BY COALESCE(max(gate.retain_until), asset.available_at::date), asset.asset_id
      LIMIT ${RETENTION_BATCH_SIZE}
    `;
    const assets: RetentionAsset[] = [];
    await lockClient`BEGIN`;
    try {
      for (const candidate of candidates) {
        const locked = await lockClient<{ assetId: string }[]>`
          SELECT asset_id AS "assetId"
          FROM content.source_media_assets
          WHERE asset_id = ${candidate.assetId}::uuid
            AND storage_state = 'AVAILABLE'
            AND upload_lease_owner IS NULL
          FOR UPDATE SKIP LOCKED
        `;
        if (locked.length !== 1) continue;
        // A separate statement after the row lock gets a fresh READ COMMITTED
        // snapshot. Any concurrent item archive must first take this same asset
        // lock, so it either becomes visible here or waits for the retention
        // lease marker and then fails closed.
        const row = await lockClient<RetentionAsset[]>`
          WITH refs AS (
            SELECT
              count(item.item_id)::integer AS reference_count,
              bool_and(gate.retain_until IS NOT NULL) AS deadlines_known,
              max(gate.retain_until) AS max_retain_until
            FROM content.source_media_items AS item
            JOIN content.source_media_gates AS gate ON gate.gate_id = item.gate_id
            WHERE item.asset_id = ${candidate.assetId}::uuid
          )
          UPDATE content.source_media_assets AS asset
          SET upload_lease_owner = ${input.workerId},
              upload_lease_expires_at =
                now() + (${RETENTION_LEASE_MS}::bigint * interval '1 millisecond'),
              updated_at = now()
          FROM refs
          WHERE asset.asset_id = ${candidate.assetId}::uuid
            AND asset.storage_state = 'AVAILABLE'
            AND asset.upload_lease_owner IS NULL
            AND (
              (refs.reference_count = 0 AND asset.available_at < now() - interval '24 hours')
              OR (
                refs.reference_count > 0
                AND refs.deadlines_known
                AND refs.max_retain_until < current_date
              )
            )
          RETURNING asset.asset_id AS "assetId", asset.object_key AS "objectKey"
        `;
        if (row[0]) assets.push(row[0]);
      }
      await lockClient`COMMIT`;
    } catch (error) {
      await lockClient`ROLLBACK`.catch(() => undefined);
      throw error;
    }
    let deleted = 0;
    let failed = 0;
    for (const asset of assets) {
      try {
        if (input.signal?.aborted) {
          throw new SourceMediaStorageError('STORAGE_ABORTED', 'Retention pass was aborted');
        }
        await input.storage.remove(asset.objectKey, input.signal);
        const completed = await lockClient<{ assetId: string }[]>`
          UPDATE content.source_media_assets
          SET storage_state = 'DELETED',
              deleted_at = now(),
              upload_lease_owner = NULL,
              upload_lease_expires_at = NULL,
              updated_at = now()
          WHERE asset_id = ${asset.assetId}::uuid
            AND storage_state = 'AVAILABLE'
            AND upload_lease_owner = ${input.workerId}
          RETURNING asset_id AS "assetId"
        `;
        if (completed.length !== 1) throw new Error('Source-media retention lease was lost');
        deleted += 1;
      } catch (error) {
        const failureClass =
          error instanceof SourceMediaStorageError
            ? error.failureClass
            : 'SOURCE_MEDIA_RETENTION_FAILED';
        const failureHash = sha256CanonicalJson({ failureClass });
        await lockClient`
          UPDATE content.source_media_assets
          SET upload_lease_owner = NULL,
              upload_lease_expires_at = NULL,
              last_failure_hash = ${failureHash},
              updated_at = now()
          WHERE asset_id = ${asset.assetId}::uuid
            AND storage_state = 'AVAILABLE'
            AND upload_lease_owner = ${input.workerId}
        `.catch(() => undefined);
        failed += 1;
        logWarn('Source-media retention delete failed', {
          assetId: asset.assetId,
          failureClass,
        });
      }
    }
    const result = { claimed: assets.length, deleted, failed };
    if (assets.length > 0) logInfo('Source-media retention pass completed', result);
    return result;
  } finally {
    if (lockAcquired) {
      await lockClient`
        SELECT pg_advisory_unlock(hashtext('content-source-media-retention-v1'))
      `.catch(() => undefined);
    }
    lockClient.release();
  }
}
