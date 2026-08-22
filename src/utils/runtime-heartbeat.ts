import { queueRedisSingleton } from '../queues/redis';
import { logError } from './logger';

export const RUNTIME_HEARTBEAT_TTL_SECONDS = 120;
export const RUNTIME_HEARTBEAT_MAX_AGE_MS = 90_000;

export type RuntimeRole = 'scheduler' | 'queueWorker' | 'contentWorker';
export type RuntimeHeartbeat = Readonly<{
  role: RuntimeRole;
  releaseSha: string;
  lastSeenAt: string;
}>;

function heartbeatKey(role: RuntimeRole): string {
  return `ops:runtime-heartbeat:${role}`;
}

function releaseRevision(): string {
  return (
    process.env.DEPLOY_SHA?.trim() ||
    process.env.GIT_SHA?.trim() ||
    process.env.CONTENT_MANIFEST_GIT_REVISION?.trim() ||
    'unknown'
  );
}

export async function writeRuntimeHeartbeat(role: RuntimeRole): Promise<void> {
  const redis = await queueRedisSingleton.getClient();
  await redis.set(
    heartbeatKey(role),
    JSON.stringify({ role, releaseSha: releaseRevision(), lastSeenAt: new Date().toISOString() }),
    'EX',
    RUNTIME_HEARTBEAT_TTL_SECONDS,
  );
}

export async function checkRuntimeHeartbeat(role: RuntimeRole): Promise<boolean> {
  const heartbeat = await readRuntimeHeartbeat(role);
  if (!heartbeat) return false;
  const lastSeen = new Date(heartbeat.lastSeenAt).getTime();
  return Number.isFinite(lastSeen) && Date.now() - lastSeen <= RUNTIME_HEARTBEAT_MAX_AGE_MS;
}

export async function readRuntimeHeartbeat(role: RuntimeRole): Promise<RuntimeHeartbeat | null> {
  try {
    const redis = await queueRedisSingleton.getClient();
    const raw = await redis.get(heartbeatKey(role));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RuntimeHeartbeat>;
    if (
      parsed.role !== role ||
      typeof parsed.releaseSha !== 'string' ||
      typeof parsed.lastSeenAt !== 'string'
    ) {
      return null;
    }
    return parsed as RuntimeHeartbeat;
  } catch (error) {
    logError('Runtime heartbeat probe failed', error, { role });
    return null;
  }
}

export function startRuntimeHeartbeat(role: RuntimeRole, intervalMs = 30_000): () => void {
  void writeRuntimeHeartbeat(role).catch((error) =>
    logError('Runtime heartbeat write failed', error, { role }),
  );
  const timer = setInterval(() => {
    void writeRuntimeHeartbeat(role).catch((error) =>
      logError('Runtime heartbeat write failed', error, { role }),
    );
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
