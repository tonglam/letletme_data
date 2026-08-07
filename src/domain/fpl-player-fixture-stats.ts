export interface FplPlayerFixtureEvidence {
  eventId: number;
  fixtureId: number;
  elementId: number;
  minutes: number;
  starts: number;
  goals: number;
  assists: number;
  ownGoals: number;
  yellowCards: number;
  redCards: number;
}

export interface FplPlayerFixtureStat extends FplPlayerFixtureEvidence {
  season: string;
  fixtureCode: number;
  playerCode: number;
  teamId: number;
  teamCode: number;
  elementType: number;
  sourceHash: string;
}
