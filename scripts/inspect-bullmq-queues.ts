/**
 * Inspect BullMQ queue depths and optionally locate a job by id across all app queues.
 *
 * Run on the VPS (uses `.env.deploy` via compose):
 *   docker compose exec -T api bun scripts/inspect-bullmq-queues.ts
 *   docker compose exec -T api bun scripts/inspect-bullmq-queues.ts 662
 *
 * Requires full app env (DATABASE_URL, Redis / queue vars) because getQueueConnection uses getConfig().
 */
/* eslint-disable no-console -- CLI introspection output */
import 'dotenv/config';

import { Queue } from 'bullmq';

import { getQueueConnection } from '../src/utils/queue';

const QUEUE_BASES = [
  'data-sync',
  'live-data',
  'entry-sync',
  'league-sync',
  'tournament-sync',
  'tournament-setup',
  'understat-team-sync',
  'understat-player-sync',
] as const;

async function main(): Promise<void> {
  const jobIdArg = process.argv[2];
  const connection = getQueueConnection();

  console.log(
    JSON.stringify(
      {
        redis: {
          host: connection.host,
          port: connection.port,
          db: connection.db ?? 0,
        },
      },
      null,
      2,
    ),
  );

  const names = [...QUEUE_BASES];

  for (const name of names) {
    const queue = new Queue(name, { connection });
    const counts = await queue.getJobCounts(
      'waiting',
      'paused',
      'active',
      'delayed',
      'completed',
      'failed',
      'prioritized',
    );
    console.log(JSON.stringify({ queue: name, counts }, null, 2));

    if (jobIdArg) {
      const job = await queue.getJob(jobIdArg);
      if (job) {
        const state = await job.getState();
        const raw = job.toJSON();
        console.log(
          JSON.stringify(
            {
              queue: name,
              jobId: job.id,
              state,
              name: raw.name,
              attemptsMade: raw.attemptsMade,
              timestamp: raw.timestamp,
              processedOn: raw.processedOn,
              finishedOn: raw.finishedOn,
              failedReason: raw.failedReason,
            },
            null,
            2,
          ),
        );
      }
    }

    await queue.close();
  }

  if (jobIdArg) {
    console.log(
      '(If the job was not printed above, it was not found in these queues or was removed by its retention policy.)',
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
