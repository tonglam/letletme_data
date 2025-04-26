import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { TransferResponse } from 'src/data/fpl/schemas/transfer/transfer.schema';
import { RawEntryEventTransfer } from 'src/types/domain/entry-event-transfer.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { PlayerId } from 'src/types/domain/player.type';

export const mapTransferResponseToEntryEventTransfer = (
  raw: TransferResponse,
): E.Either<string, RawEntryEventTransfer> => {
  return pipe(
    E.Do,
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
    E.map(({ transferTime }) => {
      return {
        entryId: raw.entry as EntryId,
        eventId: raw.event as EventId,
        elementInId: raw.element_in as PlayerId,
        elementInCost: raw.element_in_cost,
        elementOutId: raw.element_out as PlayerId,
        elementOutCost: raw.element_out_cost,
        transferTime: transferTime,
      };
    }),
  );
};
