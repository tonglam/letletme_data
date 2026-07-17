import { logWarn } from '../utils/logger';

/**
 * Chip mapping at the DB boundary (FP-04).
 *
 * The FPL API accepts new chip types at any time (e.g. 'manager' arrived after
 * the enum was written), so the client boundary accepts any string. This maps
 * that string onto the DB `chip` enum: known chips pass through, null/empty
 * becomes 'n/a' (or null), unknown chips pass through with a warning so a new
 * chip surfaces loudly in logs instead of failing validation for every entry.
 */
export const KNOWN_FPL_CHIPS = ['wildcard', 'freehit', 'bboost', '3xc', 'manager'] as const;

export type KnownFPLChip = (typeof KNOWN_FPL_CHIPS)[number];
export type DbChip = 'n/a' | KnownFPLChip;

const knownChipSet: ReadonlySet<string> = new Set(KNOWN_FPL_CHIPS);

const mapKnownOrWarn = (chip: string): KnownFPLChip => {
  if (knownChipSet.has(chip)) {
    return chip as KnownFPLChip;
  }
  logWarn('Unknown FPL chip passed through to the DB layer', { chip });
  // Pass-through: a truly new chip may be rejected by the DB enum — loudly,
  // for that row only, instead of failing the whole fetch at the boundary.
  return chip as KnownFPLChip;
};

/** Chip for non-nullable DB columns: null/empty becomes the enum's 'n/a'. */
export const toDbChip = (chip: string | null | undefined): DbChip => {
  if (chip === null || chip === undefined || chip === '') {
    return 'n/a';
  }
  return mapKnownOrWarn(chip);
};

/** Chip for nullable DB columns: null/empty stays null. */
export const toNullableDbChip = (chip: string | null | undefined): KnownFPLChip | null => {
  if (chip === null || chip === undefined || chip === '') {
    return null;
  }
  return mapKnownOrWarn(chip);
};
