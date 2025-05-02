import { PlayerID } from '@app/domain/types/id.types';

export type TopElement = {
  readonly id: PlayerID;
  readonly points: number;
};

export type TopElements = readonly TopElement[];
