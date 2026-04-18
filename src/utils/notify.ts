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
