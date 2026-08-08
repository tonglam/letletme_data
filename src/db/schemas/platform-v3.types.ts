import {
  entriesInCompetition,
  entryEventCupResultsInCompetition,
  entryEventResultsInCompetition,
  entryEventTransfersInCompetition,
  entryLeaguesInCompetition,
  entrySeasonHistoriesInCompetition,
  eventsInFpl,
  fixturesInFpl,
  leagueEventResultsInCompetition,
  phasesInFpl,
  playerEventSnapshotsInFpl,
  playerFixtureStatsInFpl,
  playerGameweekScoringItemsInFpl,
  playerGameweekStatsInFpl,
  playerMarketSnapshotsInFpl,
  playersInFpl,
  teamsInFpl,
  tournamentBattleGroupResultsInCompetition,
  tournamentGroupsInCompetition,
  tournamentKnockoutResultsInCompetition,
  tournamentKnockoutsInCompetition,
  tournamentPointsGroupResultsInCompetition,
  tournamentsInCompetition,
} from './platform-v3.schema';

export type DbEntryEventCupResultInsert = Readonly<
  typeof entryEventCupResultsInCompetition.$inferInsert
>;
type DbEntryEventResultStorage = Readonly<typeof entryEventResultsInCompetition.$inferSelect>;

/**
 * Application read model for an entry/gameweek result.
 *
 * Picks are normalized in competition.entry_event_picks in v3. Repositories hydrate them into
 * this read model so scoring services do not issue their own partially coherent joins.
 */
export type DbEntryEventResult = DbEntryEventResultStorage &
  Readonly<{
    id: number;
    eventPlayedCaptain: number | null;
    eventCaptainPoints: number | null;
    eventPicks: unknown;
    eventAutoSub: unknown;
  }>;
export type DbEntryEventResultInsert = Readonly<typeof entryEventResultsInCompetition.$inferInsert>;
type DbEntryEventTransferStorage = Readonly<typeof entryEventTransfersInCompetition.$inferSelect>;
export type DbEntryEventTransfer = DbEntryEventTransferStorage & Readonly<{ id: number }>;
export type DbEntryEventTransferInsert = Readonly<
  typeof entryEventTransfersInCompetition.$inferInsert
>;
export type DbEntryHistoryInfoInsert = Readonly<
  typeof entrySeasonHistoriesInCompetition.$inferInsert
>;
type DbEntryInfoStorage = Readonly<typeof entriesInCompetition.$inferSelect>;
export type DbEntryInfo = DbEntryInfoStorage &
  Readonly<{
    id: number;
    entrySnapshotSyncedThroughEventId: number | null;
    entrySnapshotSyncedSeason: string;
    entryTransfersSyncedThroughEventId: number | null;
    entryTransfersSyncedSeason: string;
    entryTransfersSourceCheckedAt: Date | null;
  }>;
export type DbEntryInfoInsert = Readonly<typeof entriesInCompetition.$inferInsert>;
export type DbEntryLeagueInfoInsert = Readonly<typeof entryLeaguesInCompetition.$inferInsert>;
export type DbEvent = Readonly<typeof eventsInFpl.$inferSelect>;
export type DbEventFixture = Readonly<typeof fixturesInFpl.$inferSelect>;
export type DbEventFixtureInsert = Readonly<typeof fixturesInFpl.$inferInsert>;
export type DbEventLive = Readonly<typeof playerGameweekStatsInFpl.$inferSelect>;
export type DbEventLiveExplain = Readonly<typeof playerGameweekScoringItemsInFpl.$inferSelect>;
export type DbEventLiveExplainInsert = Readonly<
  typeof playerGameweekScoringItemsInFpl.$inferInsert
>;
export type DbEventLiveInsert = Readonly<typeof playerGameweekStatsInFpl.$inferInsert>;
export type DbLeagueEventResultInsert = Readonly<
  typeof leagueEventResultsInCompetition.$inferInsert
>;
export type DbPhase = Readonly<typeof phasesInFpl.$inferSelect>;
export type DbPhaseInsert = Readonly<typeof phasesInFpl.$inferInsert>;
export type DbPlayer = Readonly<typeof playersInFpl.$inferSelect>;
export type DbPlayerInsert = Readonly<typeof playersInFpl.$inferInsert>;
export type DbPlayerMarketSnapshotInsert = Readonly<typeof playerMarketSnapshotsInFpl.$inferInsert>;
export type DbPlayerFixtureStat = Readonly<typeof playerFixtureStatsInFpl.$inferSelect>;
export type DbPlayerFixtureStatInsert = Readonly<typeof playerFixtureStatsInFpl.$inferInsert>;
export type DbPlayerStatInsert = Readonly<typeof playerEventSnapshotsInFpl.$inferInsert>;
export type DbTeam = Readonly<typeof teamsInFpl.$inferSelect>;
export type DbTeamInsert = Readonly<typeof teamsInFpl.$inferInsert>;
type DbTournamentBattleGroupResultStorage = Readonly<
  typeof tournamentBattleGroupResultsInCompetition.$inferSelect
>;
export type DbTournamentBattleGroupResult = DbTournamentBattleGroupResultStorage &
  Readonly<{ id: number }>;
export type DbTournamentBattleGroupResultInsert = Readonly<
  Omit<typeof tournamentBattleGroupResultsInCompetition.$inferInsert, 'seasonId' | 'sourceResultId'>
>;
type DbTournamentGroupStorage = Readonly<typeof tournamentGroupsInCompetition.$inferSelect>;
export type DbTournamentGroup = DbTournamentGroupStorage & Readonly<{ id: number }>;
export type DbTournamentGroupInsert = Readonly<
  Omit<typeof tournamentGroupsInCompetition.$inferInsert, 'seasonId' | 'sourceGroupRowId'>
>;
type DbTournamentInfoStorage = Readonly<typeof tournamentsInCompetition.$inferSelect>;
export type DbTournamentInfo = Omit<DbTournamentInfoStorage, 'groupMode' | 'knockoutMode'> &
  Readonly<{
    id: number;
    groupMode: NonNullable<DbTournamentInfoStorage['groupMode']>;
    knockoutMode: NonNullable<DbTournamentInfoStorage['knockoutMode']>;
  }>;
type DbTournamentKnockoutStorage = Readonly<typeof tournamentKnockoutsInCompetition.$inferSelect>;
export type DbTournamentKnockout = DbTournamentKnockoutStorage & Readonly<{ id: number }>;
export type DbTournamentKnockoutInsert = Readonly<
  Omit<typeof tournamentKnockoutsInCompetition.$inferInsert, 'seasonId' | 'sourceKnockoutId'>
>;
type DbTournamentKnockoutResultStorage = Readonly<
  typeof tournamentKnockoutResultsInCompetition.$inferSelect
>;
export type DbTournamentKnockoutResult = DbTournamentKnockoutResultStorage &
  Readonly<{ id: number }>;
export type DbTournamentKnockoutResultInsert = Readonly<
  Omit<typeof tournamentKnockoutResultsInCompetition.$inferInsert, 'seasonId' | 'sourceResultId'>
>;
type DbTournamentPointsGroupResultStorage = Readonly<
  typeof tournamentPointsGroupResultsInCompetition.$inferSelect
>;
export type DbTournamentPointsGroupResult = DbTournamentPointsGroupResultStorage &
  Readonly<{ id: number }>;
export type DbTournamentPointsGroupResultInsert = Readonly<
  Omit<typeof tournamentPointsGroupResultsInCompetition.$inferInsert, 'seasonId' | 'sourceResultId'>
>;
