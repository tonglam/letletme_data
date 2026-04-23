import { enqueueTournamentSetup } from '../jobs/tournament-setup.jobs';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { NotFoundError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import { getCurrentEvent } from './events.service';
import { runTournamentAuditAndFixup } from './tournament-audit.service';
import {
  backfillTournamentHistory,
  syncTournamentEntryDetails,
} from './tournament-backfill.service';
import { rebuildTournamentStructure } from './tournament-structure.service';

import { getTournamentBackfillWindow } from '../domain/tournament';
import type { TournamentSetupIssue } from './tournament-backfill.service';

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
    setupIssues.push(...(await syncTournamentEntryDetails(entryIds)));

    const entrySeeds = await tournamentEntryRepository.findEntrySeedsByTournamentId(tournamentId);
    await rebuildTournamentStructure(tournament, entrySeeds);

    const currentEvent = await getCurrentEvent();
    const window = getTournamentBackfillWindow(tournament, currentEvent?.id ?? null);
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
): Promise<{ recovered: number[] }> {
  const stuck = await tournamentInfoRepository.findStuckProcessing(cutoffMinutes);
  if (stuck.length === 0) {
    return { recovered: [] };
  }

  const recovered: number[] = [];
  for (const row of stuck) {
    try {
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

  return { recovered };
}
