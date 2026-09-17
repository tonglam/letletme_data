/* eslint-disable no-console */
import { databaseSingleton } from '../src/db/singleton';
import { readActiveDataPublication } from '../src/cache/data-publication';
import { redisSingleton } from '../src/cache/singleton';
import {
  loadDataPublicationDeliveryManifest,
  validateAndMarkDataPublicationProof,
} from '../src/repositories/data-publication-outbox';
import { seasonRepository } from '../src/repositories/seasons';
import { syncOperationsRepository } from '../src/repositories/sync-operations';
import type { DataPublicationDataset } from '../src/cache/data-publication';
import { reconcileDataPublication } from '../src/services/data-publication-reconciler';

const DATASETS: readonly DataPublicationDataset[] = ['fpl:core', 'fpl:market', 'fpl:price-changes'];

type ProofResult = Readonly<{
  dataset: DataPublicationDataset;
  publicationId: string | null;
  status: 'missing' | 'already_validated' | 'validated';
  revision?: number;
}>;

async function main(): Promise<void> {
  const season = await seasonRepository.findCurrent();
  const results: ProofResult[] = [];

  for (const dataset of DATASETS) {
    let active = await syncOperationsRepository.findActivePublication(dataset, season);
    // Deployment acceptance is the one bounded rollout-time consumer read.
    // Normal health probes stay metadata-only, while this gate lets the
    // existing bounded reconciler repair a rebuildable Redis cache before the
    // full manifest/item validation used by delivery consumers.
    const reconciliation = await reconcileDataPublication(
      {
        dataset,
        seasonCode: season.seasonCode,
      },
      season,
    );
    if (reconciliation.status === 'missing') {
      results.push({ dataset, publicationId: null, status: 'missing' });
      continue;
    }
    if (reconciliation.status === 'ghost' || reconciliation.status === 'failed') {
      throw new Error(
        `Active ${dataset} publication cache reconciliation failed with ${reconciliation.status}`,
      );
    }

    if (reconciliation.status === 'repaired') {
      // A staged publication may have become active as part of repair, so
      // refresh the canonical identity before checking the repaired cache.
      active = await syncOperationsRepository.findActivePublication(dataset, season);
      const cached = await readActiveDataPublication({
        dataset,
        seasonCode: season.seasonCode,
      }).catch(() => null);
      if (
        !cached ||
        !active ||
        cached.manifest.publicationId !== active.publicationId ||
        cached.manifest.revision !== active.revision
      ) {
        throw new Error(
          `Active ${dataset} publication ${active?.publicationId ?? 'unknown'} failed Redis payload validation after repair`,
        );
      }
    }

    if (!active) {
      throw new Error(`Active ${dataset} publication reconciliation returned an invalid state`);
    }

    const durableManifest = await loadDataPublicationDeliveryManifest(active.publicationId);
    if (durableManifest) {
      results.push({
        dataset,
        publicationId: active.publicationId,
        status: 'already_validated',
        revision: active.revision,
      });
      continue;
    }

    // The matched path above already performed the bounded Redis consumer
    // read. This database proof upgrade is limited to the current active
    // publication; historical rows are neither scanned nor marked.
    const validated = await validateAndMarkDataPublicationProof(active.publicationId);
    if (!validated) {
      throw new Error(
        `Active ${dataset} publication ${active.publicationId} could not be fully validated`,
      );
    }
    results.push({
      dataset,
      publicationId: active.publicationId,
      status: 'validated',
      revision: active.revision,
    });
  }

  console.log(
    JSON.stringify(
      {
        status: 'active_publication_proofs_validated',
        seasonCode: season.seasonCode,
        datasets: results,
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} finally {
  await Promise.allSettled([databaseSingleton.disconnect(), redisSingleton.disconnect()]);
}
