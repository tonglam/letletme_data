import { PickResponse } from 'data/fpl/schemas/pick/pick.schema';
import * as A from 'fp-ts/Array';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { RawEntryEventPick, RawPickItem, RawPickItems } from 'types/domain/entry-event-pick.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { validatePlayerId } from 'types/domain/player.type';

export const mapPickResponseToEntryEventPick = (
  entryId: EntryId,
  eventId: EventId,
  raw: PickResponse,
): E.Either<string, RawEntryEventPick> => {
  const picksData = raw.picks ?? [];
  const elementIds = picksData.map((pick) => pick.element);

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
        chip: raw.active_chip,
        picks,
        transfers: 0,
        transfersCost: 0,
      };
    }),
  );
};
