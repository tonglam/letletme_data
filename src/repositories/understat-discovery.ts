import type { DbOrTransaction } from '../db/singleton';
import type { UnderstatPlayerDiscovery, UnderstatTeamDiscovery } from '../domain/understat';
import {
  createUnderstatPlayerRepository,
  createUnderstatReferenceRepository,
  createUnderstatTeamRepository,
} from './understat';

/**
 * Persist a discovery graph in foreign-key order. PostgreSQL transactions do
 * not make concurrently submitted statements dependency-aware, so these
 * writes must not be grouped in Promise.all on a fresh season.
 */
export async function persistUnderstatTeamDiscovery(
  tx: DbOrTransaction,
  discovery: UnderstatTeamDiscovery,
): Promise<boolean> {
  const references = createUnderstatReferenceRepository(tx);
  const teams = createUnderstatTeamRepository(tx);
  if (discovery.season.state === 'active') {
    await references.completeOlderSeasons(discovery.season.season);
  }
  await references.upsertSeason(discovery.season);
  const teamChanges = await references.upsertTeams(discovery.teams);
  const matchChanges = await references.upsertMatches(discovery.matches);
  const matchStatChanges = await teams.upsertMatchStats(discovery.teamMatchStats);
  const teamSeasonChanges = await teams.upsertTeamSeasons(discovery.teamSeasons);
  return [teamChanges, matchChanges, matchStatChanges, teamSeasonChanges].some(
    (count) => count > 0,
  );
}

export async function persistUnderstatPlayerDiscovery(
  tx: DbOrTransaction,
  discovery: UnderstatPlayerDiscovery,
): Promise<boolean> {
  const references = createUnderstatReferenceRepository(tx);
  const players = createUnderstatPlayerRepository(tx);
  if (discovery.season.state === 'active') {
    await references.completeOlderSeasons(discovery.season.season);
  }
  await references.upsertSeason(discovery.season);
  const teamChanges = await references.upsertTeams(discovery.teams);
  const matchChanges = await references.upsertMatches(discovery.matches);
  const playerChanges = await players.upsertPlayers(discovery.players);
  const seasonsChanged = await players.replacePlayerSeasons(
    discovery.season.season,
    discovery.playerSeasons,
  );
  return seasonsChanged || [teamChanges, matchChanges, playerChanges].some((count) => count > 0);
}
