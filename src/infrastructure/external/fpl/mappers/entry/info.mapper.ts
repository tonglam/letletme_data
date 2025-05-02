import { EntryID, validateEntryId } from '@app/domain/types/id.types';
import { EntryInfoResponse } from '@app/infrastructure/external/fpl/schemas/entry/info.schema';
import { EntryInfo } from '@app/shared/types/domain/entry-info.type';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

export const mapEntryInfoResponseToEntryInfo = (
  raw: EntryInfoResponse,
): E.Either<string, EntryInfo> =>
  pipe(
    E.Do,
    E.bind('id', () => validateEntryId(raw.id)),
    E.map((data): EntryInfo => {
      return {
        id: data.id as EntryID,
        entryName: raw.name,
        playerName: raw.player_first_name + ' ' + raw.player_last_name,
        region: raw.player_region_name,
        startedEvent: raw.started_event,
        overallPoints: raw.summary_overall_points,
        overallRank: raw.summary_overall_rank,
        bank: raw.last_deadline_bank,
        teamValue: raw.last_deadline_value,
        totalTransfers: raw.last_deadline_total_transfers,
        lastEntryName: null,
        lastOverallPoints: null,
        lastOverallRank: null,
        lastTeamValue: null,
        usedEntryNames: [],
      };
    }),
  );
