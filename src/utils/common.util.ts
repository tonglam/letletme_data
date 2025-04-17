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
