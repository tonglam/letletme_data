import { tournamentSetupRebuildScopes } from '../domain/mutation-scope';
import { getTournamentBackfillWindow } from '../domain/tournament';
import { enqueueTournamentSetup } from '../jobs/tournament-setup.jobs';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { NotFoundError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import { withMutationConflictGuard } from '../utils/mutation-lock';

import { getCurrentEvent } from './events.service';
import { runTournamentAuditAndFixup } from './tournament-audit.service';
import {
  backfillTournamentHistory,
  syncTournamentEntryDetails,
  type TournamentSetupIssue,
} from './tournament-backfill.service';
import { rebuildTournamentStructure } from './tournament-structure.service';

export { ensureKnockoutRoundOneSeeded } from './tournament-seed.service';

function formatSetupWarning(issues: TournamentSetupIssue[]): string | null {
  if (issues.length === 0) {
    return null;
  }

  const uniqueMessages = [...new Set(issues.map((issue) => issue.message.trim()).filter(Boolean))];
  if (uniqueMessages.length === 0) {
    return null;
  }

  const preview = uniqueMessages.slice(0, 5).join('; ');
  const overflow =
    uniqueMessages.length > 5 ? `; and ${uniqueMessages.length - 5} more warning(s)` : '';
  return `Setup completed with warnings: ${preview}${overflow}`;
}

export async function setupTournamentStructure(tournamentId: number): Promise<void> {
  logInfo('Starting tournament setup', { tournamentId });
  await tournamentInfoRepository.markSetupProcessing(tournamentId);

  try {
    const setupIssues: TournamentSetupIssue[] = [];
    const tournament = await tournamentInfoRepository.findSetupConfig(tournamentId);
    if (!tournament) {
      throw new NotFoundError('Tournament not found.', 'TOURNAMENT_NOT_FOUND');
    }

    const entryIds = await tournamentEntryRepository.findEntryIdsByTournamentId(tournamentId);

    // Entry FPL sync: entry-core only — do NOT hold tournament-structure:global
    // across potentially long external HTTP (FP-07 Codex P1).
    setupIssues.push(
      ...(await withMutationConflictGuard(
        {
          queueName: 'tournament-setup',
          jobName: 'tournament-setup',
          tournamentId,
          scopes: ['entry-core:all'],
        },
        () => syncTournamentEntryDetails(entryIds),
      )),
    );

    const entrySeeds = await tournamentEntryRepository.findEntrySeedsByTournamentId(tournamentId);

    // Structure rebuild: per-tournament + global (C4 mutual exclusion with results).
    await withMutationConflictGuard(
      {
        queueName: 'tournament-setup',
        jobName: 'tournament-setup',
        tournamentId,
        scopes: tournamentSetupRebuildScopes(tournamentId),
      },
      () => rebuildTournamentStructure(tournament, entrySeeds),
    );

    const currentEvent = await getCurrentEvent();
    const window = getTournamentBackfillWindow(tournament, currentEvent?.id ?? null);
    // Per-event structure locks inside backfillTournamentHistory / audit backfill.
    setupIssues.push(
      ...(await backfillTournamentHistory(tournamentId, tournament, entryIds, window)),
    );
    setupIssues.push(...(await runTournamentAuditAndFixup(tournament, entryIds, window)));

    const warningMessage = formatSetupWarning(setupIssues);
    await tournamentInfoRepository.markSetupResult(tournamentId, 'ready', warningMessage);
    logInfo('Tournament setup completed', {
      tournamentId,
      backfillStartEventId: window?.startEventId ?? null,
      backfillEndEventId: window?.endEventId ?? null,
      warnings: setupIssues.length,
      warningMessage,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tournament setup failed.';
    logError('Tournament setup failed', error, { tournamentId });
    await tournamentInfoRepository.markSetupResult(tournamentId, 'failed', message);
    throw error;
  }
}

export async function requeueTournamentSetup(tournamentId: number) {
  const tournament = await tournamentInfoRepository.findSetupConfig(tournamentId);
  if (!tournament) {
    throw new NotFoundError('Tournament not found.', 'TOURNAMENT_NOT_FOUND');
  }

  return enqueueTournamentSetup(tournamentId, 'manual', { forceNew: true });
}

export async function recoverStuckTournamentSetups(
  cutoffMinutes: number,
  isActive?: (tournamentId: number) => Promise<boolean>,
): Promise<{ recovered: number[]; skippedActive: number[] }> {
  const stuck = await tournamentInfoRepository.findStuckProcessing(cutoffMinutes);
  if (stuck.length === 0) {
    return { recovered: [], skippedActive: [] };
  }

  const recovered: number[] = [];
  const skippedActive: number[] = [];
  for (const row of stuck) {
    try {
      if (isActive && (await isActive(row.id))) {
        skippedActive.push(row.id);
        logInfo('Skipping recovery of setup with active worker job', {
          tournamentId: row.id,
          setupStartedAt: row.setupStartedAt,
        });
        continue;
      }

      await tournamentInfoRepository.markSetupResult(
        row.id,
        'failed',
        `Setup stuck in processing since ${row.setupStartedAt ?? 'unknown'}; re-enqueued by watchdog.`,
      );
      await enqueueTournamentSetup(row.id, 'watchdog', { forceNew: true });
      recovered.push(row.id);
      logInfo('Watchdog recovered stuck tournament setup', {
        tournamentId: row.id,
        setupStartedAt: row.setupStartedAt,
      });
    } catch (error) {
      logError('Watchdog failed to recover stuck tournament setup', error, {
        tournamentId: row.id,
      });
    }
  }

  return { recovered, skippedActive };
}
