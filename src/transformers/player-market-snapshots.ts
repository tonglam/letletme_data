import type { FPLBootstrapResponse, RawFPLElement } from '../clients/fpl';
import {
  validateCompleteMarketSnapshotBatch,
  validatePlayerMarketSnapshot,
  type PlayerMarketSnapshot,
} from '../domain/player-market-snapshots';
import { getPlayerPosition } from '../domain/players';
import { formatCronCalendarDate } from '../utils/timezone';

function parseOwnership(rawOwnership: string, elementId: number): number {
  const ownership = Number(rawOwnership);
  if (!Number.isFinite(ownership) || ownership < 0 || ownership > 100) {
    throw new Error(`Invalid ownership for player ${elementId}: ${rawOwnership}`);
  }
  return ownership;
}

function parseNewsAdded(rawTimestamp: string | null, elementId: number): Date | null {
  if (rawTimestamp === null) {
    return null;
  }

  const timestamp = new Date(rawTimestamp);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(`Invalid news timestamp for player ${elementId}: ${rawTimestamp}`);
  }
  return timestamp;
}

function transformPlayerMarketSnapshot(
  rawElement: RawFPLElement,
  teamsById: ReadonlyMap<number, FPLBootstrapResponse['teams'][number]>,
  capturedAt: Date,
  snapshotDate: string,
): PlayerMarketSnapshot {
  const team = teamsById.get(rawElement.team);
  if (!team) {
    throw new Error(`Missing team ${rawElement.team} for player ${rawElement.id}`);
  }

  return validatePlayerMarketSnapshot({
    snapshotDate,
    capturedAt,
    elementId: rawElement.id,
    playerCode: rawElement.code,
    webName: rawElement.web_name,
    firstName: rawElement.first_name,
    secondName: rawElement.second_name,
    teamId: rawElement.team,
    teamName: team.name,
    teamShortName: team.short_name,
    elementType: rawElement.element_type,
    position: getPlayerPosition(rawElement.element_type),
    price: rawElement.now_cost,
    selectedByPercent: parseOwnership(rawElement.selected_by_percent, rawElement.id),
    transfersIn: rawElement.transfers_in,
    transfersOut: rawElement.transfers_out,
    transfersInEvent: rawElement.transfers_in_event,
    transfersOutEvent: rawElement.transfers_out_event,
    status: rawElement.status,
    news: rawElement.news,
    newsAdded: parseNewsAdded(rawElement.news_added, rawElement.id),
    chanceOfPlayingThisRound: rawElement.chance_of_playing_this_round,
    chanceOfPlayingNextRound: rawElement.chance_of_playing_next_round,
  });
}

export function transformPlayerMarketSnapshots(
  bootstrap: Pick<FPLBootstrapResponse, 'elements' | 'teams'>,
  capturedAt: Date = new Date(),
): PlayerMarketSnapshot[] {
  if (Number.isNaN(capturedAt.getTime())) {
    throw new Error('Market snapshot capture time must be a valid timestamp');
  }

  const snapshotDate = formatCronCalendarDate(capturedAt);
  const teamsById = new Map(bootstrap.teams.map((team) => [team.id, team]));
  const snapshots = bootstrap.elements.map((element) =>
    transformPlayerMarketSnapshot(element, teamsById, capturedAt, snapshotDate),
  );

  validateCompleteMarketSnapshotBatch(snapshots, bootstrap.elements.length);
  return snapshots;
}
