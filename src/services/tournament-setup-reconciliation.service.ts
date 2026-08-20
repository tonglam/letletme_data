import type { FplSeasonRef } from '../domain/fpl-season';
import { tournamentSetupLifecycleScope } from '../domain/mutation-scope';
import { getTournamentBackfillWindow } from '../domain/tournament';
import { enqueueTournamentRepair } from '../jobs/tournament-repair.jobs';
import { eventRepository } from '../repositories/events';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { tournamentSetupIssueRepository } from '../repositories/tournament-setup-issues';
import { auditTournamentSetup } from './tournament-audit.service';
import {
  normalizeTournamentSetupIssue,
  tournamentSetupIssueFromAuditMessage,
} from './tournament-backfill.service';
import { logInfo } from '../utils/logger';
import { withMutationScopes } from '../utils/mutation-scopes';

export async function reconcileReadyTournamentWarnings(season: FplSeasonRef): Promise<void> {
  const tournamentIds = await tournamentInfoRepository.findReadyWithWarnings(season);
  for (const tournamentId of tournamentIds) {
    await withMutationScopes(
      {
        queueName: 'tournament-repair',
        jobName: 'reconcile-ready-tournament',
        tournamentId,
        scopes: [tournamentSetupLifecycleScope(tournamentId)],
      },
      async () => {
        const tournament = await tournamentInfoRepository.findSetupConfig(season, tournamentId);
        if (!tournament) return;
        const currentStatus = await tournamentInfoRepository.findSetupStatus(season, tournamentId);
        const finalizedEvent = await eventRepository.findLatestFinalized(season);
        const window = getTournamentBackfillWindow(tournament, finalizedEvent?.id ?? null);
        const entryIds = await tournamentEntryRepository.findEntryIdsByTournamentId(
          season,
          tournamentId,
        );
        const audit = await auditTournamentSetup(season, tournament, window);
        const issues = audit.issues.map((message) =>
          normalizeTournamentSetupIssue(
            tournamentSetupIssueFromAuditMessage(message, {
              affectedEntryIds: message.startsWith('missing entry_league_infos')
                ? audit.missingEntryLeagueInfoIds
                : message.startsWith('missing entry_infos')
                  ? audit.missingEntryInfoIds
                  : entryIds,
            }),
          ),
        );
        if (issues.length === 0 && (currentStatus?.setupWarningCount ?? 0) > 0) {
          logInfo('Preserving legacy ready tournament warning without verifiable issue', {
            tournamentId,
            warningCount: currentStatus?.setupWarningCount ?? 0,
          });
          return;
        }
        await tournamentSetupIssueRepository.sync(season, tournamentId, issues);
        const unresolved = await tournamentSetupIssueRepository.listUnresolved(
          season,
          tournamentId,
        );
        await Promise.all(
          unresolved.map((issue) => enqueueTournamentRepair(season, issue, 'reconciliation')),
        );
        logInfo('Reconciled ready tournament warnings', {
          tournamentId,
          warningCount: unresolved.filter((issue) => issue.severity === 'warning').length,
        });
      },
    );
  }
}
