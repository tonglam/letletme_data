import type { ManagerLiveTournamentCoverageState } from '../../repositories/live-window';
import { isFinalManagerLiveRevision } from '../../domain/manager-live-coverage';
import type { ManagerLiveResolveResult, ManagerLiveTournamentCoverage } from './contracts';

/** Pure coverage state transitions used by both the read path and worker. */
export const deriveManagerLiveTournamentCoverageState = (input: {
  expectedEntries: number;
  resolvedEntries: number;
  errorCode: ManagerLiveResolveResult['errorCode'];
  crawlComplete: boolean;
}): ManagerLiveTournamentCoverageState => {
  const complete =
    input.crawlComplete &&
    input.errorCode === null &&
    input.resolvedEntries === input.expectedEntries;
  if (complete) return 'COMPLETE';
  if (input.resolvedEntries > 0) return 'PARTIAL';
  if (input.errorCode) return 'UNAVAILABLE';
  return 'WARMING';
};

export const invalidateManagerLiveTournamentCoverage = (
  coverage: ManagerLiveTournamentCoverage | null,
  rosterRevision: string,
  expectedEntries: number,
): ManagerLiveTournamentCoverage | null => {
  if (!coverage || coverage.rosterRevision === rosterRevision) return coverage;
  return {
    ...coverage,
    rosterRevision,
    expectedEntries,
    resolvedEntries: 0,
    fullyFetchedAt: null,
    managerRevision: null,
    error: null,
    state: 'WARMING',
  };
};

export const shouldPreserveManagerLiveTournamentCoverage = (
  coverage: {
    state: string;
    rosterRevision: string;
    expectedEntries: number;
    resolvedEntries: number;
  } | null,
  rosterRevision: string,
  expectedEntries: number,
): boolean =>
  coverage?.state === 'COMPLETE' &&
  coverage.rosterRevision === rosterRevision &&
  coverage.expectedEntries === expectedEntries &&
  coverage.resolvedEntries === expectedEntries;

export const shouldQueueFinalizedManagerLiveCoverage = (
  coverage: Pick<
    ManagerLiveTournamentCoverage,
    'state' | 'rosterRevision' | 'expectedEntries' | 'resolvedEntries' | 'managerRevision'
  > | null,
  rosterRevision: string,
  expectedEntries: number,
  currentManagerRevision?: string | null,
): boolean =>
  !(
    coverage?.state === 'COMPLETE' &&
    coverage.rosterRevision === rosterRevision &&
    coverage.expectedEntries === expectedEntries &&
    coverage.resolvedEntries === expectedEntries &&
    isFinalManagerLiveRevision(coverage.managerRevision) &&
    (currentManagerRevision === undefined || coverage.managerRevision === currentManagerRevision)
  );
