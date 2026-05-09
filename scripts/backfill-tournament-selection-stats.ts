#!/usr/bin/env bun

import { databaseSingleton } from '../src/db/singleton';
import { syncTournamentSelectionStats } from '../src/services/tournament-selection-stats.service';

function parseEventIds(args: string[]): number[] {
  const eventIds = new Set<number>();

  for (const arg of args) {
    if (arg.startsWith('--event=')) {
      const eventId = Number(arg.slice('--event='.length));
      if (Number.isInteger(eventId) && eventId > 0) eventIds.add(eventId);
    } else if (arg.startsWith('--from=') || arg.startsWith('--to=')) {
      continue;
    } else {
      const eventId = Number(arg);
      if (Number.isInteger(eventId) && eventId > 0) eventIds.add(eventId);
    }
  }

  const fromArg = args.find((arg) => arg.startsWith('--from='));
  const toArg = args.find((arg) => arg.startsWith('--to='));
  if (fromArg && toArg) {
    const from = Number(fromArg.slice('--from='.length));
    const to = Number(toArg.slice('--to='.length));
    if (Number.isInteger(from) && Number.isInteger(to) && from > 0 && to >= from) {
      for (let eventId = from; eventId <= to; eventId += 1) {
        eventIds.add(eventId);
      }
    }
  }

  return [...eventIds].sort((a, b) => a - b);
}

async function main() {
  const eventIds = parseEventIds(Bun.argv.slice(2));
  if (eventIds.length === 0) {
    console.error(
      'Usage: bun scripts/backfill-tournament-selection-stats.ts --event=35 OR --from=1 --to=38',
    );
    process.exitCode = 1;
    return;
  }

  for (const eventId of eventIds) {
    const result = await syncTournamentSelectionStats(eventId);
    console.log(JSON.stringify(result));
  }
}

try {
  await main();
} finally {
  await databaseSingleton.disconnect();
}
