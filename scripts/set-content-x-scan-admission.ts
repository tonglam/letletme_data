import {
  readQueueAdmission,
  setQueueAdmission,
  type QueueAdmission,
  type QueueAdmissionMode,
} from '../src/services/queue-governance.service';
import { queueRedisSingleton } from '../src/queues/redis';

export const CONTENT_X_SCAN_QUEUE = 'content-x-scan' as const;
export const DEPLOY_QUEUE_ADMISSION_TTL_SECONDS = 900;
export const DEPLOY_QUEUE_ADMISSION_REASON = 'DEPLOY_QUEUE_QUIESCENCE';
export const DEPLOY_QUEUE_ADMISSION_ACTOR = 'deployment';

export type ContentXScanAdmissionArguments = Readonly<{
  mode: QueueAdmissionMode;
}>;

function usage(): never {
  throw new Error('usage: bun scripts/set-content-x-scan-admission.ts --mode DRAIN_ONLY|OPEN');
}

export function parseContentXScanAdmissionArguments(
  argv: readonly string[],
): ContentXScanAdmissionArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) usage();
    const separator = token.indexOf('=');
    if (separator > 2) {
      const key = token.slice(2, separator);
      if (key !== 'mode' || values.has(key)) usage();
      values.set(key, token.slice(separator + 1));
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (key !== 'mode' || !value || value.startsWith('--') || values.has(key)) usage();
    values.set(key, value);
    index += 1;
  }

  const mode = values.get('mode');
  if (mode !== 'DRAIN_ONLY' && mode !== 'OPEN') usage();
  return { mode };
}

function isDeploymentAdmission(admission: QueueAdmission | null): boolean {
  return (
    admission?.mode === 'DRAIN_ONLY' &&
    admission.changedBy === DEPLOY_QUEUE_ADMISSION_ACTOR &&
    admission.reasonCode === DEPLOY_QUEUE_ADMISSION_REASON
  );
}

function summary(input: {
  mode: QueueAdmissionMode;
  changed: boolean;
  admission: QueueAdmission | null;
  previousMode: QueueAdmissionMode | null;
}) {
  return {
    contractVersion: 'queue-admission-v2',
    queueName: CONTENT_X_SCAN_QUEUE,
    mode: input.mode,
    changed: input.changed,
    previousMode: input.previousMode,
    admission: input.admission
      ? {
          mode: input.admission.mode,
          expiresAt: input.admission.expiresAt,
          reasonCode: input.admission.reasonCode,
          changedBy: input.admission.changedBy,
        }
      : null,
  };
}

async function applyAdmission(args: ContentXScanAdmissionArguments) {
  const existing = await readQueueAdmission(CONTENT_X_SCAN_QUEUE);
  const previousMode = existing?.mode ?? null;

  if (
    args.mode === 'DRAIN_ONLY' &&
    existing?.mode === 'DRAIN_ONLY' &&
    !isDeploymentAdmission(existing)
  ) {
    return summary({
      mode: args.mode,
      changed: false,
      admission: existing,
      previousMode,
    });
  }

  if (args.mode === 'OPEN' && existing?.mode === 'DRAIN_ONLY' && !isDeploymentAdmission(existing)) {
    return summary({
      mode: args.mode,
      changed: false,
      admission: existing,
      previousMode,
    });
  }

  const admission = await setQueueAdmission({
    queueName: CONTENT_X_SCAN_QUEUE,
    mode: args.mode,
    ttlSeconds: DEPLOY_QUEUE_ADMISSION_TTL_SECONDS,
    reasonCode: DEPLOY_QUEUE_ADMISSION_REASON,
    changedBy: DEPLOY_QUEUE_ADMISSION_ACTOR,
  });
  return summary({
    mode: args.mode,
    changed: true,
    admission,
    previousMode,
  });
}

async function main(): Promise<void> {
  const args = parseContentXScanAdmissionArguments(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(await applyAdmission(args))}\n`);
}

if (import.meta.main) {
  try {
    await main();
  } finally {
    await queueRedisSingleton.disconnect();
  }
}
