export interface FplPlayerFixtureEvidence {
  readonly eventId: number;
  readonly fixtureId: number;
  readonly elementId: number;
  readonly minutes: number;
  readonly starts: number | null;
  readonly goals: number;
  readonly assists: number;
  readonly ownGoals: number;
  readonly yellowCards: number;
  readonly redCards: number;
}

export interface FplPlayerFixtureStat extends FplPlayerFixtureEvidence {
  readonly seasonId: number;
  readonly fixtureCode: number;
  readonly playerCode: number;
  readonly teamId: number;
  readonly teamCode: number;
  readonly elementType: number;
  readonly sourceHash: string;
}
