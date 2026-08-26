import { randomUUID } from 'node:crypto';

/**
 * Queue-run IDs are persisted in UUID columns by coordinated sync stages.
 * Keeping generation in a small dependency-free helper makes the database
 * contract explicit and easy to exercise without booting a worker runtime.
 */
export function createQueueRunAttemptId(): string {
  return randomUUID();
}
