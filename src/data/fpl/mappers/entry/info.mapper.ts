import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { MappedEntryInfo, validateEntryId } from 'src/types/domain/entry-info.type';

import { EntryInfoResponse } from '../../schemas/entry/info.schema';

export const mapEntryInfoResponseToEntryInfo = (
  raw: EntryInfoResponse,
): E.Either<string, MappedEntryInfo> =>
  pipe(
    E.Do,
    E.bind('id', () => validateEntryId(raw.id)),
    E.map((data): MappedEntryInfo => {
      return {
        entry: data.id,
        entryName: raw.name,
        playerName: raw.player_first_name + ' ' + raw.player_last_name,
        region: raw.player_region_name,
        startedEvent: raw.started_event,
        overallPoints: raw.summary_overall_points,
        overallRank: raw.summary_overall_rank,
        bank: raw.last_deadline_bank,
        teamValue: raw.last_deadline_value,
        totalTransfers: raw.last_deadline_total_transfers,
      };
    }),
  );
