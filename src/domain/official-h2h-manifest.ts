import type { RawFPLLeagueH2HMatch } from '../clients/fpl';
import { contentHash } from '../utils/content-hash';

export type OfficialH2HPageManifest = Readonly<{
  pageNumber: number;
  scheduleHash: string;
  matchIds: readonly number[];
  eventIds: readonly number[];
  immutablePageHash: string;
  capturedAt: string;
  lockedAt: string | null;
}>;

function immutableProjection(match: RawFPLLeagueH2HMatch & { sourceOrder: number }) {
  return {
    id: match.id,
    event: match.event,
    sourceOrder: match.sourceOrder,
    entry1: match.entry_1_entry,
    entry2: match.entry_2_entry,
    isBye: match.is_bye ?? false,
    isKnockout: match.is_knockout ?? false,
    knockoutName: match.knockout_name ?? null,
    tiebreak: match.tiebreak ?? null,
  };
}

export function buildOfficialH2HPageManifest(
  pageNumber: number,
  matches: readonly (RawFPLLeagueH2HMatch & { sourceOrder: number })[],
  scheduleHash: string,
  capturedAt = new Date(),
  lockedAt: Date | null = null,
): OfficialH2HPageManifest {
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
    throw new Error('Official H2H page number must be positive');
  }
  if (matches.length === 0) throw new Error('Official H2H page manifest cannot be empty');
  const matchIds = matches.map((match) => match.id);
  const eventIds = [...new Set(matches.map((match) => match.event))].sort((a, b) => a - b);
  if (matchIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('Official H2H page manifest contains an invalid match id');
  }
  if (eventIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('Official H2H page manifest contains an invalid event id');
  }
  return {
    pageNumber,
    scheduleHash,
    matchIds,
    eventIds,
    immutablePageHash: contentHash(matches.map(immutableProjection)),
    capturedAt: capturedAt.toISOString(),
    lockedAt: lockedAt?.toISOString() ?? null,
  };
}

export function validateOfficialH2HPageManifest(
  manifest: Pick<OfficialH2HPageManifest, 'matchIds' | 'eventIds' | 'immutablePageHash'>,
  matches: readonly (RawFPLLeagueH2HMatch & { sourceOrder: number })[],
): boolean {
  if (matches.length !== manifest.matchIds.length) return false;
  if (!matches.every((match, index) => match.id === manifest.matchIds[index])) return false;
  const eventIds = [...new Set(matches.map((match) => match.event))].sort((a, b) => a - b);
  if (
    eventIds.length !== manifest.eventIds.length ||
    eventIds.some((id, i) => id !== manifest.eventIds[i])
  ) {
    return false;
  }
  return contentHash(matches.map(immutableProjection)) === manifest.immutablePageHash;
}

export function pagesContainingEvent(
  manifests: readonly Pick<OfficialH2HPageManifest, 'pageNumber' | 'eventIds'>[],
  eventId: number,
): number[] {
  return manifests
    .filter((manifest) => manifest.eventIds.includes(eventId))
    .map((manifest) => manifest.pageNumber)
    .sort((a, b) => a - b);
}

/** Return locked page boundaries that a complete provider fetch failed to return. */
export function missingLockedPageNumbers(
  existing: readonly {
    pageNumber: number;
    lockedAt: string | Date | null;
  }[],
  incoming: readonly Pick<OfficialH2HPageManifest, 'pageNumber'>[],
): number[] {
  const incomingPages = new Set(incoming.map((manifest) => manifest.pageNumber));
  return existing
    .filter((manifest) => manifest.lockedAt !== null && !incomingPages.has(manifest.pageNumber))
    .map((manifest) => manifest.pageNumber)
    .sort((a, b) => a - b);
}
