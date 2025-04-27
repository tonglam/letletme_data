import * as Eq from 'fp-ts/Eq';
import * as N from 'fp-ts/number';
import * as Ord from 'fp-ts/Ord';

export const formatLocalTime = (date?: Date): string => {
  if (!date) {
    return new Date().toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

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

export const formatYYYYMMDD = (date?: Date): string => {
  const d = date || new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0'); // Months are 0-indexed
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
};

// Helper to normalize a Date to the start of its day
export const normalizeDate = (date: Date): Date => {
  const newDate = new Date(date);
  newDate.setHours(0, 0, 0, 0);
  return newDate;
};

// Eq instance for comparing Dates based on getTime()
export const eqDate: Eq.Eq<Date> = Eq.contramap((date: Date) => date.getTime())(N.Eq);

// Ord instance for sorting Dates
export const ordDate: Ord.Ord<Date> = Ord.contramap((date: Date) => date.getTime())(N.Ord);
