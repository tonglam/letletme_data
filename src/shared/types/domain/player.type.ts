import { ElementTypeId } from 'types/base.type';
import { TeamId } from 'types/domain/team.type';

export type Player = {
  readonly id: PlayerId;
  readonly code: number;
  readonly type: ElementTypeId;
  readonly teamId: TeamId;
  readonly teamName: string;
  readonly teamShortName: string;
  readonly price: number;
  readonly startPrice: number;
  readonly firstName: string | null;
  readonly secondName: string | null;
  readonly webName: string;
};

export type Players = readonly Player[];

export type RawPlayer = Omit<Player, 'teamName' | 'teamShortName'>;
export type RawPlayers = readonly RawPlayer[];
