import { createHash } from 'node:crypto';

export const MANAGER_LIVE_FINAL_REVISION_PREFIX = 'final:';

export const finalManagerRevision = (revision: string): string =>
  `${MANAGER_LIVE_FINAL_REVISION_PREFIX}${revision}`;

export const isFinalManagerLiveRevision = (revision: string | null | undefined): boolean =>
  typeof revision === 'string' && revision.startsWith(MANAGER_LIVE_FINAL_REVISION_PREFIX);

export const tournamentRosterRevision = (entryIds: readonly number[]): string =>
  createHash('sha256')
    .update(
      Array.from(new Set(entryIds))
        .sort((left, right) => left - right)
        .join(','),
    )
    .digest('hex')
    .slice(0, 20);
