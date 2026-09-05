import { Queue, type JobType } from 'bullmq';
import { sql } from 'drizzle-orm';

import { databaseSingleton, getDb } from '../src/db/singleton';
import { allQueueNames } from '../src/queues/names';
import { schedulerRecoveryBullJobIds } from '../src/scheduler/scheduler-enqueue-recovery';
import { getQueueConnection } from '../src/utils/queue';

const TERMINAL = ['succeeded', 'skipped', 'irrecoverable'] as const;
const JOB_TYPES: JobType[] = [
  'waiting',
  'waiting-children',
  'delayed',
  'prioritized',
  'active',
  'paused',
  'completed',
  'failed',
];

type Candidate = Readonly<{
  obligationId: string;
  generation: number;
  scopeKey: string;
  attempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | string | null;
  runId: string | null;
  bullJobId: string | null;
}>;

function parseArgs(argv: readonly string[]) {
  const apply = argv.includes('--apply');
  const expectedIndex = argv.indexOf('--expected-count');
  const expectedCount = expectedIndex < 0 ? null : Number(argv[expectedIndex + 1]);
  if (
    apply &&
    (expectedCount === null || !Number.isSafeInteger(expectedCount) || expectedCount < 0)
  ) {
    throw new Error('--apply requires --expected-count N');
  }
  return { apply, expectedCount };
}

async function listCandidates(db: Awaited<ReturnType<typeof getDb>>): Promise<Candidate[]> {
  const rows = await db.execute<Candidate>(sql`
    SELECT obligation_id AS "obligationId", generation, scope_key AS "scopeKey",
      attempts, lease_owner AS "leaseOwner", lease_expires_at AS "leaseExpiresAt",
      run_id AS "runId", bull_job_id AS "bullJobId"
    FROM ops.scheduler_obligations
    WHERE job_name = 'player-stats-active'
      AND status NOT IN (${sql.join(
        TERMINAL.map((status) => sql`${status}`),
        sql`, `,
      )})
    ORDER BY obligation_id
  `);
  return rows.map((row) => ({
    ...row,
    generation: Number(row.generation),
    attempts: Number(row.attempts),
  }));
}

async function bullJobsForCandidates(candidates: readonly Candidate[]): Promise<string[]> {
  if (candidates.length === 0) return [];
  const expectedIds = new Set(
    candidates.flatMap((candidate) => schedulerRecoveryBullJobIds(candidate)),
  );
  const found: string[] = [];
  const connection = getQueueConnection();
  for (const queueName of allQueueNames) {
    const queue = new Queue(queueName, { connection });
    try {
      const direct = await Promise.all([...expectedIds].map((id) => queue.getJob(id)));
      for (const job of direct) if (job) found.push(`${queueName}:${String(job.id)}`);
      const jobs = await queue.getJobs(JOB_TYPES, 0, -1, false);
      for (const job of jobs) {
        const data = job.data as Record<string, unknown> | undefined;
        if (
          typeof data?.obligationId === 'string' &&
          candidates.some((candidate) => candidate.obligationId === data.obligationId)
        ) {
          found.push(`${queueName}:${String(job.id)}`);
        }
      }
    } finally {
      await queue.close();
    }
  }
  return [...new Set(found)].sort();
}

function assertCandidateSafe(
  candidate: Candidate,
  laneRefs: readonly string[],
  bullJobs: readonly string[],
) {
  if (candidate.attempts !== 0) throw new Error(`${candidate.obligationId}: attempts must be zero`);
  if (candidate.leaseOwner !== null || candidate.leaseExpiresAt !== null) {
    throw new Error(`${candidate.obligationId}: lease is still present`);
  }
  if (candidate.runId !== null || candidate.bullJobId !== null) {
    throw new Error(`${candidate.obligationId}: run or Bull job reference is still present`);
  }
  if (laneRefs.length > 0)
    throw new Error(`${candidate.obligationId}: scheduler lane reference exists`);
  if (bullJobs.length > 0)
    throw new Error(`${candidate.obligationId}: Bull job exists: ${bullJobs.join(',')}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = await getDb();
  const candidates = await listCandidates(db);
  if (args.expectedCount !== null && candidates.length !== args.expectedCount) {
    throw new Error(`expected ${args.expectedCount} candidates, found ${candidates.length}`);
  }
  const bullJobs = await bullJobsForCandidates(candidates);
  const laneRows =
    candidates.length === 0
      ? []
      : await db.execute<{ obligation_id: string }>(sql`
          SELECT desired_obligation_id AS obligation_id
          FROM ops.scheduler_lanes
          WHERE desired_obligation_id IN (${sql.join(
            candidates.map((candidate) => sql`${candidate.obligationId}`),
            sql`, `,
          )})
          UNION
          SELECT active_obligation_id AS obligation_id
          FROM ops.scheduler_lanes
          WHERE active_obligation_id IN (${sql.join(
            candidates.map((candidate) => sql`${candidate.obligationId}`),
            sql`, `,
          )})
        `);
  for (const candidate of candidates) {
    const laneRefs = laneRows
      .filter((row) => row.obligation_id === candidate.obligationId)
      .map(() => candidate.obligationId);
    assertCandidateSafe(
      candidate,
      laneRefs,
      bullJobs.filter((job) => job.includes(candidate.obligationId)),
    );
  }

  if (args.apply && candidates.length > 0) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtextextended('retire:player-stats-active', 0))
      `);
      const locked = await tx.execute<Candidate>(sql`
        SELECT obligation_id AS "obligationId", generation, scope_key AS "scopeKey",
          attempts, lease_owner AS "leaseOwner", lease_expires_at AS "leaseExpiresAt",
          run_id AS "runId", bull_job_id AS "bullJobId"
        FROM ops.scheduler_obligations
        WHERE job_name = 'player-stats-active'
          AND status NOT IN (${sql.join(
            TERMINAL.map((status) => sql`${status}`),
            sql`, `,
          )})
        ORDER BY obligation_id
        FOR UPDATE
      `);
      const candidateIdentity = candidates
        .map((candidate) => `${candidate.obligationId}:${candidate.generation}`)
        .sort()
        .join('|');
      const lockedIdentity = locked
        .map((candidate) => `${candidate.obligationId}:${Number(candidate.generation)}`)
        .sort()
        .join('|');
      if (locked.length !== candidates.length || lockedIdentity !== candidateIdentity)
        throw new Error('candidate set changed before apply');
      for (const candidate of locked) {
        if (
          Number(candidate.attempts) !== 0 ||
          candidate.leaseOwner !== null ||
          candidate.leaseExpiresAt !== null ||
          candidate.runId !== null ||
          candidate.bullJobId !== null
        ) {
          throw new Error(`${candidate.obligationId}: safety assertion changed before apply`);
        }
      }
      const lockedLaneRefs = await tx.execute<{ obligation_id: string }>(sql`
        SELECT desired_obligation_id AS obligation_id
        FROM ops.scheduler_lanes
        WHERE desired_obligation_id IN (${sql.join(
          candidates.map((candidate) => sql`${candidate.obligationId}`),
          sql`, `,
        )})
        UNION
        SELECT active_obligation_id AS obligation_id
        FROM ops.scheduler_lanes
        WHERE active_obligation_id IN (${sql.join(
          candidates.map((candidate) => sql`${candidate.obligationId}`),
          sql`, `,
        )})
      `);
      if (lockedLaneRefs.length > 0)
        throw new Error('scheduler lane reference appeared before apply');
      const lockedBullJobs = await bullJobsForCandidates(locked);
      if (lockedBullJobs.length > 0)
        throw new Error(`Bull job appeared before apply: ${lockedBullJobs.join(',')}`);
      await tx.execute(sql`
        UPDATE ops.scheduler_obligations
        SET status = 'skipped', completed_at = clock_timestamp(), last_error = NULL,
          evidence = evidence || jsonb_build_object('retirementReason', 'legacy-job-retired'),
          updated_at = clock_timestamp()
        WHERE job_name = 'player-stats-active'
          AND status NOT IN (${sql.join(
            TERMINAL.map((status) => sql`${status}`),
            sql`, `,
          )})
          AND attempts = 0 AND lease_owner IS NULL AND lease_expires_at IS NULL
          AND run_id IS NULL AND bull_job_id IS NULL
      `);
    });
  }
  process.stdout.write(
    `${JSON.stringify({ ...args, count: candidates.length, candidates, bullJobs })}\n`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } finally {
    await databaseSingleton.disconnect();
  }
}
