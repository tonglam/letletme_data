import { PrismaTournamentInfo } from 'src/repositories/tournament-info/types';
import {
  GroupMode,
  KnockoutMode,
  LeagueType,
  TournamentMode,
  TournamentState,
} from 'src/types/base.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { LeagueId } from 'src/types/domain/league.type';
import { TournamentId, TournamentInfo } from 'src/types/domain/tournament-info.type';

export const mapPrismaTournamentInfoToDomain = (
  prismaTournamentInfo: PrismaTournamentInfo,
): TournamentInfo => {
  return {
    id: prismaTournamentInfo.id as TournamentId,
    name: prismaTournamentInfo.name,
    creator: prismaTournamentInfo.creator,
    adminEntryId: prismaTournamentInfo.adminEntryId as EntryId,
    leagueId: prismaTournamentInfo.leagueId as LeagueId,
    leagueType: prismaTournamentInfo.leagueType as LeagueType,
    totalTeamNum: prismaTournamentInfo.totalTeamNum,
    tournamentMode: prismaTournamentInfo.tournamentMode as TournamentMode,
    groupMode: prismaTournamentInfo.groupMode as GroupMode,
    groupTeamNum: prismaTournamentInfo.groupTeamNum,
    groupNum: prismaTournamentInfo.groupNum,
    groupStartedEventId: prismaTournamentInfo.groupStartedEventId as EventId | null,
    groupEndedEventId: prismaTournamentInfo.groupEndedEventId as EventId | null,
    groupAutoAverages: prismaTournamentInfo.groupAutoAverages,
    groupRounds: prismaTournamentInfo.groupRounds,
    groupPlayAgainstNum: prismaTournamentInfo.groupPlayAgainstNum,
    groupQualifyNum: prismaTournamentInfo.groupQualifyNum,
    knockoutMode: prismaTournamentInfo.knockoutMode as KnockoutMode,
    knockoutTeamNum: prismaTournamentInfo.knockoutTeamNum,
    knockoutRounds: prismaTournamentInfo.knockoutRounds,
    knockoutEventNum: prismaTournamentInfo.knockoutEventNum,
    knockoutStartedEventId: prismaTournamentInfo.knockoutStartedEventId as EventId | null,
    knockoutEndedEventId: prismaTournamentInfo.knockoutEndedEventId as EventId | null,
    knockoutPlayAgainstNum: prismaTournamentInfo.knockoutPlayAgainstNum,
    state: prismaTournamentInfo.state as TournamentState,
  };
};
