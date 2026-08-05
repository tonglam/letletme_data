import { syncCoreSnapshot } from '../../../src/services/core-snapshot.service';

let coreReady: Promise<void> | undefined;

function retryable(task: () => Promise<void>, reset: () => void): Promise<void> {
  return task().catch((error) => {
    reset();
    throw error;
  });
}

/** Seed the complete FPL core once so no partial writer can publish first. */
export function ensureCoreSnapshot(): Promise<void> {
  coreReady ??= retryable(
    async () => {
      await syncCoreSnapshot();
    },
    () => {
      coreReady = undefined;
    },
  );
  return coreReady;
}

export function ensureEvents(): Promise<void> {
  return ensureCoreSnapshot();
}

export function ensureTeams(): Promise<void> {
  return ensureCoreSnapshot();
}

export function ensurePlayers(): Promise<void> {
  return ensureCoreSnapshot();
}
