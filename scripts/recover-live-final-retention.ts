import { parseArgs } from 'node:util';

export function parseRecoveryArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      season: { type: 'string' },
      events: { type: 'string' },
      apply: { type: 'boolean', default: false },
      reason: { type: 'string' },
    },
  });
  if (!values.season || !/^\d{4}$/.test(values.season))
    throw new Error('--season requires a season code');
  if (!values.events || !/^\d+(,\d+)*$/.test(values.events))
    throw new Error('--events requires an explicit comma-separated event list');
  const events = values.events.split(',').map(Number);
  if (
    events.length > 38 ||
    new Set(events).size !== events.length ||
    events.some((event) => event < 1 || event > 38)
  ) {
    throw new Error('--events must contain distinct gameweeks from 1 to 38');
  }
  if (values.apply && (!values.reason?.trim() || values.reason.length > 300))
    throw new Error('--apply requires a bounded --reason');
  return {
    season: values.season,
    events: events.sort((a, b) => a - b),
    apply: values.apply,
    reason: values.reason?.trim(),
  };
}

async function main() {
  const args = parseRecoveryArgs(process.argv.slice(2));
  const { seasonRepository } = await import('../src/repositories/seasons');
  const { eventRepository } = await import('../src/repositories/events');
  const { getLatestFailedSchedulerObligation } = await import(
    '../src/repositories/scheduler-obligations'
  );
  const season = await seasonRepository.findCurrent();
  if (season.seasonCode !== args.season)
    throw new Error('Recovery is limited to the canonical current season');
  const targets = [];
  // Validate the entire bounded scope before importing any queue or enqueueing.
  for (const eventId of args.events) {
    const event = await eventRepository.findById(season, eventId);
    if (!event?.finished || !event.dataChecked)
      throw new Error(`Event ${eventId} is not finalized`);
    const target = await getLatestFailedSchedulerObligation({
      jobName: 'live-final-retention',
      scopeKey: `${season.seasonCode}:event:${eventId}`,
    });
    if (!target) throw new Error(`Event ${eventId} has no failed retention obligation`);
    targets.push({
      eventId,
      obligationId: target.obligationId,
      periodKey: target.periodKey,
      generation: target.generation,
      ...(args.apply && args.reason ? { recoveryReason: args.reason } : {}),
    });
  }
  process.stdout.write(
    JSON.stringify({
      mode: args.apply ? 'apply' : 'inspect',
      season: args.season,
      reason: args.reason,
      targets,
    }) + '\n',
  );
  if (!args.apply) return;
  const { enqueueLiveFinalRetention } = await import('../src/jobs/live-data.jobs');
  for (const { eventId, ...retentionRecoveryTarget } of targets) {
    const job = await enqueueLiveFinalRetention(season, eventId, 'manual', {
      retentionRecoveryTarget,
      jobId: `manual-retention-recovery-e${eventId}-${retentionRecoveryTarget.obligationId}-g${retentionRecoveryTarget.generation}`,
      reuseExisting: true,
    });
    if (!job) throw new Error(`Event ${eventId} recovery was not enqueued`);
    process.stdout.write(JSON.stringify({ eventId, jobId: job.id, status: 'enqueued' }) + '\n');
  }
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error instanceof Error ? error.message : 'Recovery failed');
      process.exit(1);
    },
  );
}
