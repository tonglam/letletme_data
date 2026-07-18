import type { Job } from 'bullmq';
import { getConfig } from './config';
import { logError, logInfo, logWarn } from './logger';

export async function sendTelegramMessage(message: string): Promise<void> {
  const config = getConfig();
  const token = config.TELEGRAM_BOT_TOKEN;
  const chatId = config.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    logWarn('Telegram not configured — skipping notification', { message });
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    });

    if (!response.ok) {
      throw new Error(`Telegram API error: ${response.status} ${response.statusText}`);
    }

    logInfo('Telegram notification sent', { chatId, message });
  } catch (error) {
    logError('Failed to send Telegram notification', error, { message });
    throw error;
  }
}

export async function sendTelegramBotNotification(text: string): Promise<void> {
  const config = getConfig();
  const url = config.TELEGRAM_NOTIFICATION_URL;

  if (!url) {
    logWarn('Telegram bot notification URL not configured — skipping notification', { text });
    return;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'text', text }),
    });

    if (!response.ok) {
      throw new Error(`Telegram bot notification error: ${response.status} ${response.statusText}`);
    }

    logInfo('Telegram bot notification sent', { url });
  } catch (error) {
    logError('Failed to send Telegram bot notification', error, { url });
    throw error;
  }
}

export async function sendWeChatBotNotification(
  text: string,
  targets: readonly string[] = ['self'],
): Promise<void> {
  const config = getConfig();
  const url = config.WECHAT_NOTIFICATION_URL;

  if (!url) {
    logWarn('WeChat bot notification URL not configured — skipping notification', { text });
    return;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'text', targets, text }),
    });

    if (!response.ok) {
      throw new Error(`WeChat bot notification error: ${response.status} ${response.statusText}`);
    }

    logInfo('WeChat bot notification sent', { url, targetsCount: targets.length });
  } catch (error) {
    logError('Failed to send WeChat bot notification', error, { url });
    throw error;
  }
}

/**
 * Alert when a BullMQ job has exhausted all attempts. No-ops silently if
 * Telegram is not configured (plan FP-14d: alerting requires prod envs).
 */
export async function alertOnFinalFailure(job: Job, error: unknown): Promise<void> {
  const attempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < attempts) {
    return;
  }

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
export async function notifyTwoBots(text: string): Promise<void> {
  await sendTelegramBotNotification(text).catch(() => {});
  await sendWeChatBotNotification(text).catch(() => {});
}
