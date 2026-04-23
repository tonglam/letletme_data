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
