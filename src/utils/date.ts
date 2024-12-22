/**
 * Formats a date to local time string
 * @param date - The date to format
 * @returns Formatted date string in local time
 */
export const formatLocalTime = (date: Date): string => {
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
};
