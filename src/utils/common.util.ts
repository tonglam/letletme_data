import { Prisma } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';

export const safeStringToNumber = (s: string | null | undefined): O.Option<number> =>
  pipe(
    O.fromNullable(s),
    O.map(parseFloat),
    O.filter((n) => !isNaN(n)),
  );

export const safeStringToDecimal = (s: string | null | undefined): O.Option<Prisma.Decimal> =>
  pipe(
    safeStringToNumber(s),
    O.map((n) => new Prisma.Decimal(n)),
  );

export enum Season {
  Season_1617 = '1617',
  Season_1718 = '1718',
  Season_1819 = '1819',
  Season_1920 = '1920',
  Season_2021 = '2021',
  Season_2122 = '2122',
  Season_2223 = '2223',
  Season_2324 = '2324',
  Season_2425 = '2425',
}

export const getCurrentSeason = (): string => {
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1;

  const startYear = currentMonth >= 8 ? currentYear : currentYear - 1;
  const endYear = startYear + 1;
  const startYearStr = startYear.toString().slice(-2);
  const endYearStr = endYear.toString().slice(-2);
  return `${startYearStr}${endYearStr}`;
};

export const getAllSeasons = (): Season[] => Object.values(Season);
