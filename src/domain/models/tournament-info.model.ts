import {
  GroupMode,
  KnockoutMode,
  LeagueType,
  TournamentMode,
  TournamentState,
} from 'types/base.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { LeagueId } from 'types/domain/league.type';

export type TournamentInfo = {
  readonly id: TournamentId;
  readonly name: string;
  readonly creator: string;
  readonly adminEntryId: EntryId;
  readonly leagueId: LeagueId;
  readonly leagueType: LeagueType;
  readonly totalTeamNum: number;
  readonly tournamentMode: TournamentMode;
  readonly groupMode: GroupMode;
  readonly groupTeamNum: number | null;
  readonly groupNum: number | null;
  readonly groupStartedEventId: EventId | null;
  readonly groupEndedEventId: EventId | null;
  readonly groupAutoAverages: boolean | null;
  readonly groupRounds: number | null;
  readonly groupPlayAgainstNum: number | null;
  readonly groupQualifyNum: number | null;
  readonly knockoutMode: KnockoutMode;
  readonly knockoutTeamNum: number | null;
  readonly knockoutRounds: number | null;
  readonly knockoutEventNum: number | null;
  readonly knockoutStartedEventId: EventId | null;
  readonly knockoutEndedEventId: EventId | null;
  readonly knockoutPlayAgainstNum: number | null;
  readonly state: TournamentState;
};

export type TournamentInfos = readonly TournamentInfo[];
