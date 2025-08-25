import type { RawFPLTeam, Team } from '../../src/types';

// Raw FPL API response for teams (sample data)
export const rawFPLTeamsFixture: RawFPLTeam[] = [
  {
    id: 1,
    code: 3,
    name: 'Arsenal',
    short_name: 'ARS',
    strength: 4,
    position: 1,
    points: 0,
    played: 0,
    win: 0,
    draw: 0,
    loss: 0,
    form: null,
    team_division: null,
    unavailable: false,
    strength_overall_home: 1320,
    strength_overall_away: 1325,
    strength_attack_home: 1350,
    strength_attack_away: 1350,
    strength_defence_home: 1290,
    strength_defence_away: 1300,
    pulse_id: 1,
  },
  {
    id: 2,
    code: 7,
    name: 'Aston Villa',
    short_name: 'AVL',
    strength: 3,
    position: 2,
    points: 0,
    played: 0,
    win: 0,
    draw: 0,
    loss: 0,
    form: null,
    team_division: null,
    unavailable: false,
    strength_overall_home: 1125,
    strength_overall_away: 1250,
    strength_attack_home: 1110,
    strength_attack_away: 1200,
    strength_defence_home: 1140,
    strength_defence_away: 1300,
    pulse_id: 2,
  },
  {
    id: 3,
    code: 90,
    name: 'Burnley',
    short_name: 'BUR',
    strength: 2,
    position: 3,
    points: 0,
    played: 0,
    win: 0,
    draw: 0,
    loss: 0,
    form: null,
    team_division: null,
    unavailable: false,
    strength_overall_home: 1050,
    strength_overall_away: 1050,
    strength_attack_home: 1050,
    strength_attack_away: 1050,
    strength_defence_home: 1050,
    strength_defence_away: 1050,
    pulse_id: 43,
  },
];

// Expected transformed teams (without database-only fields)
export const transformedTeamsFixture: Team[] = [
  {
    id: 1,
    name: 'Arsenal',
    shortName: 'ARS',
    code: 3,
    draw: 0,
    form: null,
    loss: 0,
    played: 0,
    points: 0,
    position: 1,
    strength: 4,
    teamDivision: null,
    unavailable: false,
    win: 0,
    strengthOverallHome: 1320,
    strengthOverallAway: 1325,
    strengthAttackHome: 1350,
    strengthAttackAway: 1350,
    strengthDefenceHome: 1290,
    strengthDefenceAway: 1300,
    pulseId: 1,
    createdAt: null,
    updatedAt: null,
  },
  {
    id: 2,
    name: 'Aston Villa',
    shortName: 'AVL',
    code: 7,
    draw: 0,
    form: null,
    loss: 0,
    played: 0,
    points: 0,
    position: 2,
    strength: 3,
    teamDivision: null,
    unavailable: false,
    win: 0,
    strengthOverallHome: 1125,
    strengthOverallAway: 1250,
    strengthAttackHome: 1110,
    strengthAttackAway: 1200,
    strengthDefenceHome: 1140,
    strengthDefenceAway: 1300,
    pulseId: 2,
    createdAt: null,
    updatedAt: null,
  },
  {
    id: 3,
    name: 'Burnley',
    shortName: 'BUR',
    code: 90,
    draw: 0,
    form: null,
    loss: 0,
    played: 0,
    points: 0,
    position: 3,
    strength: 2,
    teamDivision: null,
    unavailable: false,
    win: 0,
    strengthOverallHome: 1050,
    strengthOverallAway: 1050,
    strengthAttackHome: 1050,
    strengthAttackAway: 1050,
    strengthDefenceHome: 1050,
    strengthDefenceAway: 1050,
    pulseId: 43,
    createdAt: null,
    updatedAt: null,
  },
];

// Single team fixtures for focused testing
export const singleRawTeamFixture: RawFPLTeam = rawFPLTeamsFixture[0];
export const singleTransformedTeamFixture: Team = transformedTeamsFixture[0];

// Invalid/edge case data for error testing
export const invalidRawTeamFixture = {
  // Missing required fields
  id: 999,
  code: 999,
  name: 'Edge Case Team',
  short_name: 'ECT',
  strength: 1,
  position: 0, // Invalid position (should be 1-20)
  points: 0,
  win: 0,
  draw: 0,
  loss: 0,
  played: 0,
  form: null,
  team_division: null,
  unavailable: false,
  strength_overall_home: 1000,
  strength_overall_away: 1000,
  strength_attack_home: 1000,
  strength_attack_away: 1000,
  strength_defence_home: 1000,
  strength_defence_away: 1000,
  pulse_id: 999,
} as RawFPLTeam;

// Database insertion data (matches DB schema)
export const dbTeamInsertFixture = {
  id: 1,
  code: 3,
  name: 'Arsenal',
  short_name: 'ARS',
  strength: 4,
  position: 1,
  points: 0,
  win: 0,
  draw: 0,
  loss: 0,
};

// Mock FPL Bootstrap response for integration tests
export const mockBootstrapResponseFixture = {
  events: [],
  teams: rawFPLTeamsFixture,
  elements: [],
  element_types: [],
  total_players: 6051985,
  game_settings: {},
  phases: [],
};

// Redis cache data format
export const teamsCacheFixture = {
  key: 'teams:all',
  value: JSON.stringify(transformedTeamsFixture),
  ttl: 3600, // 1 hour
};

// Expected API response format
export const teamsApiResponseFixture = {
  success: true,
  data: transformedTeamsFixture,
  count: transformedTeamsFixture.length,
  timestamp: new Date().toISOString(),
};

// Test scenarios data
export const testScenarios = {
  empty: {
    raw: [],
    transformed: [],
    description: 'Empty teams array',
  },
  single: {
    raw: [rawFPLTeamsFixture[0]],
    transformed: [transformedTeamsFixture[0]],
    description: 'Single team',
  },
  multiple: {
    raw: rawFPLTeamsFixture,
    transformed: transformedTeamsFixture,
    description: 'Multiple teams',
  },
  invalid: {
    raw: [invalidRawTeamFixture],
    description: 'Invalid team data',
  },
};
