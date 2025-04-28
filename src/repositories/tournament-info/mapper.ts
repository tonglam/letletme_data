import { DbTournamentInfo } from 'repositories/tournament-info/types';
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
import { TournamentId, TournamentInfo } from 'types/domain/tournament-info.type';

export const mapDbTournamentInfoToDomain = (dbTournamentInfo: DbTournamentInfo): TournamentInfo => {
  return {
    id: dbTournamentInfo.id as TournamentId,
    name: dbTournamentInfo.name,
    creator: dbTournamentInfo.creator,
    adminEntryId: dbTournamentInfo.adminEntryId as EntryId,
    leagueId: dbTournamentInfo.leagueId as LeagueId,
    leagueType: dbTournamentInfo.leagueType as LeagueType,
    totalTeamNum: dbTournamentInfo.totalTeamNum,
    tournamentMode: dbTournamentInfo.tournamentMode as TournamentMode,
    groupMode: dbTournamentInfo.groupMode as GroupMode,
    groupTeamNum: dbTournamentInfo.groupTeamNum,
    groupNum: dbTournamentInfo.groupNum,
    groupStartedEventId: dbTournamentInfo.groupStartedEventId as EventId | null,
    groupEndedEventId: dbTournamentInfo.groupEndedEventId as EventId | null,
    groupAutoAverages: dbTournamentInfo.groupAutoAverages,
    groupRounds: dbTournamentInfo.groupRounds,
    groupPlayAgainstNum: dbTournamentInfo.groupPlayAgainstNum,
    groupQualifyNum: dbTournamentInfo.groupQualifyNum,
    knockoutMode: dbTournamentInfo.knockoutMode as KnockoutMode,
    knockoutTeamNum: dbTournamentInfo.knockoutTeamNum,
    knockoutRounds: dbTournamentInfo.knockoutRounds,
    knockoutEventNum: dbTournamentInfo.knockoutEventNum,
    knockoutStartedEventId: dbTournamentInfo.knockoutStartedEventId as EventId | null,
    knockoutEndedEventId: dbTournamentInfo.knockoutEndedEventId as EventId | null,
    knockoutPlayAgainstNum: dbTournamentInfo.knockoutPlayAgainstNum,
    state: dbTournamentInfo.state as TournamentState,
  };
};
