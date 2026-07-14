import { z } from 'zod';

/**
 * Domain EntryInfo — cache/API shape without DB timestamps.
 */
export interface EntryInfo {
  readonly id: number;
  readonly entryName: string;
  readonly playerName: string;
  readonly region: string | null;
  readonly startedEvent: number | null;
  readonly overallPoints: number | null;
  readonly overallRank: number | null;
  readonly bank: number | null;
  readonly lastBank: number | null;
  readonly lastEventId: number | null;
  readonly teamValue: number | null;
  readonly totalTransfers: number | null;
  readonly lastEntryName: string | null;
  readonly lastOverallPoints: number | null;
  readonly lastOverallRank: number | null;
  readonly lastTeamValue: number | null;
  readonly usedEntryNames: string[] | null;
}

export const EntryInfoSchema = z.object({
  id: z.number().int().positive(),
  entryName: z.string().min(1),
  playerName: z.string().min(1),
  region: z.string().nullable(),
  startedEvent: z.number().int().nullable(),
  overallPoints: z.number().int().nullable(),
  overallRank: z.number().int().nullable(),
  bank: z.number().int().nullable(),
  lastBank: z.number().int().nullable(),
  lastEventId: z.number().int().nullable(),
  teamValue: z.number().int().nullable(),
  totalTransfers: z.number().int().nullable(),
  lastEntryName: z.string().nullable(),
  lastOverallPoints: z.number().int().nullable(),
  lastOverallRank: z.number().int().nullable(),
  lastTeamValue: z.number().int().nullable(),
  usedEntryNames: z.array(z.string()).nullable(),
});

export function validateEntryInfo(data: unknown): EntryInfo {
  return EntryInfoSchema.parse(data);
}

export function safeValidateEntryInfo(data: unknown): EntryInfo | null {
  const result = EntryInfoSchema.safeParse(data);
  return result.success ? result.data : null;
}

/**
 * Map a DB row (or any object with EntryInfo fields + optional timestamps) to domain EntryInfo.
 */
export function toEntryInfo(
  entry: EntryInfo & { createdAt?: Date | null; updatedAt?: Date | null },
): EntryInfo {
  return {
    id: entry.id,
    entryName: entry.entryName,
    playerName: entry.playerName,
    region: entry.region,
    startedEvent: entry.startedEvent,
    overallPoints: entry.overallPoints,
    overallRank: entry.overallRank,
    bank: entry.bank,
    lastBank: entry.lastBank,
    lastEventId: entry.lastEventId,
    teamValue: entry.teamValue,
    totalTransfers: entry.totalTransfers,
    lastEntryName: entry.lastEntryName,
    lastOverallPoints: entry.lastOverallPoints,
    lastOverallRank: entry.lastOverallRank,
    lastTeamValue: entry.lastTeamValue,
    usedEntryNames: entry.usedEntryNames,
  };
}
