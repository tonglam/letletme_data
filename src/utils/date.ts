/**
 * Date utility functions
 * @module utils/date
 */

/**
 * Formats a date to YYYY-MM-DD HH:MM:SS ms format in local timezone
 * @param date The date to format
 * @returns Formatted date string
 */
export const formatLocalTime = (date: Date): string => {
  const pad = (num: number, size: number = 2): string => num.toString().padStart(size, '0');
  
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const milliseconds = pad(date.getMilliseconds(), 3);

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} ${milliseconds}`;
};
