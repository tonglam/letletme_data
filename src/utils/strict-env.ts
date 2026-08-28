/**
 * Parse an optional boolean environment override without accepting silent
 * coercions. This module intentionally has no logger or runtime infrastructure
 * imports so small standalone binaries can reuse the validation primitives.
 */
export function parseStrictBooleanEnvValue(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean (true/false, 1/0, yes/no or on/off)`);
}

/** Parse an optional integer override with an explicit safe range. */
export function parseStrictIntegerEnvValue(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim();
  if (!/^[+-]?\d+$/.test(normalized)) {
    throw new Error(`${name} must be a finite safe integer`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a finite safe integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

/** Parse an optional finite decimal override with an explicit safe range. */
export function parseStrictNumberEnvValue(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) {
    throw new Error(`${name} must be a finite safe number`);
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${name} must be a finite safe number`);
  }
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}
