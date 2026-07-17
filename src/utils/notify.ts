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
 * Best-effort fan-out: persistence should remain the source of truth.
 * This wrapper never throws; it logs per-channel failures.
 */
export async function notifyTwoBots(text: string): Promise<void> {
  await sendTelegramBotNotification(text).catch(() => {});
  await sendWeChatBotNotification(text).catch(() => {});
}

export type FinalFailureAlert = {
  queueName: string;
  jobName?: string;
  jobId?: string;
  attemptsMade?: number;
  attempts?: number;
  tier?: string;
  error: unknown;
};

/**
 * Telegram alert for jobs that exhausted all BullMQ attempts. Never throws and
 * never alerts for intermediate (retryable) failures — alerting must not turn a
 * worker 'failed' event into another failure, and noisy per-attempt pings would
 * bury the signal. No-op with a warn when TELEGRAM_* envs are unset.
 */
export async function alertOnFinalFailure(
  alert: FinalFailureAlert,
  send: (message: string) => Promise<void> = sendTelegramMessage,
): Promise<void> {
  const attemptsMade = alert.attemptsMade ?? 0;
  const attempts = Math.max(alert.attempts ?? 1, 1);
  if (attemptsMade < attempts) {
    return;
  }

  const errorMessage = alert.error instanceof Error ? alert.error.message : String(alert.error);
  const message = (
    `[letletme_data] Job permanently failed: ${alert.queueName}/${alert.jobName ?? 'unknown'} ` +
    `(id ${alert.jobId ?? 'unknown'}) after ${attemptsMade}/${attempts} attempts` +
    `${alert.tier ? ` [${alert.tier}]` : ''}: ${errorMessage}`
  ).slice(0, 900);

  try {
    await send(message);
  } catch (error) {
    logError('Failed to send final-failure alert', error, {
      queueName: alert.queueName,
      jobName: alert.jobName,
      jobId: alert.jobId,
    });
  }
}
