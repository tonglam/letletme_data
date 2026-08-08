type EntryPick = Record<string, unknown>;

type CaptainPick = {
  element: number;
  multiplier: number;
  is_captain: boolean;
  is_vice_captain: boolean;
};

function asInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function isBoolean(value: unknown): value is boolean {
  return value === true || value === false;
}

/** A picks payload may only checkpoint the gameweek it identifies itself as. */
export function isEntryPicksPayloadForEvent(raw: unknown, eventId: number): boolean {
  if (!Number.isInteger(eventId)) return false;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const history = (raw as Record<string, unknown>).entry_history;
  if (history === null || typeof history !== 'object' || Array.isArray(history)) return false;
  return asInteger((history as Record<string, unknown>).event) === eventId;
}

/**
 * A stored picks row is a reusable checkpoint only when it can support every
 * downstream non-live calculation without inventing missing data.
 */
export function isCompleteEntryPicks(raw: unknown): boolean {
  if (!Array.isArray(raw) || raw.length !== 15) return false;
  const picks = raw.filter(
    (item): item is EntryPick => item !== null && typeof item === 'object' && !Array.isArray(item),
  );
  if (picks.length !== 15) return false;

  const elements = picks.map((pick) => asInteger(pick.element));
  const positions = picks.map((pick) => asInteger(pick.position));
  if (
    elements.some((element) => element === null || element <= 0) ||
    positions.some((position) => position === null || position < 1 || position > 15) ||
    new Set(elements).size !== 15 ||
    new Set(positions).size !== 15
  ) {
    return false;
  }

  if (
    picks.some((pick) => {
      const multiplier = asInteger(pick.multiplier);
      const position = asInteger(pick.position);
      if (
        !isBoolean(pick.is_captain) ||
        !isBoolean(pick.is_vice_captain) ||
        multiplier === null ||
        multiplier < 0 ||
        multiplier > 3 ||
        position === null
      ) {
        return true;
      }

      // Finalized FPL picks apply automatic substitutions to multipliers: an
      // outgoing starter/captain can become 0, an incoming bench player 1,
      // and the vice-captain 2 (or 3 for Triple Captain). Only the two marked
      // captain roles may ever receive a scoring bonus.
      if ((pick.is_captain || pick.is_vice_captain) && position > 11) return true;
      if (pick.is_captain && multiplier === 1) return true;
      return multiplier > 1 && !pick.is_captain && !pick.is_vice_captain;
    })
  ) {
    return false;
  }

  const scoringBonusPicks = picks.filter((pick) => Number(pick.multiplier) > 1);
  return (
    picks.filter((pick) => pick.is_captain).length === 1 &&
    picks.filter((pick) => pick.is_vice_captain).length === 1 &&
    !picks.some((pick) => pick.is_captain && pick.is_vice_captain) &&
    scoringBonusPicks.length <= 1
  );
}

/**
 * FPL keeps the originally selected captain flag after automatic substitutions
 * and transfers the scoring multiplier to the vice-captain. Prefer that final
 * multiplier evidence, falling back to the selected captain before the event
 * is resolved.
 */
export function resolveScoringCaptainPick<T extends CaptainPick>(picks: readonly T[]): T | null {
  return (
    picks.find(
      (pick) =>
        (pick.is_captain || pick.is_vice_captain) &&
        Number.isInteger(pick.multiplier) &&
        pick.multiplier > 1,
    ) ??
    picks.find((pick) => pick.is_captain) ??
    null
  );
}

/**
 * Rich non-live calculations may use captain, substitutions, and the highest
 * scoring pick. Require one unique live row for every validated squad element
 * before those calculations can become a reusable checkpoint.
 */
export function hasCompleteEntryPickLiveCoverage(
  rawPicks: unknown,
  liveElementIds: readonly number[],
): boolean {
  if (!isCompleteEntryPicks(rawPicks)) return false;
  if (
    liveElementIds.some((elementId) => !Number.isInteger(elementId) || elementId <= 0) ||
    new Set(liveElementIds).size !== liveElementIds.length
  ) {
    return false;
  }

  const available = new Set(liveElementIds);
  return (rawPicks as EntryPick[]).every((pick) => available.has(Number(pick.element)));
}
