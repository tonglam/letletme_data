import { randomUUID } from 'node:crypto';

import type { UnderstatSyncMode, UnderstatSyncTrigger } from '../domain/understat';
import { understatPlayerQueue } from '../queues/understat-player.queue';
import { understatTeamQueue } from '../queues/understat-team.queue';

export interface UnderstatSyncRequest {
  season: string;
  mode: UnderstatSyncMode;
  trigger: UnderstatSyncTrigger;
  teamIds?: number[];
  matchIds?: number[];
  participantsOnly?: boolean;
  runId?: string;
}

export async function enqueueUnderstatTeamSync(request: UnderstatSyncRequest) {
  const runId = request.runId ?? randomUUID();
  const job = await understatTeamQueue.add(
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
  const job = await understatPlayerQueue.add(
    'understat-player-discover',
    {
      runId,
      season: request.season,
      mode: request.mode,
      trigger: request.trigger,
      teamIds: request.teamIds,
      matchIds: request.matchIds,
      participantsOnly: request.participantsOnly,
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
  return understatTeamQueue.add('understat-team-detail', input, {
    jobId: `understat-team-detail-${input.runId}-${input.teamId}`,
  });
}

export async function enqueueUnderstatTeamPublish(input: {
  runId: string;
  season: string;
  mode: UnderstatSyncMode;
  trigger: UnderstatSyncTrigger;
}) {
  return understatTeamQueue.add('understat-team-publish', input, {
    jobId: `understat-team-publish-${input.runId}`,
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
  return understatPlayerQueue.add('understat-player-team-detail', input, {
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
  return understatPlayerQueue.add('understat-player-match', input, {
    jobId: `understat-player-match-${input.runId}-${input.resourceId}`,
  });
}

export async function enqueueUnderstatPlayerPublish(input: {
  runId: string;
  season: string;
  mode: UnderstatSyncMode;
  trigger: UnderstatSyncTrigger;
}) {
  return understatPlayerQueue.add('understat-player-publish', input, {
    jobId: `understat-player-publish-${input.runId}`,
  });
}
