import { RawEntryEventTransfer } from '@app/domain/models/entry-event-transfer.model';
import { EntryID, EventID, PlayerID } from '@app/domain/types/id.types';
import { TransferResponse } from '@app/infrastructure/external/fpl/schemas/transfer/transfer.schema';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

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
        entryId: raw.entry as EntryID,
        eventId: raw.event as EventID,
        elementInId: raw.element_in as PlayerID,
        elementInCost: raw.element_in_cost,
        elementOutId: raw.element_out as PlayerID,
        elementOutCost: raw.element_out_cost,
        transferTime: transferTime,
      };
    }),
  );
};
