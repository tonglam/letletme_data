import { randomUUID } from 'node:crypto';

import { queueRedisSingleton } from '../queues/redis';

/**
 * Cross-worker single-flight for one entry/GW source unit.  This lives on the
 * queue Redis database because it coordinates workers, not rebuildable data
 * publication.  The TTL is only a crash safety net; the token-fenced release
 * keeps an expired/replaced owner from deleting a newer lease.
 */
export const TOURNAMENT_ENTRY_SYNC_LEASE_PREFIX = 'llm:queue:coordination:tournament-entry-sync:v1';
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_WAIT_MS = 60_000;
const POLL_MS = 100;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])
`;

export type TournamentEntrySyncLeaseScope = Readonly<{
  seasonId: number;
  eventId: number;
  entryId: number;
}>;

export type TournamentEntrySyncLeaseOptions = Readonly<{
  leaseMs?: number;
  waitMs?: number;
  pollMs?: number;
}>;

export function tournamentEntrySyncLeaseKey(scope: TournamentEntrySyncLeaseScope): string {
  return `${TOURNAMENT_ENTRY_SYNC_LEASE_PREFIX}:${scope.seasonId}:${scope.eventId}:${scope.entryId}`;
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Run one source fetch/persist unit under a bounded distributed lease.
 * Waiting is deliberately finite: a worker that cannot observe the owner
 * completing should retry through the normal job policy instead of blocking a
 * queue worker indefinitely.  The lease is not held across a database
 * transaction started by another caller; the callback owns its own short
 * transaction boundary.
 */
export async function withTournamentEntrySyncLease<T>(
  scope: TournamentEntrySyncLeaseScope,
  operation: () => Promise<T>,
  options: TournamentEntrySyncLeaseOptions = {},
): Promise<T> {
  const leaseMs = Math.max(1_000, Math.floor(options.leaseMs ?? DEFAULT_LEASE_MS));
  const waitMs = Math.max(1_000, Math.floor(options.waitMs ?? DEFAULT_WAIT_MS));
  const pollMs = Math.max(25, Math.floor(options.pollMs ?? POLL_MS));
  const key = tournamentEntrySyncLeaseKey(scope);
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  const redis = await queueRedisSingleton.getClient();

  while (Date.now() < deadline) {
    const acquired = await redis.set(key, token, 'PX', leaseMs, 'NX');
    if (acquired === 'OK') {
      let renewalInFlight = false;
      const renew = async () => {
        if (renewalInFlight) return;
        renewalInFlight = true;
        try {
          // Token fencing makes a late renewal harmless after this owner has
          // lost the lease to another worker.
          await redis.eval(RENEW_SCRIPT, 1, key, token, String(leaseMs));
        } catch {
          // The bounded TTL remains the crash/Redis-outage safety net. The
          // operation still owns the token and release remains fenced.
        } finally {
          renewalInFlight = false;
        }
      };
      const renewalTimer = setInterval(
        () => {
          void renew();
        },
        Math.max(250, Math.floor(leaseMs / 3)),
      );
      renewalTimer.unref?.();
      try {
        return await operation();
      } finally {
        clearInterval(renewalTimer);
        // A Redis outage during cleanup cannot strand the work permanently;
        // the bounded TTL remains the safety net.
        await redis.eval(RELEASE_SCRIPT, 1, key, token).catch(() => undefined);
      }
    }

    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }

  const error = new Error('Tournament entry sync coordination lease timed out');
  error.name = 'TournamentEntrySyncLeaseTimeoutError';
  throw error;
}
