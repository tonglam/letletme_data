import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import { enqueueUnderstatPlayerSync, enqueueUnderstatTeamSync } from './understat-enqueue';
import { hasRecentUnderstatSuccess } from '../services/understat-status.service';
import { getConfig } from '../utils/config';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logInfo } from '../utils/logger';
import { notifyTwoBots } from '../utils/notify';
import { CRON_TIMEZONE } from '../utils/timezone';

function tracked(name: string, operation: () => Promise<void>): Promise<void> {
  return executeTrackedCron(name, operation)
    .then(() => undefined)
    .catch(() => undefined);
}

export function registerUnderstatJobs(app: Elysia) {
  const config = getConfig();
  if (!config.UNDERSTAT_ENABLED || !config.UNDERSTAT_SCHEDULES_ENABLED) return app;
  const season = config.UNDERSTAT_SEASON;
  return app
    .use(
      cron({
        name: 'understat-team-incremental',
        pattern: '15 10 * * *',
        timezone: CRON_TIMEZONE,
        run: () =>
          tracked('understat-team-incremental', async () => {
            const { job, runId } = await enqueueUnderstatTeamSync({
              season,
              mode: 'incremental',
              trigger: 'cron',
            });
            logInfo('Understat team incremental enqueued', { jobId: job.id, runId, season });
          }),
      }),
    )
    .use(
      cron({
        name: 'understat-player-incremental',
        pattern: '30 10 * * *',
        timezone: CRON_TIMEZONE,
        run: () =>
          tracked('understat-player-incremental', async () => {
            const { job, runId } = await enqueueUnderstatPlayerSync({
              season,
              mode: 'incremental',
              trigger: 'cron',
            });
            logInfo('Understat player incremental enqueued', { jobId: job.id, runId, season });
          }),
      }),
    )
    .use(
      cron({
        name: 'understat-team-reconcile',
        pattern: '0 11 * * 2',
        timezone: CRON_TIMEZONE,
        run: () =>
          tracked('understat-team-reconcile', async () => {
            await enqueueUnderstatTeamSync({ season, mode: 'reconcile', trigger: 'cron' });
          }),
      }),
    )
    .use(
      cron({
        name: 'understat-player-participants-full',
        pattern: '15 11 * * 2',
        timezone: CRON_TIMEZONE,
        run: () =>
          tracked('understat-player-participants-full', async () => {
            await enqueueUnderstatPlayerSync({
              season,
              mode: 'full',
              trigger: 'cron',
              participantsOnly: true,
            });
          }),
      }),
    )
    .use(
      cron({
        name: 'understat-player-reconcile',
        pattern: '30 11 * * *',
        timezone: CRON_TIMEZONE,
        run: () =>
          tracked('understat-player-reconcile', async () => {
            await enqueueUnderstatPlayerSync({ season, mode: 'reconcile', trigger: 'cron' });
          }),
      }),
    )
    .use(
      cron({
        name: 'understat-staleness-monitor',
        pattern: '0 12 * * *',
        timezone: CRON_TIMEZONE,
        run: () =>
          tracked('understat-staleness-monitor', async () => {
            if ((await hasRecentUnderstatSuccess(season)) === false) {
              await notifyTwoBots(
                `Understat ${season} has no successful team/player publication in 36 hours`,
              );
            }
          }),
      }),
    );
}
