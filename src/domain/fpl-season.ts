export interface FplSeasonRef {
  readonly seasonId: number;
  readonly seasonCode: string;
}

export function isFplSeasonCode(value: string): boolean {
  if (!/^\d{4}$/.test(value)) {
    return false;
  }

  const startYear = Number(value.slice(0, 2));
  const endYear = Number(value.slice(2));
  return endYear === (startYear + 1) % 100;
}

export function seasonIdFromCode(seasonCode: string): number {
  if (!isFplSeasonCode(seasonCode)) {
    throw new Error(`Invalid FPL season code: ${seasonCode}`);
  }

  return 2000 + Number(seasonCode.slice(0, 2));
}

export function explicitSeasonRef(seasonCode: string): FplSeasonRef {
  return { seasonId: seasonIdFromCode(seasonCode), seasonCode };
}
