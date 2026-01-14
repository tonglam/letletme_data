import { eventStandingsCache } from '../cache/operations';
import { pulseliveClient } from '../clients/pulselive';
import type { EventStanding, RawPulseLiveStandingsEntry } from '../types';
import { eventStandingsRepository } from '../repositories/event-standings';
import { getTeams } from './teams.service';
import { getCurrentEvent } from './events.service';
import { getConfig } from '../utils/config';
import { logError, logInfo, logWarn } from '../utils/logger';

function mapStandings(
  eventId: number,
  entries: RawPulseLiveStandingsEntry[],
  teamMap: Map<string, { id: number; name: string; shortName: string }>,
): EventStanding[] {
  const results: EventStanding[] = [];

  for (const entry of entries) {
    const abbr = entry.team.club.abbr;
    const team = teamMap.get(abbr) ?? teamMap.get(abbr.toUpperCase());
    if (!team) {
      logWarn('No team mapping for standings entry', { abbr });
      continue;
    }

    results.push({
      eventId,
      position: entry.position,
      teamId: team.id,
      teamName: team.name,
      teamShortName: team.shortName,
      points: entry.overall.points,
      played: entry.overall.played,
      won: entry.overall.won,
      drawn: entry.overall.drawn,
      lost: entry.overall.lost,
      goalsFor: entry.overall.goalsFor,
      goalsAgainst: entry.overall.goalsAgainst,
      goalsDifference: entry.overall.goalsDifference,
    });
  }

  return results;
}

export async function syncEventStandings(
  eventId?: number,
): Promise<{ eventId: number; count: number }> {
  try {
    const currentEventId = eventId ?? (await getCurrentEvent())?.id;
    if (!currentEventId) {
      throw new Error('No current event found for event standings');
    }

    const { PULSELIVE_COMP_SEASON: compSeason } = getConfig();
    if (!compSeason) {
      throw new Error('PULSELIVE_COMP_SEASON is required for event standings sync');
    }

    logInfo('Starting event standings sync', { eventId: currentEventId, compSeason });

    const standingsRes = await pulseliveClient.getStandings(compSeason);
    const table = standingsRes.tables[0];
    const entries = table?.entries ?? [];

    if (entries.length === 0) {
      logInfo('No standings entries found', { eventId: currentEventId });
      await eventStandingsCache.clearByEventId(currentEventId);
      return { eventId: currentEventId, count: 0 };
    }

    const teams = await getTeams();
    const teamMap = new Map(teams.map((team) => [team.shortName, team]));
    const standings = mapStandings(currentEventId, entries, teamMap);

    const count = await eventStandingsRepository.replaceAll(standings);

    if (count > 0) {
      await eventStandingsCache.set(currentEventId, standings);
    } else {
      await eventStandingsCache.clearByEventId(currentEventId);
    }

    logInfo('Event standings sync completed', { eventId: currentEventId, count });
    return { eventId: currentEventId, count };
  } catch (error) {
    logError('Event standings sync failed', error);
    throw error;
  }
}
