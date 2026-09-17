/* eslint-disable no-console */
import { databaseSingleton } from '../src/db/singleton';
import {
  loadDataPublicationDeliveryManifest,
  validateAndMarkDataPublicationProof,
} from '../src/repositories/data-publication-outbox';
import { seasonRepository } from '../src/repositories/seasons';
import { syncOperationsRepository } from '../src/repositories/sync-operations';
import type { DataPublicationDataset } from '../src/cache/data-publication';

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
    const active = await syncOperationsRepository.findActivePublication(dataset, season);
    if (!active) {
      results.push({ dataset, publicationId: null, status: 'missing' });
      continue;
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

    // This is the only rollout-time payload read. It is limited to the
    // current active publication for each known dataset; historical rows are
    // neither scanned nor marked.
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
  await databaseSingleton.disconnect();
}
