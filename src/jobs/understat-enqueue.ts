import { randomUUID } from 'node:crypto';

import type { UnderstatSyncMode, UnderstatSyncTrigger } from '../domain/understat';
import { getUnderstatPlayerQueue } from '../queues/understat-player.queue';
import { getUnderstatTeamQueue } from '../queues/understat-team.queue';
import { isQueueDrainOnly, QueueDrainOnlyError } from '../services/queue-governance.service';

async function assertUnderstatAdmission(queueName: string): Promise<void> {
  if (await isQueueDrainOnly(queueName)) throw new QueueDrainOnlyError(queueName);
}

export interface UnderstatSyncRequest {
  season: string;
  mode: UnderstatSyncMode;
  trigger: UnderstatSyncTrigger;
  obligationId?: string;
  obligationGeneration?: number;
  teamIds?: number[];
  matchIds?: number[];
  runId?: string;
}

export async function enqueueUnderstatTeamSync(request: UnderstatSyncRequest) {
  const queue = getUnderstatTeamQueue();
  await assertUnderstatAdmission(queue.name);
  const runId = request.runId ?? randomUUID();
  const job = await queue.add(
    'understat-team-discover',
    {
      runId,
      season: request.season,
      mode: request.mode,
      trigger: request.trigger,
      ...(request.obligationId ? { obligationId: request.obligationId } : {}),
      ...(request.obligationGeneration === undefined
        ? {}
        : { obligationGeneration: request.obligationGeneration }),
      teamIds: request.teamIds,
    },
    { jobId: `understat-team-discover-${runId}` },
  );
  return { job, runId };
}

export async function enqueueUnderstatPlayerSync(request: UnderstatSyncRequest) {
  const queue = getUnderstatPlayerQueue();
  await assertUnderstatAdmission(queue.name);
  const runId = request.runId ?? randomUUID();
  const job = await queue.add(
    'understat-player-discover',
    {
      runId,
      season: request.season,
      mode: request.mode,
      trigger: request.trigger,
      ...(request.obligationId ? { obligationId: request.obligationId } : {}),
      ...(request.obligationGeneration === undefined
        ? {}
        : { obligationGeneration: request.obligationGeneration }),
      teamIds: request.teamIds,
      matchIds: request.matchIds,
    },
    { jobId: `understat-player-discover-${runId}` },
  );
  return { job, runId };
}

export async function enqueueUnderstatTeamDetail(input: {
  runId: string;
  season: string;
  mode: UnderstatSyncMode;
  trigger: UnderstatSyncTrigger;
  obligationId?: string;
  obligationGeneration?: number;
  teamId: number;
  teamTitle: string;
}) {
  const queue = getUnderstatTeamQueue();
  await assertUnderstatAdmission(queue.name);
  return queue.add('understat-team-detail', input, {
    jobId: `understat-team-detail-${input.runId}-${input.teamId}`,
  });
}

export async function enqueueUnderstatTeamFinalize(input: {
  runId: string;
  season: string;
  mode: UnderstatSyncMode;
  trigger: UnderstatSyncTrigger;
  obligationId?: string;
  obligationGeneration?: number;
}) {
  const queue = getUnderstatTeamQueue();
  await assertUnderstatAdmission(queue.name);
  return queue.add('understat-team-finalize', input, {
    jobId: `understat-team-finalize-${input.runId}`,
  });
}

export async function enqueueUnderstatPlayerTeamDetail(input: {
  runId: string;
  season: string;
  mode: UnderstatSyncMode;
  trigger: UnderstatSyncTrigger;
  obligationId?: string;
  obligationGeneration?: number;
  resourceId: number;
  teamTitle: string;
}) {
  const queue = getUnderstatPlayerQueue();
  await assertUnderstatAdmission(queue.name);
  return queue.add('understat-player-team-detail', input, {
    jobId: `understat-player-team-${input.runId}-${input.resourceId}`,
  });
}

export async function enqueueUnderstatPlayerMatch(input: {
  runId: string;
  season: string;
  mode: UnderstatSyncMode;
  trigger: UnderstatSyncTrigger;
  obligationId?: string;
  obligationGeneration?: number;
  resourceId: number;
}) {
  const queue = getUnderstatPlayerQueue();
  await assertUnderstatAdmission(queue.name);
  return queue.add('understat-player-match', input, {
    jobId: `understat-player-match-${input.runId}-${input.resourceId}`,
  });
}

export async function enqueueUnderstatPlayerFinalize(input: {
  runId: string;
  season: string;
  mode: UnderstatSyncMode;
  trigger: UnderstatSyncTrigger;
  obligationId?: string;
  obligationGeneration?: number;
}) {
  const queue = getUnderstatPlayerQueue();
  await assertUnderstatAdmission(queue.name);
  return queue.add('understat-player-finalize', input, {
    jobId: `understat-player-finalize-${input.runId}`,
  });
}
