import * as E from 'fp-ts/Either';

import { Branded, createBrandedType, ElementTypeId } from '../base.type';
import { TeamId } from './team.type';

export type PlayerValueTrackId = Branded<number, 'PlayerValueTrackId'>;

export const PlayerValueTrackId = createBrandedType<number, 'PlayerValueTrackId'>(
  'PlayerValueTrackId',
  (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0,
);

export const validatePlayerValueTrackIdInput = (
  value: unknown,
): E.Either<string, PlayerValueTrackId> => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return E.left('Invalid player value track ID: input must be a non-empty string');
  }
  const numericId = parseInt(value, 10);
  if (isNaN(numericId) || !Number.isInteger(numericId) || numericId <= 0) {
    return E.left(
      'Invalid player value track ID: input must be a string representing a positive integer',
    );
  }
  return E.right(numericId as PlayerValueTrackId);
};

export interface PlayerValueTrack {
  readonly hourIndex: number;
  readonly date: string;
  readonly event: number;
  readonly element: number;
  readonly elementType: ElementTypeId;
  readonly team: TeamId;
  readonly chanceOfPlayingThisRound: number | null;
  readonly chanceOfPlayingNextRound: number | null;
  readonly transfersIn: number;
  readonly transfersOut: number;
  readonly transfersInEvent: number;
  readonly transfersOutEvent: number;
  readonly selectedBy: number | null;
  readonly value: number;
}
export type PlayerValueTracks = readonly PlayerValueTrack[];
