import type {
  DbTournamentGroupInsert,
  DbTournamentKnockoutInsert,
  DbTournamentKnockoutResultInsert,
} from '../db/schemas/index.schema';
import { sql } from 'drizzle-orm';
import {
  tournamentBattleGroupResultsInCompetition,
  tournamentGroupsInCompetition,
  tournamentKnockoutResultsInCompetition,
  tournamentKnockoutsInCompetition,
  tournamentPointsGroupResultsInCompetition,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import {
  buildGroupRows,
  buildKnockoutRows,
  isOfficialH2HTournament,
  seedBracketEntries,
  sortEntrySeeds,
  type EntrySeed,
  type TournamentConfig,
} from '../domain/tournament';
import { createTournamentBattleGroupResultsRepository } from '../repositories/tournament-battle-group-results';
import { createTournamentGroupRepository } from '../repositories/tournament-groups';
import { createTournamentKnockoutResultsRepository } from '../repositories/tournament-knockout-results';
import { createTournamentKnockoutsRepository } from '../repositories/tournament-knockouts';
import { createTournamentPointsGroupResultsRepository } from '../repositories/tournament-points-group-results';

export type DerivedResultRepairSnapshot = {
  points: Array<{ sourceResultId: number; updatedAt: string }>;
  battle: Array<{ sourceResultId: number; updatedAt: string }>;
  /** Canonical local schedule used by the post-repair pruning fence. */
  battleMatchupKeys: TournamentBattleMatchupKey[];
  knockout: Array<{ sourceResultId: number; updatedAt: string }>;
};

export type TournamentBattleMatchupKey = Readonly<{
  groupId: number;
  eventId: number;
  homeIndex: number;
  awayIndex: number;
}>;

type BattleScheduleGroupRow = Readonly<{
  groupId: number;
  groupIndex: number;
  startedEventId: number | null;
  endedEventId: number | null;
}>;

export type TournamentStructureRepairCandidate = Readonly<{
  groupRows: ReadonlyArray<DbTournamentGroupInsert>;
  knockoutResults: ReadonlyArray<DbTournamentKnockoutResultInsert>;
  /** Fixture identities from the complete rebuilt local round schedule. */
  battleMatchupKeys: ReadonlyArray<TournamentBattleMatchupKey>;
}>;

export function resolveKnockoutLegEntrants(
  homeEntryId: number | null,
  awayEntryId: number | null,
  playAgainstId: number,
): { homeEntryId: number | null; awayEntryId: number | null } {
  return playAgainstId % 2 === 0
    ? { homeEntryId: awayEntryId, awayEntryId: homeEntryId }
    : { homeEntryId, awayEntryId };
}

function groupInsert(row: Record<string, number | string | null>): DbTournamentGroupInsert {
  return {
    tournamentId: Number(row.tournament_id),
    groupId: Number(row.group_id),
    groupName: String(row.group_name),
    groupIndex: Number(row.group_index),
    entryId: Number(row.entry_id),
    startedEventId: Number(row.started_event_id),
    endedEventId: Number(row.ended_event_id),
    groupPoints: Number(row.group_points),
    groupRank: row.group_rank === null ? null : Number(row.group_rank),
    played: Number(row.played),
    won: Number(row.won),
    drawn: Number(row.drawn),
    lost: Number(row.lost),
    totalPoints: Number(row.total_points),
    totalTransfersCost: Number(row.total_transfers_cost),
    totalNetPoints: Number(row.total_net_points),
    qualified: Number(row.qualified),
    overallRank: row.overall_rank === null ? null : Number(row.overall_rank),
  };
}

/**
 * Build the complete local battle schedule from the rebuilt group topology.
 *
 * Local battle fixtures are round-robin facts: the group slots, event window,
 * and round position determine the accepted matchup. Include both orientations
 * because home/away is a display direction, while the business identity is the
 * pair of slots. This whitelist is deliberately independent of the pre-repair
 * result rows, so a corrupt extra row cannot make itself part of the candidate.
 */
export function buildBattleMatchupSchedule(
  groupRows: ReadonlyArray<BattleScheduleGroupRow>,
): TournamentBattleMatchupKey[] {
  const rowsByGroup = new Map<number, BattleScheduleGroupRow[]>();
  for (const row of groupRows) {
    const rows = rowsByGroup.get(row.groupId) ?? [];
    rows.push(row);
    rowsByGroup.set(row.groupId, rows);
  }

  const keys: TournamentBattleMatchupKey[] = [];
  const seen = new Set<string>();
  const append = (groupId: number, eventId: number, homeIndex: number, awayIndex: number) => {
    if (homeIndex === awayIndex) return;
    const key = `${groupId}:${eventId}:${homeIndex}:${awayIndex}`;
    if (seen.has(key)) return;
    seen.add(key);
    keys.push({ groupId, eventId, homeIndex, awayIndex });
  };

  for (const [groupId, originalRows] of rowsByGroup) {
    const slots = [...new Map(originalRows.map((row) => [row.groupIndex, row])).values()].sort(
      (left, right) => left.groupIndex - right.groupIndex,
    );
    const firstStart = slots.reduce<number | null>(
      (current, row) =>
        row.startedEventId === null
          ? current
          : current === null
            ? row.startedEventId
            : Math.min(current, row.startedEventId),
      null,
    );
    const lastEnd = slots.reduce<number | null>(
      (current, row) =>
        row.endedEventId === null
          ? current
          : current === null
            ? row.endedEventId
            : Math.max(current, row.endedEventId),
      null,
    );
    if (slots.length < 2 || firstStart === null || lastEnd === null || lastEnd < firstStart) {
      continue;
    }

    for (let eventId = firstStart; eventId <= lastEnd; eventId += 1) {
      const activeSlots = slots
        .filter(
          (row) =>
            (row.startedEventId === null || eventId >= row.startedEventId) &&
            (row.endedEventId === null || eventId <= row.endedEventId),
        )
        .map((row) => row.groupIndex);
      if (activeSlots.length < 2) continue;

      const participants: Array<number | null> = [...activeSlots];
      if (participants.length % 2 === 1) participants.push(null);
      const rotationLength = participants.length - 1;
      const round = (eventId - firstStart) % rotationLength;
      const rotating = participants.slice(1);
      const rotated = [...rotating.slice(round), ...rotating.slice(0, round)];
      const ordered: Array<number | null> = [participants[0]!, ...rotated];
      for (let pair = 0; pair < ordered.length / 2; pair += 1) {
        const left = ordered[pair];
        const right = ordered[ordered.length - pair - 1];
        if (left === null || right === null) continue;
        append(groupId, eventId, left, right);
        append(groupId, eventId, right, left);
      }
    }
  }
  return keys;
}

export async function rebuildTournamentStructure(
  season: FplSeasonRef,
  tournament: TournamentConfig,
  entrySeeds: EntrySeed[],
  options: Readonly<{
    preserveDerivedResults?: boolean;
    onCandidate?: (candidate: TournamentStructureRepairCandidate) => void;
  }> = {},
): Promise<ReadonlyArray<DbTournamentGroupInsert>> {
  const entryIds = sortEntrySeeds(entrySeeds).map((entry) => entry.entryId);
  const shouldSeedRoundOneImmediately =
    tournament.knockoutMode !== 'no_knockout' && tournament.groupMode === 'no_group';
  const seededRoundOne =
    shouldSeedRoundOneImmediately && tournament.knockoutTeamNum
      ? seedBracketEntries(entryIds, tournament.knockoutTeamNum)
      : null;
  const groupRows =
    tournament.groupMode === 'no_group'
      ? []
      : buildGroupRows(tournament, entrySeeds).map(groupInsert);
  const battleMatchupKeys =
    tournament.groupMode === 'battle_races'
      ? buildBattleMatchupSchedule(
          groupRows.map((row) => ({
            groupId: row.groupId,
            groupIndex: row.groupIndex,
            startedEventId: row.startedEventId ?? null,
            endedEventId: row.endedEventId ?? null,
          })),
        )
      : [];
  const knockoutRows =
    tournament.knockoutMode === 'no_knockout'
      ? { matches: [], results: [] }
      : buildKnockoutRows(tournament, seededRoundOne);
  const knockoutMatches: DbTournamentKnockoutInsert[] = knockoutRows.matches.map((row) => ({
    tournamentId: row.tournament_id,
    round: row.round,
    startedEventId: row.started_event_id,
    endedEventId: row.ended_event_id,
    matchId: row.match_id,
    nextMatchId: row.next_match_id,
    homeEntryId: row.home_entry_id,
    awayEntryId: row.away_entry_id,
  }));
  const knockoutResults: DbTournamentKnockoutResultInsert[] = knockoutRows.results.map((row) => ({
    tournamentId: row.tournament_id,
    eventId: row.event_id,
    matchId: row.match_id,
    playAgainstId: row.play_against_id,
    homeEntryId: row.home_entry_id,
    awayEntryId: row.away_entry_id,
    // Structure creation is not source evidence. Leave the watermark empty
    // until a finalized event result has actually been observed; a local
    // wall-clock timestamp could be newer than the provider timestamp and
    // block that first real result under the stale-input guard.
    sourceCheckedAt: null,
  }));
  const publishedKnockoutResults = isOfficialH2HTournament(tournament) ? [] : knockoutResults;
  const preserveProviderOwnedKnockouts =
    options.preserveDerivedResults === true && isOfficialH2HTournament(tournament);

  const db = await getDb();
  await db.transaction(async (tx) => {
    const groups = createTournamentGroupRepository(tx);
    const points = createTournamentPointsGroupResultsRepository(tx);
    const battles = createTournamentBattleGroupResultsRepository(tx);
    const knockouts = createTournamentKnockoutsRepository(tx);
    const knockoutResultsRepository = createTournamentKnockoutResultsRepository(tx);

    if (!preserveProviderOwnedKnockouts) {
      await knockouts.deleteByTournament(season, tournament.id);
    }
    if (!options.preserveDerivedResults) {
      await knockoutResultsRepository.deleteByTournament(season, tournament.id);
      await points.deleteByTournament(season, tournament.id);
      await battles.deleteByTournament(season, tournament.id);
    }
    await groups.deleteByTournament(season, tournament.id);

    await groups.upsertBatch(season, groupRows);
    if (!preserveProviderOwnedKnockouts) {
      await knockouts.upsertBatch(season, knockoutMatches);
    }
    // A repair transaction may replace the bracket before event backfill has
    // proved the candidate entrants. Insert only missing result shells in
    // that mode: an existing scored row remains attributed to its accepted
    // entrants until the complete candidate result is committed by the
    // backfill. This prevents a failed backfill from rehoming old scores.
    await knockoutResultsRepository.upsertBatch(season, publishedKnockoutResults, {
      preserveExistingFacts: options.preserveDerivedResults === true,
    });
  });
  options.onCandidate?.({
    groupRows,
    knockoutResults: publishedKnockoutResults,
    battleMatchupKeys,
  });
  return groupRows;
}

/**
 * Capture only derived rows that were already invalid against the canonical
 * topology before a structure repair. The snapshot is used after the
 * replacement/backfill phase so a failed repair never clears visible history,
 * and a row rewritten by the new calculation is not mistaken for stale data.
 */
export async function snapshotDerivedResultsInvalidBeforeStructureRepair(
  season: FplSeasonRef,
  tournamentId: number,
): Promise<DerivedResultRepairSnapshot> {
  const db = await getDb();
  const [groups, points, battles, knockoutResults, knockouts] = await Promise.all([
    db
      .select({
        groupId: tournamentGroupsInCompetition.groupId,
        groupIndex: tournamentGroupsInCompetition.groupIndex,
        entryId: tournamentGroupsInCompetition.entryId,
        startedEventId: tournamentGroupsInCompetition.startedEventId,
        endedEventId: tournamentGroupsInCompetition.endedEventId,
      })
      .from(tournamentGroupsInCompetition)
      .where(
        sql`${tournamentGroupsInCompetition.seasonId} = ${season.seasonId}
          AND ${tournamentGroupsInCompetition.tournamentId} = ${tournamentId}`,
      ),
    db
      .select({
        sourceResultId: tournamentPointsGroupResultsInCompetition.sourceResultId,
        groupId: tournamentPointsGroupResultsInCompetition.groupId,
        eventId: tournamentPointsGroupResultsInCompetition.eventId,
        entryId: tournamentPointsGroupResultsInCompetition.entryId,
        updatedAt: sql<string>`${tournamentPointsGroupResultsInCompetition.updatedAt}::text`,
      })
      .from(tournamentPointsGroupResultsInCompetition)
      .where(
        sql`${tournamentPointsGroupResultsInCompetition.seasonId} = ${season.seasonId}
          AND ${tournamentPointsGroupResultsInCompetition.tournamentId} = ${tournamentId}`,
      ),
    db
      .select({
        sourceResultId: tournamentBattleGroupResultsInCompetition.sourceResultId,
        groupId: tournamentBattleGroupResultsInCompetition.groupId,
        eventId: tournamentBattleGroupResultsInCompetition.eventId,
        homeIndex: tournamentBattleGroupResultsInCompetition.homeIndex,
        homeEntryId: tournamentBattleGroupResultsInCompetition.homeEntryId,
        awayIndex: tournamentBattleGroupResultsInCompetition.awayIndex,
        awayEntryId: tournamentBattleGroupResultsInCompetition.awayEntryId,
        officialMatchId: tournamentBattleGroupResultsInCompetition.officialMatchId,
        updatedAt: sql<string>`${tournamentBattleGroupResultsInCompetition.updatedAt}::text`,
      })
      .from(tournamentBattleGroupResultsInCompetition)
      .where(
        sql`${tournamentBattleGroupResultsInCompetition.seasonId} = ${season.seasonId}
          AND ${tournamentBattleGroupResultsInCompetition.tournamentId} = ${tournamentId}`,
      ),
    db
      .select({
        sourceResultId: tournamentKnockoutResultsInCompetition.sourceResultId,
        officialMatchId: tournamentKnockoutResultsInCompetition.officialMatchId,
        eventId: tournamentKnockoutResultsInCompetition.eventId,
        matchId: tournamentKnockoutResultsInCompetition.matchId,
        playAgainstId: tournamentKnockoutResultsInCompetition.playAgainstId,
        homeEntryId: tournamentKnockoutResultsInCompetition.homeEntryId,
        awayEntryId: tournamentKnockoutResultsInCompetition.awayEntryId,
        updatedAt: sql<string>`${tournamentKnockoutResultsInCompetition.updatedAt}::text`,
      })
      .from(tournamentKnockoutResultsInCompetition)
      .where(
        sql`${tournamentKnockoutResultsInCompetition.seasonId} = ${season.seasonId}
          AND ${tournamentKnockoutResultsInCompetition.tournamentId} = ${tournamentId}`,
      ),
    db
      .select({
        matchId: tournamentKnockoutsInCompetition.matchId,
        startedEventId: tournamentKnockoutsInCompetition.startedEventId,
        endedEventId: tournamentKnockoutsInCompetition.endedEventId,
        homeEntryId: tournamentKnockoutsInCompetition.homeEntryId,
        awayEntryId: tournamentKnockoutsInCompetition.awayEntryId,
      })
      .from(tournamentKnockoutsInCompetition)
      .where(
        sql`${tournamentKnockoutsInCompetition.seasonId} = ${season.seasonId}
          AND ${tournamentKnockoutsInCompetition.tournamentId} = ${tournamentId}`,
      ),
  ]);

  const ownsGroupEntry = (groupId: number, entryId: number, eventId: number): boolean =>
    groups.some(
      (group) =>
        group.groupId === groupId &&
        group.entryId === entryId &&
        group.startedEventId !== null &&
        group.endedEventId !== null &&
        eventId >= group.startedEventId &&
        eventId <= group.endedEventId,
    );
  const ownsGroup = (groupId: number, eventId: number): boolean =>
    groups.some(
      (group) =>
        group.groupId === groupId &&
        group.startedEventId !== null &&
        group.endedEventId !== null &&
        eventId >= group.startedEventId &&
        eventId <= group.endedEventId,
    );
  const ownsLocalSlot = (
    groupId: number,
    slot: number,
    entryId: number | null,
    eventId: number,
  ): boolean =>
    groups.some(
      (group) =>
        group.groupId === groupId &&
        group.groupIndex === slot &&
        group.entryId === entryId &&
        group.startedEventId !== null &&
        group.endedEventId !== null &&
        eventId >= group.startedEventId &&
        eventId <= group.endedEventId,
    );

  const staleBattleRows = battles.filter(
    (result) =>
      result.officialMatchId === null &&
      (!ownsGroup(result.groupId, result.eventId) ||
        !ownsLocalSlot(result.groupId, result.homeIndex, result.homeEntryId, result.eventId) ||
        !ownsLocalSlot(result.groupId, result.awayIndex, result.awayEntryId, result.eventId)),
  );

  return {
    points: points
      .filter((result) => !ownsGroupEntry(result.groupId, result.entryId, result.eventId))
      .map(({ sourceResultId, updatedAt }) => ({ sourceResultId, updatedAt })),
    battle: staleBattleRows.map(({ sourceResultId, updatedAt }) => ({ sourceResultId, updatedAt })),
    // The pre-repair snapshot is not authoritative for the candidate schedule;
    // the rebuilt group rows produce the complete whitelist after the swap.
    battleMatchupKeys: [],
    knockout: knockoutResults
      .filter((result) => {
        if (result.officialMatchId !== null) return false;
        const match = knockouts.find((candidate) => candidate.matchId === result.matchId);
        const expectedLegEntrants = match
          ? resolveKnockoutLegEntrants(match.homeEntryId, match.awayEntryId, result.playAgainstId)
          : null;
        return (
          !match ||
          match.startedEventId === null ||
          result.eventId < match.startedEventId ||
          (match.endedEventId !== null && result.eventId > match.endedEventId) ||
          result.playAgainstId !== result.eventId - match.startedEventId + 1 ||
          result.homeEntryId !== expectedLegEntrants?.homeEntryId ||
          result.awayEntryId !== expectedLegEntrants?.awayEntryId
        );
      })
      .map(({ sourceResultId, updatedAt }) => ({ sourceResultId, updatedAt })),
  };
}

/**
 * Remove only derived rows that no longer have a canonical topology owner.
 * Structure repair keeps the old derived set while the history backfill runs;
 * this cleanup is called only after that backfill converges, so a failed
 * candidate never turns a visible history into an empty set.
 */
export async function pruneTournamentDerivedResultsOutsideStructure(
  season: FplSeasonRef,
  tournamentId: number,
  snapshot: DerivedResultRepairSnapshot = {
    points: [],
    battle: [],
    battleMatchupKeys: [],
    knockout: [],
  },
): Promise<void> {
  // The DELETE predicates below are the authoritative recheck against the
  // rebuilt topology. Do not apply the pre-repair timestamp snapshot after
  // this recheck: a row that was invalid under the old topology can be valid
  // again after the rebuild, and an idempotent upsert may leave updated_at
  // unchanged. The argument remains part of the repair contract for callers
  // and provenance, but it must not delete a currently valid row.
  const acceptedBattleMatchupPayload = JSON.stringify(
    snapshot.battleMatchupKeys.map(({ groupId, eventId, homeIndex, awayIndex }) => ({
      group_id: groupId,
      event_id: eventId,
      home_index: homeIndex,
      away_index: awayIndex,
    })),
  );
  const outsideAcceptedBattleSchedule =
    snapshot.battleMatchupKeys.length === 0
      ? sql``
      : sql`
          OR NOT EXISTS (
            SELECT 1
            FROM jsonb_to_recordset(${acceptedBattleMatchupPayload}::jsonb)
              AS accepted(group_id integer, event_id integer, home_index integer, away_index integer)
            WHERE accepted.group_id = result.group_id
              AND accepted.event_id = result.event_id
              AND accepted.home_index = result.home_index
              AND accepted.away_index = result.away_index
          )`;
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM ${tournamentPointsGroupResultsInCompetition} AS result
      WHERE result.season_id = ${season.seasonId}
        AND result.tournament_id = ${tournamentId}
        AND NOT EXISTS (
          SELECT 1
          FROM ${tournamentGroupsInCompetition} AS group_row
          WHERE group_row.season_id = result.season_id
            AND group_row.tournament_id = result.tournament_id
            AND group_row.group_id = result.group_id
            AND group_row.entry_id = result.entry_id
            AND result.event_id BETWEEN group_row.started_event_id AND group_row.ended_event_id
        )
    `);
    await tx.execute(sql`
      DELETE FROM ${tournamentBattleGroupResultsInCompetition} AS result
      WHERE result.season_id = ${season.seasonId}
        AND result.tournament_id = ${tournamentId}
        AND result.official_match_id IS NULL
        AND (
          NOT EXISTS (
            SELECT 1
            FROM ${tournamentGroupsInCompetition} AS group_row
            WHERE group_row.season_id = result.season_id
              AND group_row.tournament_id = result.tournament_id
              AND group_row.group_id = result.group_id
              AND result.event_id BETWEEN group_row.started_event_id AND group_row.ended_event_id
          )
          OR (
            result.home_entry_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM ${tournamentGroupsInCompetition} AS group_row
                WHERE group_row.season_id = result.season_id
                  AND group_row.tournament_id = result.tournament_id
                  AND group_row.group_id = result.group_id
                  AND group_row.entry_id = result.home_entry_id
                  AND result.event_id BETWEEN group_row.started_event_id AND group_row.ended_event_id
            )
          )
          OR (
            result.away_entry_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM ${tournamentGroupsInCompetition} AS group_row
                WHERE group_row.season_id = result.season_id
                  AND group_row.tournament_id = result.tournament_id
                  AND group_row.group_id = result.group_id
                  AND group_row.entry_id = result.away_entry_id
                AND result.event_id BETWEEN group_row.started_event_id AND group_row.ended_event_id
            )
          )
          OR (
            result.official_match_id IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM ${tournamentGroupsInCompetition} AS group_row
              WHERE group_row.season_id = result.season_id
                AND group_row.tournament_id = result.tournament_id
                AND group_row.group_id = result.group_id
                AND group_row.group_index = result.home_index
                AND group_row.entry_id = result.home_entry_id
                AND result.event_id BETWEEN group_row.started_event_id AND group_row.ended_event_id
            )
          )
          OR (
            result.official_match_id IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM ${tournamentGroupsInCompetition} AS group_row
              WHERE group_row.season_id = result.season_id
                AND group_row.tournament_id = result.tournament_id
                AND group_row.group_id = result.group_id
                AND group_row.group_index = result.away_index
                AND group_row.entry_id = result.away_entry_id
                AND result.event_id BETWEEN group_row.started_event_id AND group_row.ended_event_id
            )
          )
          ${outsideAcceptedBattleSchedule}
        )
    `);
    await tx.execute(sql`
      DELETE FROM ${tournamentKnockoutResultsInCompetition} AS result
      WHERE result.season_id = ${season.seasonId}
        AND result.tournament_id = ${tournamentId}
        AND result.official_match_id IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM ${tournamentKnockoutsInCompetition} AS knockout
            WHERE knockout.season_id = result.season_id
              AND knockout.tournament_id = result.tournament_id
              AND knockout.match_id = result.match_id
              AND knockout.started_event_id IS NOT NULL
              AND result.event_id >= knockout.started_event_id
              AND (knockout.ended_event_id IS NULL OR result.event_id <= knockout.ended_event_id)
              AND result.play_against_id = result.event_id - knockout.started_event_id + 1
              AND result.home_entry_id IS NOT DISTINCT FROM (
                CASE
                  WHEN result.play_against_id % 2 = 0 THEN knockout.away_entry_id
                  ELSE knockout.home_entry_id
                END
              )
              AND result.away_entry_id IS NOT DISTINCT FROM (
                CASE
                  WHEN result.play_against_id % 2 = 0 THEN knockout.home_entry_id
                  ELSE knockout.away_entry_id
                END
              )
        )
      `);
  });
}
