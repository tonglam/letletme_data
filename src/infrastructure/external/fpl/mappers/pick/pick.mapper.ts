import {
  RawEntryEventPick,
  RawPickItem,
  RawPickItems,
} from '@app/domain/models/entry-event-pick.model';
import { EntryID, EventID, validatePlayerId } from '@app/domain/shared/types/id.types';
import { PickResponse } from '@app/infrastructure/external/fpl/schemas/pick/pick.schema';
import * as A from 'fp-ts/Array';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

export const mapPickResponseToEntryEventPick = (
  entryId: EntryID,
  eventId: EventID,
  raw: PickResponse,
): E.Either<string, RawEntryEventPick> => {
  const picksData = raw.picks ?? [];
  const elementIds = picksData.map((pick) => pick.element);
  const chip: RawEntryEventPick['chip'] =
    raw.active_chip === null ? 'n/a' : (raw.active_chip as RawEntryEventPick['chip']);

  return pipe(
    elementIds,
    E.traverseArray(validatePlayerId),
    E.map((validatedPlayerIds) => {
      const picks: RawPickItems = pipe(
        picksData,
        A.mapWithIndex(
          (index, pick): RawPickItem => ({
            elementId: validatedPlayerIds[index],
            position: pick.position,
            multiplier: pick.multiplier,
            isCaptain: pick.is_captain,
            isViceCaptain: pick.is_vice_captain,
          }),
        ),
      );

      return {
        entryId,
        eventId,
        chip: chip,
        picks,
        transfers: 0,
        transfersCost: 0,
      };
    }),
  );
};
