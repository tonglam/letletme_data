import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { PickResponse } from 'src/data/fpl/schemas/pick/pick.schema';
import { Chip } from 'src/types/base.type';
import {
  MappedEntryEventPick,
  validateEntryEventPickId,
} from 'src/types/domain/entry-event-pick.type';

const mapChipStringToEnum = (chipString: string | null): Chip | null => {
  if (!chipString) return null;
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
  entry: number,
  event: number,
  raw: PickResponse,
): E.Either<string, MappedEntryEventPick> => {
  return pipe(
    E.Do,
    E.bind('entry', () => validateEntryEventPickId(entry)),
    E.bind('event', () => validateEntryEventPickId(event)),
    E.map((data) => {
      return {
        entry: data.entry,
        event: data.event,
        chip: mapChipStringToEnum(raw.active_chip),
        picks: (raw.picks ?? []).map((pick) => pick.element),
      };
    }),
  );
};
