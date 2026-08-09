import { randomUUID } from 'node:crypto';

import type { UnderstatSyncMode, UnderstatSyncTrigger } from '../domain/understat';
import { getUnderstatPlayerQueue } from '../queues/understat-player.queue';
import { getUnderstatTeamQueue } from '../queues/understat-team.queue';

export interface UnderstatSyncRequest {
  season: string;
  mode: UnderstatSyncMode;
  trigger: UnderstatSyncTrigger;
  teamIds?: number[];
  matchIds?: number[];
  runId?: string;
}

export async function enqueueUnderstatTeamSync(request: UnderstatSyncRequest) {
  const runId = request.runId ?? randomUUID();
  const job = await getUnderstatTeamQueue().add(
    'understat-team-discover',
    {
      runId,
      season: request.season,
      mode: request.mode,
      trigger: request.trigger,
      teamIds: request.teamIds,
    },
    { jobId: `understat-team-discover-${runId}` },
  );
  return { job, runId };
}

export async function enqueueUnderstatPlayerSync(request: UnderstatSyncRequest) {
  const runId = request.runId ?? randomUUID();
  const job = await getUnderstatPlayerQueue().add(
    'understat-player-discover',
    {
      runId,
      season: request.season,
      mode: request.mode,
      trigger: request.trigger,
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
  teamId: number;
  teamTitle: string;
}) {
  return getUnderstatTeamQueue().add('understat-team-detail', input, {
    jobId: `understat-team-detail-${input.runId}-${input.teamId}`,
  });
}

export async function enqueueUnderstatTeamFinalize(input: {
  runId: string;
  season: string;
  mode: UnderstatSyncMode;
  trigger: UnderstatSyncTrigger;
}) {
  return getUnderstatTeamQueue().add('understat-team-finalize', input, {
    jobId: `understat-team-finalize-${input.runId}`,
  });
}

export async function enqueueUnderstatPlayerTeamDetail(input: {
  runId: string;
  season: string;
  mode: UnderstatSyncMode;
  trigger: UnderstatSyncTrigger;
  resourceId: number;
  teamTitle: string;
}) {
  return getUnderstatPlayerQueue().add('understat-player-team-detail', input, {
    jobId: `understat-player-team-${input.runId}-${input.resourceId}`,
  });
}

export async function enqueueUnderstatPlayerMatch(input: {
  runId: string;
  season: string;
  mode: UnderstatSyncMode;
  trigger: UnderstatSyncTrigger;
  resourceId: number;
}) {
  return getUnderstatPlayerQueue().add('understat-player-match', input, {
    jobId: `understat-player-match-${input.runId}-${input.resourceId}`,
  });
}

export async function enqueueUnderstatPlayerFinalize(input: {
  runId: string;
  season: string;
  mode: UnderstatSyncMode;
  trigger: UnderstatSyncTrigger;
}) {
  return getUnderstatPlayerQueue().add('understat-player-finalize', input, {
    jobId: `understat-player-finalize-${input.runId}`,
  });
}
