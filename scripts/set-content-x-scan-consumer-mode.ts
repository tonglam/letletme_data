/* eslint-disable no-console */

import { Queue } from 'bullmq';

import { getQueueConnection } from '../src/utils/queue';

export const CONTENT_X_SCAN_QUEUE = 'content-x-scan' as const;
export const CONTENT_X_CONSUMER_CONTRACT_VERSION = 'content-x-consumer-v1' as const;

export type ContentXScanConsumerMode = 'STATUS' | 'PAUSE' | 'RESUME';

function usage(): never {
  throw new Error(
    'usage: bun scripts/set-content-x-scan-consumer-mode.ts --mode STATUS|PAUSE|RESUME',
  );
}

export function parseContentXScanConsumerModeArguments(argv: readonly string[]): {
  mode: ContentXScanConsumerMode;
} {
  if (argv.length !== 2 || argv[0] !== '--mode') usage();
  const mode = argv[1];
  if (mode !== 'STATUS' && mode !== 'PAUSE' && mode !== 'RESUME') usage();
  return { mode };
}

export async function setContentXScanConsumerMode(mode: ContentXScanConsumerMode): Promise<{
  contractVersion: typeof CONTENT_X_CONSUMER_CONTRACT_VERSION;
  queueName: typeof CONTENT_X_SCAN_QUEUE;
  mode: ContentXScanConsumerMode;
  previousPaused: boolean;
  paused: boolean;
  changed: boolean;
}> {
  const queue = new Queue(CONTENT_X_SCAN_QUEUE, { connection: getQueueConnection() });
  try {
    const previousPaused = await queue.isPaused();
    if (mode === 'PAUSE' && !previousPaused) await queue.pause();
    if (mode === 'RESUME' && previousPaused) await queue.resume();
    const paused = await queue.isPaused();
    const expectedPaused = mode === 'PAUSE' || (mode === 'STATUS' && previousPaused);
    if (mode !== 'STATUS' && paused !== expectedPaused) {
      throw new Error(`Content X consumer did not reach requested mode: ${mode}`);
    }
    return {
      contractVersion: CONTENT_X_CONSUMER_CONTRACT_VERSION,
      queueName: CONTENT_X_SCAN_QUEUE,
      mode,
      previousPaused,
      paused,
      changed: previousPaused !== paused,
    };
  } finally {
    await queue.close();
  }
}

if (import.meta.main) {
  try {
    const { mode } = parseContentXScanConsumerModeArguments(process.argv.slice(2));
    console.log(JSON.stringify(await setContentXScanConsumerMode(mode)));
  } catch (error) {
    console.error('[content-x-consumer] failed', error);
    process.exitCode = 1;
  }
}
