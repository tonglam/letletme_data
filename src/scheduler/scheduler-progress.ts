import { randomUUID } from 'node:crypto';

import { queueRedisSingleton } from '../queues/redis';
import { getConfig } from '../utils/config';
import { logError } from '../utils/logger';

export type SchedulerProgress = Readonly<{
  releaseSha: string;
  passId: string;
  passStartedAt: string;
  currentStage: string;
  stageStartedAt: string;
  lastCompletedPassAt: string | null;
  lastCompletedDurationMs: number | null;
  dueCount: number;
  lateCount: number;
  oldestUnfinishedDueAt: string | null;
  claimedCount: number;
  generationRecoveryCount: number;
  leaseRecoveryCount: number;
  lastPassErrorCode: string | null;
}>;

export const SCHEDULER_PROGRESS_KEY = 'ops:scheduler-progress';
export const SCHEDULER_PROGRESS_TTL_SECONDS = 180;
export const SCHEDULER_PROGRESS_STALE_AFTER_MS = 90_000;

function releaseSha(): string {
  return process.env.DEPLOY_SHA?.trim() || process.env.GIT_SHA?.trim() || 'unknown';
}

export function createSchedulerProgress(now = new Date()): SchedulerProgress {
  const iso = now.toISOString();
  return {
    releaseSha: releaseSha(),
    passId: randomUUID(),
    passStartedAt: iso,
    currentStage: 'initializing',
    stageStartedAt: iso,
    lastCompletedPassAt: null,
    lastCompletedDurationMs: null,
    dueCount: 0,
    lateCount: 0,
    oldestUnfinishedDueAt: null,
    claimedCount: 0,
    generationRecoveryCount: 0,
    leaseRecoveryCount: 0,
    lastPassErrorCode: null,
  };
}

export function advanceSchedulerProgress(
  progress: SchedulerProgress,
  stage: string,
  patch: Partial<SchedulerProgress> = {},
  now = new Date(),
): SchedulerProgress {
  return {
    ...progress,
    ...patch,
    currentStage: stage,
    stageStartedAt: now.toISOString(),
  };
}

export function completeSchedulerProgress(
  progress: SchedulerProgress,
  now = new Date(),
): SchedulerProgress {
  return {
    ...progress,
    currentStage: 'completed',
    stageStartedAt: now.toISOString(),
    lastCompletedPassAt: now.toISOString(),
    lastCompletedDurationMs: Math.max(0, now.getTime() - Date.parse(progress.passStartedAt)),
  };
}

export function isSchedulerProgressHealthy(
  progress: Pick<SchedulerProgress, 'lastCompletedPassAt' | 'currentStage' | 'stageStartedAt'>,
  now = Date.now(),
): boolean {
  const completed = progress.lastCompletedPassAt
    ? Date.parse(progress.lastCompletedPassAt)
    : Number.NaN;
  const stageStarted = Date.parse(progress.stageStartedAt);
  const completedFresh =
    Number.isFinite(completed) && now - completed <= SCHEDULER_PROGRESS_STALE_AFTER_MS;
  const stageFresh =
    Number.isFinite(stageStarted) && now - stageStarted <= SCHEDULER_PROGRESS_STALE_AFTER_MS;
  return completedFresh && stageFresh;
}

export async function writeSchedulerProgress(progress: SchedulerProgress): Promise<void> {
  const redis = await queueRedisSingleton.getClient();
  const ttl = Math.max(
    30,
    Math.min(900, getConfig().QUEUE_HEALTH_SNAPSHOT_TTL_SECONDS || SCHEDULER_PROGRESS_TTL_SECONDS),
  );
  await redis.set(SCHEDULER_PROGRESS_KEY, JSON.stringify(progress), 'EX', ttl);
}

export async function readSchedulerProgress(): Promise<SchedulerProgress | null> {
  try {
    const redis = await queueRedisSingleton.getClient();
    const raw = await redis.get(SCHEDULER_PROGRESS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SchedulerProgress>;
    if (
      typeof parsed.passId !== 'string' ||
      typeof parsed.passStartedAt !== 'string' ||
      typeof parsed.currentStage !== 'string' ||
      typeof parsed.stageStartedAt !== 'string'
    ) {
      return null;
    }
    return parsed as SchedulerProgress;
  } catch (error) {
    logError('Scheduler progress read failed', error);
    return null;
  }
}

/** Best-effort progress writes must never stop an otherwise independent pass. */
export async function tryWriteSchedulerProgress(progress: SchedulerProgress): Promise<void> {
  try {
    await writeSchedulerProgress(progress);
  } catch (error) {
    logError('Scheduler progress write failed', error, { passId: progress.passId });
  }
}
