function fractionalMicroseconds(value: Date | string): number {
  if (value instanceof Date) return value.getUTCMilliseconds() * 1_000;
  const match = value.match(/\.(\d{1,6})(?:Z|[+-]\d{2}:?\d{2})$/i);
  return match ? Number(match[1].padEnd(6, '0')) : new Date(value).getUTCMilliseconds() * 1_000;
}

/** Return the later timestamp while retaining its exact representation. */
export function latestFreshnessTimestamp(
  sourceFreshAfter: Date | string,
  finalizationCutoff: Date | string | null | undefined,
): Date | string {
  const sourceDate =
    sourceFreshAfter instanceof Date ? sourceFreshAfter : new Date(sourceFreshAfter);
  if (Number.isNaN(sourceDate.getTime())) {
    throw new Error('A valid freshness timestamp is required');
  }
  if (!finalizationCutoff) return sourceFreshAfter;

  const finalizationDate =
    finalizationCutoff instanceof Date ? finalizationCutoff : new Date(finalizationCutoff);
  if (Number.isNaN(finalizationDate.getTime())) {
    throw new Error('A valid finalization timestamp is required');
  }
  if (finalizationDate.getTime() !== sourceDate.getTime()) {
    return finalizationDate.getTime() > sourceDate.getTime()
      ? finalizationCutoff
      : sourceFreshAfter;
  }
  return fractionalMicroseconds(finalizationCutoff) > fractionalMicroseconds(sourceFreshAfter)
    ? finalizationCutoff
    : sourceFreshAfter;
}

export function isFreshnessBoundaryNewer(
  sourceFreshAfter: Date | string,
  candidateFinalization: Date | string | null | undefined,
): boolean {
  return (
    candidateFinalization !== null &&
    candidateFinalization !== undefined &&
    latestFreshnessTimestamp(sourceFreshAfter, candidateFinalization) !== sourceFreshAfter
  );
}
