import { syncEvents } from '../../../src/services/events.service';
import { syncPlayers } from '../../../src/services/players.service';
import { syncTeams } from '../../../src/services/teams.service';

let eventsReady: Promise<void> | undefined;
let teamsReady: Promise<void> | undefined;
let playersReady: Promise<void> | undefined;

function retryable(task: () => Promise<void>, reset: () => void): Promise<void> {
  return task().catch((error) => {
    reset();
    throw error;
  });
}

/** Seed FPL reference tables once, in foreign-key order, for this test process. */
export function ensureEvents(): Promise<void> {
  eventsReady ??= retryable(
    async () => {
      await syncEvents();
    },
    () => {
      eventsReady = undefined;
    },
  );
  return eventsReady;
}

export function ensureTeams(): Promise<void> {
  teamsReady ??= retryable(
    async () => {
      await ensureEvents();
      await syncTeams();
    },
    () => {
      teamsReady = undefined;
    },
  );
  return teamsReady;
}

export function ensurePlayers(): Promise<void> {
  playersReady ??= retryable(
    async () => {
      await ensureTeams();
      await syncPlayers();
    },
    () => {
      playersReady = undefined;
    },
  );
  return playersReady;
}
