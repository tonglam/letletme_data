import { PlayerInfo } from '@app/domain/shared/value-objects/player-info.types';

export interface PlayerModel {
  readonly info: PlayerInfo;
  readonly startPrice: number;
  readonly firstName: string;
  readonly secondName: string;
}
