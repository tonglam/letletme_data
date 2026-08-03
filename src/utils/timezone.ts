export const CRON_TIMEZONE = 'Asia/Shanghai';

const utc8Formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function getPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) {
  return parts.find((part) => part.type === type)?.value ?? '00';
}

export function formatCronDateKey(date: Date = new Date()): string {
  const parts = utc8Formatter.formatToParts(date);
  return `${getPart(parts, 'year')}${getPart(parts, 'month')}${getPart(parts, 'day')}`;
}

export function formatCronCalendarDate(date: Date = new Date()): string {
  const dateKey = formatCronDateKey(date);
  return `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}`;
}

export function getCronMinute(date: Date = new Date()): number {
  const minute = Number.parseInt(getPart(utc8Formatter.formatToParts(date), 'minute'), 10);
  return Number.isFinite(minute) ? minute : 0;
}

/**
 * Format timestamp as ISO-like UTC+8 string.
 * Example: 2026-04-19T23:05:01.123+08:00
 */
export function formatUtc8Timestamp(date: Date = new Date()): string {
  const parts = utc8Formatter.formatToParts(date);
  const year = getPart(parts, 'year');
  const month = getPart(parts, 'month');
  const day = getPart(parts, 'day');
  const hour = getPart(parts, 'hour');
  const minute = getPart(parts, 'minute');
  const second = getPart(parts, 'second');
  const milliseconds = String(date.getUTCMilliseconds()).padStart(3, '0');

  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${milliseconds}+08:00`;
}
