export interface Team {
  readonly id: TeamId;
  readonly code: number;
  readonly name: string;
  readonly shortName: string;
  readonly strength: number;
  readonly position: number;
  readonly points: number;
  readonly win: number;
  readonly draw: number;
  readonly loss: number;
}

export type Teams = readonly Team[];
