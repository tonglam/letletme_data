type EntryPick = Record<string, unknown>;

function asInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function isBoolean(value: unknown): value is boolean {
  return value === true || value === false;
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

      // FPL uses 2 (or 3 for Triple Captain) for the captain and 1 for the
      // vice-captain. Other starters score once; bench multipliers are 0,
      // except 1 during Bench Boost. Rejecting all other combinations keeps
      // malformed payloads from becoming reusable scoring checkpoints.
      if (pick.is_captain) return position > 11 || multiplier === 0 || multiplier === 1;
      if (pick.is_vice_captain) return position > 11 || multiplier !== 1;
      if (position <= 11) return multiplier !== 1;
      return multiplier !== 0 && multiplier !== 1;
    })
  ) {
    return false;
  }

  return (
    picks.filter((pick) => pick.is_captain).length === 1 &&
    picks.filter((pick) => pick.is_vice_captain).length === 1 &&
    !picks.some((pick) => pick.is_captain && pick.is_vice_captain)
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
