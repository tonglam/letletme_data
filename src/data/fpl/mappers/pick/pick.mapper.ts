import { PickResponse } from 'data/fpl/schemas/pick/pick.schema';
import * as A from 'fp-ts/Array';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Chip } from 'types/base.type';
import { RawEntryEventPick, RawPickItem, RawPickItems } from 'types/domain/entry-event-pick.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { validatePlayerId } from 'types/domain/player.type';

const mapChipStringToEnum = (chipString: string | null): Chip => {
  if (!chipString) return Chip.None;
  switch (chipString.toLowerCase()) {
    case 'wildcard':
      return Chip.Wildcard;
    case 'freehit':
      return Chip.FreeHit;
    case 'bboost':
      return Chip.BenchBoost;
    case '3xc':
      return Chip.TripleCaptain;
    case 'mng':
      return Chip.Manager;
    default:
      return Chip.None;
  }
};

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
        chip: mapChipStringToEnum(raw.active_chip),
        picks,
        transfers: 0,
        transfersCost: 0,
      };
    }),
  );
};
