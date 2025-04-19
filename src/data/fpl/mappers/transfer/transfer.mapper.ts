import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { TransferResponse } from 'src/data/fpl/schemas/transfer/transfer.schema';
import {
  MappedEntryEventTransfer,
  validateEntryEventTransferId,
} from 'src/types/domain/entry-event-transfer.type';

export const mapTransferResponseToEntryEventTransfer = (
  raw: TransferResponse,
): E.Either<string, MappedEntryEventTransfer> => {
  return pipe(
    E.Do,
    E.bind('entry', () => validateEntryEventTransferId(raw.entry)),
    E.bind('event', () => validateEntryEventTransferId(raw.event)),
    E.bind('transferTime', () =>
      pipe(
        raw.time,
        E.fromNullable('Transfer time is missing'),
        E.map((timeString) => new Date(timeString)),
        E.chain((date) =>
          isNaN(date.getTime()) ? E.left('Invalid transfer time format') : E.right(date),
        ),
      ),
    ),
    E.map(({ entry, event, transferTime }) => {
      return {
        entry: entry,
        event: event,
        elementIn: raw.element_in,
        elementInCost: raw.element_in_cost,
        elementOut: raw.element_out,
        elementOutCost: raw.element_out_cost,
        transferTime: transferTime,
      };
    }),
  );
};
