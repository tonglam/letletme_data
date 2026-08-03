import { z } from 'zod';

import type { ElementTypeId, PlayerId, TeamId } from '../types/base.type';

export const MarketPositionSchema = z.enum(['GKP', 'DEF', 'MID', 'FWD']);
export type MarketPosition = z.infer<typeof MarketPositionSchema>;

const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export interface PlayerMarketSnapshot {
  readonly snapshotDate: string;
  readonly capturedAt: Date;
  readonly elementId: PlayerId;
  readonly playerCode: number;
  readonly webName: string;
  readonly firstName: string;
  readonly secondName: string;
  readonly teamId: TeamId;
  readonly teamName: string;
  readonly teamShortName: string;
  readonly elementType: ElementTypeId;
  readonly position: MarketPosition;
  readonly price: number;
  readonly selectedByPercent: number;
  readonly transfersIn: number;
  readonly transfersOut: number;
  readonly transfersInEvent: number;
  readonly transfersOutEvent: number;
  readonly status: string;
  readonly news: string;
  readonly newsAdded: Date | null;
  readonly chanceOfPlayingThisRound: number | null;
  readonly chanceOfPlayingNextRound: number | null;
}

export const PlayerMarketSnapshotSchema = z.object({
  snapshotDate: CalendarDateSchema,
  capturedAt: z.date(),
  elementId: z.number().int().positive(),
  playerCode: z.number().int().positive(),
  webName: z.string().min(1).max(50),
  firstName: z.string().max(100),
  secondName: z.string().max(100),
  teamId: z.number().int().positive(),
  teamName: z.string().min(1).max(100),
  teamShortName: z.string().min(1).max(10),
  elementType: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  position: MarketPositionSchema,
  price: z.number().int().positive(),
  selectedByPercent: z.number().finite().min(0).max(100),
  transfersIn: z.number().int().min(0),
  transfersOut: z.number().int().min(0),
  transfersInEvent: z.number().int().min(0),
  transfersOutEvent: z.number().int().min(0),
  status: z.string().min(1).max(20),
  news: z.string(),
  newsAdded: z.date().nullable(),
  chanceOfPlayingThisRound: z.number().int().min(0).max(100).nullable(),
  chanceOfPlayingNextRound: z.number().int().min(0).max(100).nullable(),
});

export function validatePlayerMarketSnapshot(snapshot: unknown): PlayerMarketSnapshot {
  return PlayerMarketSnapshotSchema.parse(snapshot) as PlayerMarketSnapshot;
}

export function validateCompleteMarketSnapshotBatch(
  snapshots: readonly PlayerMarketSnapshot[],
  expectedCount: number,
): void {
  if (expectedCount <= 0 || snapshots.length !== expectedCount) {
    throw new Error(
      `Incomplete market snapshot batch: expected ${expectedCount}, received ${snapshots.length}`,
    );
  }

  const snapshotDates = new Set(snapshots.map((snapshot) => snapshot.snapshotDate));
  if (snapshotDates.size !== 1) {
    throw new Error('Market snapshot batch must contain exactly one calendar day');
  }

  const elementIds = new Set(snapshots.map((snapshot) => snapshot.elementId));
  if (elementIds.size !== snapshots.length) {
    throw new Error('Market snapshot batch contains duplicate players');
  }
}
