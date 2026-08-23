import { createHash } from 'node:crypto';
import type { Job } from 'bullmq';
import { getConfig } from './config';
import { logError, logInfo, logWarn } from './logger';
import { isTerminalJobFailure } from './worker-failure';

export type NotificationDeliveryResult = 'sent' | 'skipped';

export type WeChatNotificationOptions = {
  idempotencyKey?: string;
  timeoutMs?: number;
};

export type TelegramNotificationOptions = {
  timeoutMs?: number;
};

const TELEGRAM_NOTIFICATION_TIMEOUT_MS = 10_000;

export class WeChatNotificationError extends Error {
  readonly status?: number;
  readonly category:
    | 'authentication'
    | 'conflict'
    | 'rate_limited'
    | 'server'
    | 'timeout'
    | 'network'
    | 'rejected';
  readonly requestId?: string;

  constructor(
    category: WeChatNotificationError['category'],
    message: string,
    options: { status?: number; requestId?: string } = {},
  ) {
    super(message);
    this.name = 'WeChatNotificationError';
    this.category = category;
    this.status = options.status;
    this.requestId = options.requestId;
  }
}

/** The provider answered with a definite rejection; no message was accepted. */
export class NotificationDeliveryRejectedError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string) {
    super(`Telegram API error: ${status} ${statusText}`);
    this.name = 'NotificationDeliveryRejectedError';
    this.status = status;
  }
}

export async function sendTelegramMessage(
  message: string,
  options: TelegramNotificationOptions = {},
): Promise<NotificationDeliveryResult> {
  const config = getConfig();
  const token = config.TELEGRAM_BOT_TOKEN;
  const chatId = config.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    logWarn('Telegram not configured — skipping notification', { messageLength: message.length });
    return 'skipped';
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
      signal: AbortSignal.timeout(options.timeoutMs ?? TELEGRAM_NOTIFICATION_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new NotificationDeliveryRejectedError(response.status, response.statusText);
    }

    logInfo('Telegram notification sent', { messageLength: message.length });
    return 'sent';
  } catch (error) {
    logError('Failed to send Telegram notification', error, { messageLength: message.length });
    throw error;
  }
}

export async function sendTelegramBotNotification(
  text: string,
  options: TelegramNotificationOptions = {},
): Promise<void> {
  const config = getConfig();
  const url = config.TELEGRAM_NOTIFICATION_URL;

  if (!url) {
    logWarn('Telegram bot notification URL not configured — skipping notification', {
      textLength: text.length,
    });
    return;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'text', text }),
      signal: AbortSignal.timeout(options.timeoutMs ?? TELEGRAM_NOTIFICATION_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Telegram bot notification error: ${response.status} ${response.statusText}`);
    }

    logInfo('Telegram bot notification sent');
  } catch (error) {
    logError('Failed to send Telegram bot notification', error);
    throw error;
  }
}

export async function sendWeChatBotNotification(
  text: string,
  targets: readonly string[] = ['self'],
  options: WeChatNotificationOptions = {},
): Promise<void> {
  const config = getConfig();
  const url = config.WECHAT_NOTIFICATION_URL;

  if (!url) {
    logWarn('WeChat bot notification URL not configured — skipping notification', {
      messageLength: text.length,
    });
    return;
  }

  if (!config.WECHAT_NOTIFICATION_API_TOKEN) {
    throw new WeChatNotificationError(
      'authentication',
      'WeChat notification token is not configured.',
    );
  }
  const idempotencyKey = options.idempotencyKey ?? stableNotificationKey(text, targets);
  if (!/^[\x21-\x7e]{8,128}$/.test(idempotencyKey)) {
    throw new WeChatNotificationError(
      'rejected',
      'WeChat notification idempotency key is invalid.',
    );
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.WECHAT_NOTIFICATION_API_TOKEN}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ type: 'text', targets, text }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });

    if (!response.ok) {
      const requestId = response.headers.get('x-request-id') ?? undefined;
      const category =
        response.status === 401
          ? 'authentication'
          : response.status === 409
            ? 'conflict'
            : response.status === 429
              ? 'rate_limited'
              : response.status >= 500
                ? 'server'
                : 'rejected';
      throw new WeChatNotificationError(
        category,
        `WeChat notification rejected (${response.status}).`,
        { status: response.status, requestId },
      );
    }

    logInfo('WeChat bot notification sent', {
      targetsCount: targets.length,
      requestId: response.headers.get('x-request-id') ?? undefined,
      idempotencyKey,
    });
  } catch (error) {
    const classified =
      error instanceof WeChatNotificationError
        ? error
        : error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
          ? new WeChatNotificationError('timeout', 'WeChat notification timed out.')
          : new WeChatNotificationError('network', 'WeChat notification network failure.');
    logError('Failed to send WeChat bot notification', classified, {
      category: classified.category,
      status: classified.status,
      requestId: classified.requestId,
      idempotencyKey,
    });
    throw classified;
  }
}

function stableNotificationKey(text: string, targets: readonly string[]): string {
  const scheduledRunUtcMinute = new Date().toISOString().slice(0, 16);
  return `data-notify:${createHash('sha256').update(JSON.stringify({ text, targets, scheduledRunUtcMinute })).digest('hex')}`;
}

/**
 * Alert when a BullMQ job has exhausted all attempts. No-ops silently if
 * Telegram is not configured (plan FP-14d: alerting requires prod envs).
 */
export async function alertOnFinalFailure(job: Job, error: unknown): Promise<void> {
  if (!isTerminalJobFailure(job, error)) {
    return;
  }
  const attempts = job.opts.attempts ?? 1;

  const config = getConfig();
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
    logWarn('Final failure alert skipped — Telegram not configured', {
      jobId: job.id,
      jobName: job.name,
      queueName: job.queueName,
    });
    return;
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  const text = [
    '🚨 Job permanently failed',
    `Queue: ${job.queueName}`,
    `Job: ${job.name}`,
    `ID: ${job.id}`,
    `Attempts: ${job.attemptsMade}/${attempts}`,
    `Error: ${errorMessage}`,
  ].join('\n');

  try {
    await sendTelegramMessage(text);
  } catch (sendError) {
    logError('Failed to send final failure alert', sendError, {
      jobId: job.id,
      jobName: job.name,
      queueName: job.queueName,
    });
  }
}

/**
 * Best-effort fan-out: persistence should remain the source of truth.
 * This wrapper never throws; it logs per-channel failures.
 */
export async function notifyTwoBots(
  text: string,
  options: WeChatNotificationOptions = {},
): Promise<void> {
  await Promise.all([
    sendTelegramBotNotification(text, { timeoutMs: options.timeoutMs }).catch((error) =>
      logWarn('Telegram secondary notification failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
    sendWeChatBotNotification(text, ['self'], options).catch((error) =>
      logWarn('WeChat secondary notification failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
  ]);
}
