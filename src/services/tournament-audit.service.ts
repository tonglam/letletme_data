import { getDbClient } from '../db/singleton';
import { tournamentSetupRebuildScopes } from '../domain/mutation-scope';
import {
  buildKnockoutRows,
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
    issue.startsWith('invalid group_index sequence') ||
    issue.startsWith('knockout structure mismatch')
  );
}

async function loadPresentEntryInfoIds(entryIds: number[]): Promise<number[]> {
  if (entryIds.length === 0) {
    return [];
  }
  const client = await getDbClient();
  const rows = await client<{ entryId: number }[]>`
    select id as "entryId"
    from entry_infos
    where id = any(${entryIds})
  `;
  return rows.map((row) => row.entryId);
}

async function loadPresentEntryLeagueInfoIds(entryIds: number[]): Promise<number[]> {
  if (entryIds.length === 0) {
    return [];
  }
  const client = await getDbClient();
  const rows = await client<{ entryId: number }[]>`
    select distinct entry_id as "entryId"
    from entry_league_infos
    where entry_id = any(${entryIds})
  `;
  return rows.map((row) => row.entryId);
}

export async function auditTournamentSetup(
  tournament: TournamentConfig,
  window: TournamentBackfillWindow | null,
): Promise<TournamentAuditResult> {
  const issues: string[] = [];
  const rerunEventIds = new Set<number>();
  const client = await getDbClient();
  const entryIds = await tournamentEntryRepository.findEntryIdsByTournamentId(tournament.id);

  if (entryIds.length !== tournament.totalTeamNum) {
    issues.push(
      `tournament_entries count ${entryIds.length} does not match total_team_num ${tournament.totalTeamNum}`,
    );
  }

  const presentEntryInfoIds = new Set(await loadPresentEntryInfoIds(entryIds));
  const missingEntryInfoIds = entryIds.filter((entryId) => !presentEntryInfoIds.has(entryId));
  if (missingEntryInfoIds.length > 0) {
    issues.push(`missing entry_infos for ${missingEntryInfoIds.length} entries`);
  }

  const presentEntryLeagueInfoIds = new Set(await loadPresentEntryLeagueInfoIds(entryIds));
  const missingEntryLeagueInfoIds = entryIds.filter(
    (entryId) => !presentEntryLeagueInfoIds.has(entryId),
  );
  if (missingEntryLeagueInfoIds.length > 0) {
    issues.push(`missing entry_league_infos for ${missingEntryLeagueInfoIds.length} entries`);
  }

  let requiresStructureRebuild = false;

  if (tournament.groupMode === 'points_races') {
    const groupRows = await tournamentGroupRepository.findGroupSlots(tournament.id);

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

  if (tournament.knockoutMode !== 'no_knockout') {
    const expectedKnockoutRows = buildKnockoutRows(tournament, null);
    const expectedMatchCount = expectedKnockoutRows.matches.length;
    const expectedResultCount = expectedKnockoutRows.results.length;

    const [knockoutCount] = await client<{ matchCount: number; resultCount: number }[]>`
      select
        (select count(*)::int from tournament_knockouts where tournament_id = ${tournament.id}) as "matchCount",
        (select count(*)::int from tournament_knockout_results where tournament_id = ${tournament.id}) as "resultCount"
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
    from entry_event_results
    where entry_id = any(${entryIds})
      and event_id between ${window.startEventId} and ${window.endEventId}
    group by event_id
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
        from tournament_points_group_results
        where tournament_id = ${tournament.id}
          and event_id between ${overlapStart} and ${overlapEnd}
        group by event_id
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
            where home_entry_id is null or away_entry_id is null or match_winner is null
          )::int as "invalidCount"
        from tournament_knockout_results
        where tournament_id = ${tournament.id}
          and event_id between ${overlapStart} and ${overlapEnd}
        group by event_id
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
  tournament: TournamentConfig,
  entryIds: number[],
  window: TournamentBackfillWindow | null,
): Promise<TournamentSetupIssue[]> {
  const warnings: TournamentSetupIssue[] = [];
  const audit = await auditTournamentSetup(tournament, window);
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
        scopes: ['entry-core:all'],
      },
      () => syncTournamentEntryDetails(missingEntryIds),
    );
    warnings.push(...entrySyncIssues);
  }

  if (audit.requiresStructureRebuild) {
    const entrySeeds = await tournamentEntryRepository.findEntrySeedsByTournamentId(tournament.id);
    // C4: audit rebuild must hold structure global (setup worker no longer
    // wraps the whole job — FP-07 Codex P1).
    await withMutationConflictGuard(
      {
        queueName: 'tournament-setup',
        jobName: 'tournament-setup',
        tournamentId: tournament.id,
        scopes: tournamentSetupRebuildScopes(tournament.id),
      },
      () => rebuildTournamentStructure(tournament, entrySeeds),
    );
    // Per-event structure locks inside backfillTournamentHistory.
    const backfillIssues = await backfillTournamentHistory(
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
        tournament.id,
        tournament,
        entryIds,
        eventId,
      );
      warnings.push(...rerunIssues);
    }
  }

  const verifiedAudit = await auditTournamentSetup(tournament, window);
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
