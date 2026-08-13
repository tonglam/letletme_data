import type { DataPublicationManifest, DataPublicationManifestItem } from './data-publication';
import { CacheError } from '../utils/errors';

export type CoreCacheDeploymentDecision = 'rebuild' | 'reuse';

function sameManifestItem(
  left: DataPublicationManifestItem,
  right: DataPublicationManifestItem,
): boolean {
  return (
    left.name === right.name &&
    left.key === right.key &&
    left.type === right.type &&
    left.count === right.count &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256
  );
}

function sameImmutableRevision(
  left: DataPublicationManifest,
  right: DataPublicationManifest,
): boolean {
  return (
    left.dataset === right.dataset &&
    left.seasonCode === right.seasonCode &&
    left.eventId === right.eventId &&
    left.revision === right.revision &&
    left.publicationId === right.publicationId &&
    left.sourceCheckedAt === right.sourceCheckedAt &&
    left.state === right.state &&
    left.items.length === right.items.length &&
    left.items.every((item, index) => sameManifestItem(item, right.items[index]))
  );
}

export function decideCoreCacheDeployment(
  canonical: DataPublicationManifest,
  active: DataPublicationManifest | null,
): CoreCacheDeploymentDecision {
  if (!active) return 'rebuild';
  if (!sameImmutableRevision(canonical, active) || canonical.publishedAt !== active.publishedAt) {
    throw new CacheError(
      'Active core cache does not match the canonical database publication manifest',
      'CORE_CACHE_ACTIVE_MANIFEST_CONFLICT',
    );
  }
  return 'reuse';
}

export function assertCoreCacheRebuildCandidate(
  canonical: DataPublicationManifest,
  candidate: DataPublicationManifest,
): void {
  if (!sameImmutableRevision(canonical, candidate)) {
    throw new CacheError(
      'Current database snapshot does not match the immutable canonical publication manifest',
      'CORE_CACHE_DATABASE_SNAPSHOT_DRIFT',
    );
  }
}
