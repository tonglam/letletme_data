import { TeamInfo } from '@app/domain/value-objects/team-info.type';

export interface TeamModel {
  readonly info: TeamInfo;
  readonly points: number;
  readonly win: number;
  readonly draw: number;
  readonly loss: number;
}
