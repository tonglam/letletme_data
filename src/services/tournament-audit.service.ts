import { getDbClient } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { tournamentEntryCoreScopes, tournamentSetupRebuildScopes } from '../domain/mutation-scope';
import {
  buildKnockoutRows,
  isOfficialH2HTournament,
  type TournamentBackfillWindow,
  type TournamentConfig,
} from '../domain/tournament';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentGroupRepository } from '../repositories/tournament-groups';
import { uniqueNumbers } from '../utils/async';
import { logInfo, logWarn } from '../utils/logger';
import { withMutationConflictGuard } from '../utils/mutation-lock';

import {
  backfillTournamentHistory,
  runTournamentEventBackfill,
  type TournamentSetupIssue,
  syncTournamentEntryDetails,
} from './tournament-backfill.service';
import { rebuildTournamentStructure } from './tournament-structure.service';

export type TournamentAuditResult = {
  issues: string[];
  missingEntryInfoIds: number[];
  missingEntryLeagueInfoIds: number[];
  requiresStructureRebuild: boolean;
  rerunEventIds: number[];
};

function isCriticalAuditIssue(issue: string): boolean {
  return (
    issue.startsWith('tournament_entries count ') ||
    issue.startsWith('tournament_groups count ') ||
    issue.startsWith('invalid group_index sequence') ||
    issue.startsWith('knockout structure mismatch')
  );
}

async function loadPresentEntryInfoIds(
  season: FplSeasonRef,
  entryIds: number[],
): Promise<number[]> {
  if (entryIds.length === 0) {
    return [];
  }
  const client = await getDbClient();
  const rows = await client<{ entryId: number }[]>`
    SELECT entry_id AS "entryId"
    FROM competition.entries
    WHERE season_id = ${season.seasonId}
      AND entry_id = ANY(${entryIds}::int[])
  `;
  return rows.map((row) => row.entryId);
}

async function loadPresentEntryLeagueInfoIds(
  season: FplSeasonRef,
  entryIds: number[],
  leagueId: number,
  leagueType: 'classic' | 'h2h',
): Promise<number[]> {
  if (entryIds.length === 0) {
    return [];
  }
  const client = await getDbClient();
  const rows = await client<{ entryId: number }[]>`
    SELECT DISTINCT entry_id AS "entryId"
    FROM competition.entry_leagues
    WHERE season_id = ${season.seasonId}
      AND entry_id = ANY(${entryIds}::int[])
      AND league_id = ${leagueId}
      AND league_type = ${leagueType}
  `;
  return rows.map((row) => row.entryId);
}

export async function auditTournamentSetup(
  season: FplSeasonRef,
  tournament: TournamentConfig,
  window: TournamentBackfillWindow | null,
): Promise<TournamentAuditResult> {
  const issues: string[] = [];
  const rerunEventIds = new Set<number>();
  const client = await getDbClient();
  const entryIds = await tournamentEntryRepository.findEntryIdsByTournamentId(
    season,
    tournament.id,
  );

  if (entryIds.length !== tournament.totalTeamNum) {
    issues.push(
      `tournament_entries count ${entryIds.length} does not match total_team_num ${tournament.totalTeamNum}`,
    );
  }

  const presentEntryInfoIds = new Set(await loadPresentEntryInfoIds(season, entryIds));
  const missingEntryInfoIds = entryIds.filter((entryId) => !presentEntryInfoIds.has(entryId));
  if (missingEntryInfoIds.length > 0) {
    issues.push(`missing entry_infos for ${missingEntryInfoIds.length} entries`);
  }

  const presentEntryLeagueInfoIds = new Set(
    await loadPresentEntryLeagueInfoIds(
      season,
      entryIds,
      tournament.leagueId ?? 0,
      tournament.leagueType ?? 'classic',
    ),
  );
  const missingEntryLeagueInfoIds = entryIds.filter(
    (entryId) => !presentEntryLeagueInfoIds.has(entryId),
  );
  if (missingEntryLeagueInfoIds.length > 0) {
    issues.push(`missing entry_league_infos for ${missingEntryLeagueInfoIds.length} entries`);
  }

  let requiresStructureRebuild = false;

  if (tournament.groupMode !== 'no_group') {
    const groupRows = await tournamentGroupRepository.findGroupSlots(season, tournament.id);

    if (groupRows.length !== entryIds.length) {
      issues.push(
        `tournament_groups count ${groupRows.length} does not match participant count ${entryIds.length}`,
      );
      requiresStructureRebuild = true;
    } else {
      const slotsByGroup = new Map<number, number[]>();
      for (const row of groupRows) {
        const slots = slotsByGroup.get(row.groupId) ?? [];
        slots.push(row.groupIndex);
        slotsByGroup.set(row.groupId, slots);
      }

      for (const [groupId, slots] of slotsByGroup.entries()) {
        const sortedSlots = [...slots].sort((left, right) => left - right);
        const hasInvalidSlot = sortedSlots.some((slot, index) => slot !== index + 1);
        if (hasInvalidSlot) {
          issues.push(`invalid group_index sequence in group ${groupId}`);
          requiresStructureRebuild = true;
          break;
        }
      }
    }
  }

  if (tournament.knockoutMode !== 'no_knockout' && !isOfficialH2HTournament(tournament)) {
    const expectedKnockoutRows = buildKnockoutRows(tournament, null);
    const expectedMatchCount = expectedKnockoutRows.matches.length;
    const expectedResultCount = expectedKnockoutRows.results.length;

    const [knockoutCount] = await client<{ matchCount: number; resultCount: number }[]>`
      select
        (
          SELECT count(*)::int
          FROM competition.tournament_knockouts
          WHERE season_id = ${season.seasonId}
            AND tournament_id = ${tournament.id}
        ) AS "matchCount",
        (
          SELECT count(*)::int
          FROM competition.tournament_knockout_results
          WHERE season_id = ${season.seasonId}
            AND tournament_id = ${tournament.id}
        ) AS "resultCount"
    `;

    if (
      (knockoutCount?.matchCount ?? 0) !== expectedMatchCount ||
      (knockoutCount?.resultCount ?? 0) !== expectedResultCount
    ) {
      issues.push(
        `knockout structure mismatch: matches ${knockoutCount?.matchCount ?? 0}/${expectedMatchCount}, results ${knockoutCount?.resultCount ?? 0}/${expectedResultCount}`,
      );
      requiresStructureRebuild = true;
    }
  }

  if (!window || entryIds.length === 0) {
    return {
      issues,
      missingEntryInfoIds,
      missingEntryLeagueInfoIds,
      requiresStructureRebuild,
      rerunEventIds: [],
    };
  }

  const entryResultCounts = await client<{ eventId: number; rowCount: number }[]>`
    select
      event_id as "eventId",
      count(distinct entry_id)::int as "rowCount"
    FROM competition.entry_event_results
    WHERE season_id = ${season.seasonId}
      AND entry_id = ANY(${entryIds}::int[])
      AND event_id BETWEEN ${window.startEventId} AND ${window.endEventId}
    GROUP BY event_id
  `;
  const entryResultCountMap = new Map(entryResultCounts.map((row) => [row.eventId, row.rowCount]));

  for (let eventId = window.startEventId; eventId <= window.endEventId; eventId += 1) {
    if ((entryResultCountMap.get(eventId) ?? 0) < entryIds.length) {
      issues.push(`missing entry_event_results rows for event ${eventId}`);
      rerunEventIds.add(eventId);
    }
  }

  if (
    tournament.groupMode === 'points_races' &&
    tournament.groupStartedEventId &&
    tournament.groupEndedEventId
  ) {
    const overlapStart = Math.max(window.startEventId, tournament.groupStartedEventId);
    const overlapEnd = Math.min(window.endEventId, tournament.groupEndedEventId);

    if (overlapEnd >= overlapStart) {
      const pointsCounts = await client<{ eventId: number; rowCount: number }[]>`
        select
          event_id as "eventId",
          count(*)::int as "rowCount"
        FROM competition.tournament_points_group_results
        WHERE season_id = ${season.seasonId}
          AND tournament_id = ${tournament.id}
          AND event_id BETWEEN ${overlapStart} AND ${overlapEnd}
        GROUP BY event_id
      `;
      const pointsCountMap = new Map(pointsCounts.map((row) => [row.eventId, row.rowCount]));

      for (let eventId = overlapStart; eventId <= overlapEnd; eventId += 1) {
        if ((pointsCountMap.get(eventId) ?? 0) < entryIds.length) {
          issues.push(`missing tournament_points_group_results rows for event ${eventId}`);
          rerunEventIds.add(eventId);
        }
      }
    }
  }

  if (
    tournament.knockoutMode !== 'no_knockout' &&
    !isOfficialH2HTournament(tournament) &&
    tournament.knockoutStartedEventId &&
    tournament.knockoutEndedEventId
  ) {
    const overlapStart = Math.max(window.startEventId, tournament.knockoutStartedEventId);
    const overlapEnd = Math.min(window.endEventId, tournament.knockoutEndedEventId);

    if (overlapEnd >= overlapStart) {
      const expectedResultRows = buildKnockoutRows(tournament, null).results.reduce((map, row) => {
        map.set(row.event_id, (map.get(row.event_id) ?? 0) + 1);
        return map;
      }, new Map<number, number>());

      const knockoutCounts = await client<
        { eventId: number; rowCount: number; invalidCount: number }[]
      >`
        select
          event_id as "eventId",
          count(*)::int as "rowCount",
          count(*) filter (
            where (home_entry_id is null and away_entry_id is null) or match_winner is null
          )::int as "invalidCount"
        FROM competition.tournament_knockout_results
        WHERE season_id = ${season.seasonId}
          AND tournament_id = ${tournament.id}
          AND event_id BETWEEN ${overlapStart} AND ${overlapEnd}
        GROUP BY event_id
      `;
      const knockoutCountMap = new Map(knockoutCounts.map((row) => [row.eventId, row]));

      for (let eventId = overlapStart; eventId <= overlapEnd; eventId += 1) {
        const actual = knockoutCountMap.get(eventId);
        const expectedCount = expectedResultRows.get(eventId) ?? 0;
        if ((actual?.rowCount ?? 0) !== expectedCount || (actual?.invalidCount ?? 0) > 0) {
          issues.push(`invalid tournament_knockout_results rows for event ${eventId}`);
          rerunEventIds.add(eventId);
        }
      }
    }
  }

  return {
    issues,
    missingEntryInfoIds,
    missingEntryLeagueInfoIds,
    requiresStructureRebuild,
    rerunEventIds: [...rerunEventIds].sort((left, right) => left - right),
  };
}

export async function runTournamentAuditAndFixup(
  season: FplSeasonRef,
  tournament: TournamentConfig,
  entryIds: number[],
  window: TournamentBackfillWindow | null,
): Promise<TournamentSetupIssue[]> {
  const warnings: TournamentSetupIssue[] = [];
  const audit = await auditTournamentSetup(season, tournament, window);
  if (audit.issues.length === 0) {
    return warnings;
  }

  logInfo('Tournament setup audit detected issues, applying fix-up', {
    tournamentId: tournament.id,
    issues: audit.issues,
  });

  const missingEntryIds = uniqueNumbers([
    ...audit.missingEntryInfoIds,
    ...audit.missingEntryLeagueInfoIds,
  ]);
  if (missingEntryIds.length > 0) {
    // Entry FPL only — no structure global (same as primary setup path).
    const entrySyncIssues = await withMutationConflictGuard(
      {
        queueName: 'tournament-setup',
        jobName: 'tournament-setup',
        tournamentId: tournament.id,
        scopes: tournamentEntryCoreScopes(season.seasonId, missingEntryIds),
      },
      () =>
        syncTournamentEntryDetails(season, missingEntryIds, {
          targetEventId: window?.endEventId ?? 0,
        }),
    );
    warnings.push(...entrySyncIssues);
  }

  if (audit.requiresStructureRebuild) {
    const entrySeeds = await tournamentEntryRepository.findEntrySeedsByTournamentId(
      season,
      tournament.id,
    );
    // C4: audit rebuild must hold structure global (setup worker no longer
    // wraps the whole job — FP-07 Codex P1).
    await withMutationConflictGuard(
      {
        queueName: 'tournament-setup',
        jobName: 'tournament-setup',
        tournamentId: tournament.id,
        scopes: tournamentSetupRebuildScopes(tournament.id),
      },
      () => rebuildTournamentStructure(season, tournament, entrySeeds),
    );
    // Per-event structure locks inside backfillTournamentHistory.
    const backfillIssues = await backfillTournamentHistory(
      season,
      tournament.id,
      tournament,
      entryIds,
      window,
    );
    warnings.push(...backfillIssues);
  } else {
    for (const eventId of audit.rerunEventIds) {
      // Structure locks live inside runTournamentEventBackfill (points/knockout only).
      const rerunIssues = await runTournamentEventBackfill(
        season,
        tournament.id,
        tournament,
        entryIds,
        eventId,
      );
      warnings.push(...rerunIssues);
    }
  }

  const verifiedAudit = await auditTournamentSetup(season, tournament, window);
  const criticalIssues = verifiedAudit.issues.filter(isCriticalAuditIssue);
  if (criticalIssues.length > 0) {
    throw new Error(`Tournament setup audit failed: ${verifiedAudit.issues.join('; ')}`);
  }

  const recoverableIssues = verifiedAudit.issues.filter((issue) => !isCriticalAuditIssue(issue));
  if (recoverableIssues.length > 0) {
    logWarn('Tournament setup audit completed with recoverable issues', {
      tournamentId: tournament.id,
      issues: recoverableIssues,
    });
    warnings.push(
      ...recoverableIssues.map((message) => ({
        scope: 'event-results' as const,
        message: `Audit: ${message}`,
      })),
    );
  }

  return warnings;
}
