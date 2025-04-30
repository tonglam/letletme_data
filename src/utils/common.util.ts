import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as RA from 'fp-ts/ReadonlyArray';
import { EntryId, validateEntryId } from 'types/domain/entry-info.type';

export const safeStringToNumber = (s: string | null | undefined): O.Option<number> =>
  pipe(
    O.fromNullable(s),
    O.map(parseFloat),
    O.filter((n) => !isNaN(n)),
  );

export const safeStringToDecimal = (s: string | null | undefined): O.Option<string> =>
  pipe(
    safeStringToNumber(s),
    O.map((n) => n.toFixed(2)),
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

export const parseAndValidateEntryIds = (idsString: string | undefined): ReadonlyArray<EntryId> => {
  if (!idsString) {
    return [];
  }
  return pipe(
    idsString
      .split(',')
      .map(Number)
      .filter((id) => !isNaN(id)),
    RA.map(validateEntryId),
    RA.filter(E.isRight),
    RA.map((e) => e.right),
  );
};
