import { and, eq, notInArray, sql } from 'drizzle-orm';

import { tournamentSetupIssuesInCompetition } from '../db/schemas/index.schema';
import { getDb, type DbHandle } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import {
  dedupeSetupIssueEntries,
  type TournamentSetupIssueCategory,
  type TournamentSetupIssueCode,
  type TournamentSetupIssueSeverity,
  type TournamentSetupIssueInput,
  type TournamentSetupIssueRecord,
} from '../domain/tournament-setup-issue';

const table = tournamentSetupIssuesInCompetition;

function timestamp(value: Date | string | null): Date | null {
  return value instanceof Date || value === null ? value : new Date(value);
}

export const createTournamentSetupIssueRepository = (dbInstance?: DbHandle) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  return {
    findUnresolvedById: async (
      season: FplSeasonRef,
      issueId: number,
    ): Promise<TournamentSetupIssueRecord | null> => {
      const db = await getDbInstance();
      const rows = await db
        .select()
        .from(table)
        .where(
          and(
            eq(table.seasonId, season.seasonId),
            eq(table.issueId, issueId),
            sql`${table.resolvedAt} IS NULL`,
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        ...row,
        issueId: Number(row.issueId),
        code: row.code as TournamentSetupIssueCode,
        category: row.category as TournamentSetupIssueCategory,
        severity: row.severity as TournamentSetupIssueSeverity,
        affectedEntryIds: row.affectedEntryIds ?? [],
        nextRepairAt: timestamp(row.nextRepairAt),
        repairExhaustedAt: timestamp(row.repairExhaustedAt),
        firstSeenAt: timestamp(row.firstSeenAt) ?? new Date(0),
        lastSeenAt: timestamp(row.lastSeenAt) ?? new Date(0),
        resolvedAt: timestamp(row.resolvedAt),
      };
    },

    listUnresolved: async (
      season: FplSeasonRef,
      tournamentId: number,
    ): Promise<TournamentSetupIssueRecord[]> => {
      const db = await getDbInstance();
      const rows = await db
        .select()
        .from(table)
        .where(
          and(
            eq(table.seasonId, season.seasonId),
            eq(table.tournamentId, tournamentId),
            sql`${table.resolvedAt} IS NULL`,
          ),
        )
        .orderBy(table.issueKey);
      return rows.map((row) => ({
        ...row,
        issueId: Number(row.issueId),
        code: row.code as TournamentSetupIssueCode,
        category: row.category as TournamentSetupIssueCategory,
        severity: row.severity as TournamentSetupIssueSeverity,
        affectedEntryIds: row.affectedEntryIds ?? [],
        eventId: row.eventId,
        nextRepairAt: timestamp(row.nextRepairAt),
        repairExhaustedAt: timestamp(row.repairExhaustedAt),
        firstSeenAt: timestamp(row.firstSeenAt) ?? new Date(0),
        lastSeenAt: timestamp(row.lastSeenAt) ?? new Date(0),
        resolvedAt: timestamp(row.resolvedAt),
      }));
    },

    sync: async (
      season: FplSeasonRef,
      tournamentId: number,
      issues: TournamentSetupIssueInput[],
      options?: { preserveUnresolvedIssueKeys?: readonly string[] },
    ): Promise<{ warningCount: number; unresolvedCount: number }> => {
      const db = await getDbInstance();
      const now = new Date();
      const normalized = issues.map((issue) => ({
        ...issue,
        affectedEntryIds: dedupeSetupIssueEntries(issue.affectedEntryIds),
      }));

      for (const issue of normalized) {
        const affectedEntryIds = sql.param(issue.affectedEntryIds, table.affectedEntryIds);
        await db.execute(sql`
          INSERT INTO competition.tournament_setup_issues (
            season_id,
            tournament_id,
            issue_key,
            code,
            category,
            severity,
            event_id,
            affected_entry_ids,
            affected_entry_count,
            diagnostic_code,
            internal_message,
            next_repair_at,
            last_seen_at,
            resolved_at,
            updated_at
          ) VALUES (
            ${season.seasonId},
            ${tournamentId},
            ${issue.issueKey},
            ${issue.code},
            ${issue.category},
            ${issue.severity},
            ${issue.eventId ?? null},
            ${affectedEntryIds},
            ${issue.affectedEntryIds.length},
            ${issue.diagnosticCode ?? null},
            ${issue.internalMessage ?? null},
            ${issue.nextRepairAt ?? null},
            ${now},
            NULL,
            ${now}
          )
          ON CONFLICT (season_id, tournament_id, issue_key)
          DO UPDATE SET
            code = EXCLUDED.code,
            category = EXCLUDED.category,
            severity = EXCLUDED.severity,
            event_id = EXCLUDED.event_id,
            affected_entry_ids = EXCLUDED.affected_entry_ids,
            affected_entry_count = EXCLUDED.affected_entry_count,
            diagnostic_code = EXCLUDED.diagnostic_code,
            internal_message = EXCLUDED.internal_message,
            next_repair_at = CASE
              WHEN competition.tournament_setup_issues.resolved_at IS NOT NULL
                THEN EXCLUDED.next_repair_at
              WHEN competition.tournament_setup_issues.repair_exhausted_at IS NULL
                THEN EXCLUDED.next_repair_at
              ELSE competition.tournament_setup_issues.next_repair_at
            END,
            repair_attempts = CASE
              WHEN competition.tournament_setup_issues.resolved_at IS NOT NULL THEN 0
              ELSE competition.tournament_setup_issues.repair_attempts
            END,
            repair_exhausted_at = CASE
              WHEN competition.tournament_setup_issues.resolved_at IS NOT NULL THEN NULL
              ELSE competition.tournament_setup_issues.repair_exhausted_at
            END,
            last_seen_at = EXCLUDED.last_seen_at,
            resolved_at = NULL,
            updated_at = EXCLUDED.updated_at
        `);
      }

      const keys = [
        ...new Set([
          ...normalized.map((issue) => issue.issueKey),
          ...(options?.preserveUnresolvedIssueKeys ?? []),
        ]),
      ];
      if (keys.length === 0) {
        await db.execute(sql`
          UPDATE competition.tournament_setup_issues
          SET resolved_at = ${now},
              next_repair_at = NULL,
              updated_at = ${now}
          WHERE season_id = ${season.seasonId}
            AND tournament_id = ${tournamentId}
            AND resolved_at IS NULL
        `);
      } else {
        await db.execute(sql`
          UPDATE competition.tournament_setup_issues
          SET resolved_at = ${now},
              next_repair_at = NULL,
              updated_at = ${now}
          WHERE season_id = ${season.seasonId}
            AND tournament_id = ${tournamentId}
            AND resolved_at IS NULL
            AND ${notInArray(table.issueKey, keys)}
        `);
      }
      const [counts] = await db.execute<{ warningCount: number; unresolvedCount: number }>(sql`
        SELECT
          count(*) FILTER (WHERE resolved_at IS NULL AND severity = 'warning')::int AS "warningCount",
          count(*) FILTER (WHERE resolved_at IS NULL)::int AS "unresolvedCount"
        FROM competition.tournament_setup_issues
        WHERE season_id = ${season.seasonId}
          AND tournament_id = ${tournamentId}
      `);
      const warningCount = Number(counts?.warningCount ?? 0);
      const unresolvedCount = Number(counts?.unresolvedCount ?? 0);
      await db.execute(sql`
        UPDATE competition.tournaments t
        SET
          setup_warning_count = ${warningCount},
          setup_error = CASE
            WHEN t.setup_status = 'ready' THEN NULL
            ELSE t.setup_error
          END,
          profiles_ready_at = CASE
            WHEN NOT EXISTS (
              SELECT 1 FROM competition.tournament_setup_issues i
              WHERE i.season_id = t.season_id
                AND i.tournament_id = t.tournament_id
                AND i.category = 'profiles'
                AND i.resolved_at IS NULL
            ) THEN COALESCE(t.profiles_ready_at, ${now})
            ELSE NULL
          END,
          insights_ready_at = CASE
            WHEN NOT EXISTS (
              SELECT 1 FROM competition.tournament_setup_issues i
              WHERE i.season_id = t.season_id
                AND i.tournament_id = t.tournament_id
                AND i.category IN ('insights', 'results')
                AND i.resolved_at IS NULL
            ) THEN COALESCE(t.insights_ready_at, ${now})
            ELSE NULL
          END,
          updated_at = ${now}
        WHERE t.season_id = ${season.seasonId}
          AND t.tournament_id = ${tournamentId}
      `);

      return { warningCount, unresolvedCount };
    },

    findRepairableDue: async (limit = 50): Promise<TournamentSetupIssueRecord[]> => {
      const db = await getDbInstance();
      const rows = await db
        .select()
        .from(table)
        .where(
          and(
            sql`${table.resolvedAt} IS NULL`,
            sql`${table.nextRepairAt} IS NOT NULL`,
            sql`${table.nextRepairAt} <= clock_timestamp()`,
            sql`(${table.repairExhaustedAt} IS NULL OR ${table.repairExhaustedAt} <= clock_timestamp())`,
          ),
        )
        .orderBy(table.nextRepairAt)
        .limit(limit);
      return rows.map((row) => ({
        ...row,
        issueId: Number(row.issueId),
        code: row.code as TournamentSetupIssueCode,
        category: row.category as TournamentSetupIssueCategory,
        severity: row.severity as TournamentSetupIssueSeverity,
        affectedEntryIds: row.affectedEntryIds ?? [],
        nextRepairAt: timestamp(row.nextRepairAt),
        repairExhaustedAt: timestamp(row.repairExhaustedAt),
        firstSeenAt: timestamp(row.firstSeenAt) ?? new Date(0),
        lastSeenAt: timestamp(row.lastSeenAt) ?? new Date(0),
        resolvedAt: timestamp(row.resolvedAt),
      }));
    },

    recordRepairAttempt: async (
      issueId: number,
      nextRepairAt: Date | null,
      exhausted: boolean,
    ): Promise<void> => {
      const db = await getDbInstance();
      await db
        .update(table)
        .set({
          repairAttempts: sql`${table.repairAttempts} + 1`,
          nextRepairAt,
          repairExhaustedAt: exhausted ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(table.issueId, issueId));
    },
  };
};

export const tournamentSetupIssueRepository = createTournamentSetupIssueRepository();
