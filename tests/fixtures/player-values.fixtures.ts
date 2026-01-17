import type { PlayerValue, RawPlayerValue } from '../../src/domain/player-values';
import type { RawFPLElement } from '../../src/types';
import type { EventId, PlayerId, TeamId, ValueChangeType } from '../../src/types/base.type';

// Single player value fixture
export const singlePlayerValueFixture: PlayerValue = {
  elementId: 1 as PlayerId,
  webName: 'Haaland',
  elementType: 4,
  elementTypeName: 'FWD',
  eventId: 15 as EventId,
  teamId: 11 as TeamId,
  teamName: 'Manchester City',
  teamShortName: 'MCI',
  value: 142,
  changeDate: '2023-12-15T10:00:00.000Z',
  changeType: 'Rise' as ValueChangeType,
  lastValue: 138,
};

// Raw player value fixture
export const singleRawPlayerValueFixture: RawPlayerValue = {
  elementId: 1 as PlayerId,
  elementType: 4,
  eventId: 15 as EventId,
  teamId: 11 as TeamId,
  value: 142,
  changeDate: '2023-12-15T10:00:00.000Z',
  changeType: 'Rise' as ValueChangeType,
  lastValue: 138,
};

// Multiple player values for different positions
export const gkpPlayerValueFixture: PlayerValue = {
  elementId: 20 as PlayerId,
  webName: 'Alisson',
  elementType: 1,
  elementTypeName: 'GKP',
  eventId: 15 as EventId,
  teamId: 14 as TeamId,
  teamName: 'Liverpool',
  teamShortName: 'LIV',
  value: 55,
  changeDate: '2023-12-15T10:00:00.000Z',
  changeType: 'Start' as ValueChangeType,
  lastValue: 55,
};

export const defPlayerValueFixture: PlayerValue = {
  elementId: 100 as PlayerId,
  webName: 'Alexander-Arnold',
  elementType: 2,
  elementTypeName: 'DEF',
  eventId: 15 as EventId,
  teamId: 14 as TeamId,
  teamName: 'Liverpool',
  teamShortName: 'LIV',
  value: 72,
  changeDate: '2023-12-15T10:00:00.000Z',
  changeType: 'Faller' as ValueChangeType,
  lastValue: 74,
};

export const midPlayerValueFixture: PlayerValue = {
  elementId: 200 as PlayerId,
  webName: 'De Bruyne',
  elementType: 3,
  elementTypeName: 'MID',
  eventId: 15 as EventId,
  teamId: 11 as TeamId,
  teamName: 'Manchester City',
  teamShortName: 'MCI',
  value: 102,
  changeDate: '2023-12-15T10:00:00.000Z',
  changeType: 'Rise' as ValueChangeType,
  lastValue: 100,
};

export const fwdPlayerValueFixture: PlayerValue = {
  elementId: 300 as PlayerId,
  webName: 'Salah',
  elementType: 4,
  elementTypeName: 'FWD',
  eventId: 15 as EventId,
  teamId: 14 as TeamId,
  teamName: 'Liverpool',
  teamShortName: 'LIV',
  value: 125,
  changeDate: '2023-12-15T10:00:00.000Z',
  changeType: 'Start' as ValueChangeType,
  lastValue: 125,
};

// Array of player values for different teams and positions
export const transformedPlayerValuesFixture: PlayerValue[] = [
  gkpPlayerValueFixture,
  defPlayerValueFixture,
  midPlayerValueFixture,
  fwdPlayerValueFixture,
];

// Mock teams data for transformation
export const mockTeamsForPlayerValues = [
  { id: 11, name: 'Manchester City', shortName: 'MCI' },
  { id: 14, name: 'Liverpool', shortName: 'LIV' },
  { id: 1, name: 'Arsenal', shortName: 'ARS' },
  { id: 6, name: 'Chelsea', shortName: 'CHE' },
];

// Raw FPL element fixture for transformation
export const singleRawFPLElementFixture: RawFPLElement = {
  id: 1,
  code: 223094,
  element_type: 4,
  team: 11,
  now_cost: 142,
  cost_change_start: 4,
  cost_change_event: 0,
  cost_change_event_fall: 0,
  cost_change_start_fall: 0,
  first_name: 'Erling',
  second_name: 'Haaland',
  web_name: 'Haaland',
  photo: '223094.jpg',
  status: 'a',
  selected_by_percent: '55.8',
  total_points: 185,
  points_per_game: '12.3',
  form: '8.2',
  dreamteam_count: 8,
  in_dreamteam: false,
  special: false,
  squad_number: 9,
  news: '',
  news_added: null,
  chance_of_playing_this_round: 100,
  chance_of_playing_next_round: 100,
  value_form: '0.6',
  value_season: '13.0',
  transfers_in: 150000,
  transfers_out: 50000,
  transfers_in_event: 5000,
  transfers_out_event: 1000,
  minutes: 1260,
  goals_scored: 18,
  assists: 5,
  clean_sheets: 0,
  goals_conceded: 0,
  own_goals: 0,
  penalties_saved: 0,
  penalties_missed: 1,
  yellow_cards: 3,
  red_cards: 0,
  saves: 0,
  bonus: 12,
  bps: 456,
  influence: '158.4',
  creativity: '45.2',
  threat: '289.6',
  ict_index: '49.3',
  expected_goals: '14.8',
  expected_assists: '2.1',
  expected_goal_involvements: '16.9',
  expected_goals_conceded: '0.0',
};

// Array of raw FPL elements for bulk transformation
export const rawFPLElementsFixture: RawFPLElement[] = [
  singleRawFPLElementFixture,
  {
    ...singleRawFPLElementFixture,
    id: 20,
    element_type: 1,
    team: 14,
    now_cost: 55,
    web_name: 'Alisson',
    first_name: 'Alisson',
    second_name: 'Becker',
  },
  {
    ...singleRawFPLElementFixture,
    id: 100,
    element_type: 2,
    team: 14,
    now_cost: 72,
    web_name: 'Alexander-Arnold',
    first_name: 'Trent',
    second_name: 'Alexander-Arnold',
  },
];

// Generate player value with default values
export function generatePlayerValue(overrides: Partial<PlayerValue> = {}): PlayerValue {
  return {
    elementId: 1 as PlayerId,
    webName: 'Test Player',
    elementType: 3,
    elementTypeName: 'MID',
    eventId: 15 as EventId,
    teamId: 1 as TeamId,
    teamName: 'Test Team',
    teamShortName: 'TST',
    value: 80,
    changeDate: '2023-12-15T10:00:00.000Z',
    changeType: 'Start' as ValueChangeType,
    lastValue: 80,
    ...overrides,
  };
}

// Generate array of player values
export function generatePlayerValues(count: number = 3): PlayerValue[] {
  const cycle: ValueChangeType[] = ['Rise', 'Faller', 'Start'];
  return Array.from({ length: count }, (_, index) =>
    generatePlayerValue({
      elementId: (index + 1) as PlayerId,
      webName: `Player ${index + 1}`,
      value: 60 + index * 10,
      lastValue: 58 + index * 10,
      changeType: cycle[index % cycle.length],
    }),
  );
}

// Generate player values with different change types
export function generatePlayerValuesWithChanges(): PlayerValue[] {
  return [
    generatePlayerValue({
      elementId: 1 as PlayerId,
      webName: 'Rising Player',
      value: 90,
      lastValue: 80,
      changeType: 'Rise',
    }),
    generatePlayerValue({
      elementId: 2 as PlayerId,
      webName: 'Falling Player',
      value: 70,
      lastValue: 80,
      changeType: 'Faller',
    }),
    generatePlayerValue({
      elementId: 3 as PlayerId,
      webName: 'Stable Player',
      value: 80,
      lastValue: 80,
      changeType: 'Start',
    }),
  ];
}

// Generate player values for different positions
export function generatePlayerValuesByPosition(): PlayerValue[] {
  return [
    generatePlayerValue({
      elementId: 1 as PlayerId,
      elementType: 1,
      elementTypeName: 'GKP',
      webName: 'Goalkeeper',
      value: 50,
    }),
    generatePlayerValue({
      elementId: 2 as PlayerId,
      elementType: 2,
      elementTypeName: 'DEF',
      webName: 'Defender',
      value: 60,
    }),
    generatePlayerValue({
      elementId: 3 as PlayerId,
      elementType: 3,
      elementTypeName: 'MID',
      webName: 'Midfielder',
      value: 80,
    }),
    generatePlayerValue({
      elementId: 4 as PlayerId,
      elementType: 4,
      elementTypeName: 'FWD',
      webName: 'Forward',
      value: 100,
    }),
  ];
}

// Generate player values for different teams
export function generatePlayerValuesByTeam(): PlayerValue[] {
  return [
    generatePlayerValue({
      elementId: 1 as PlayerId,
      teamId: 1 as TeamId,
      teamName: 'Team A',
      teamShortName: 'TEA',
      webName: 'Player A1',
    }),
    generatePlayerValue({
      elementId: 2 as PlayerId,
      teamId: 1 as TeamId,
      teamName: 'Team A',
      teamShortName: 'TEA',
      webName: 'Player A2',
    }),
    generatePlayerValue({
      elementId: 3 as PlayerId,
      teamId: 2 as TeamId,
      teamName: 'Team B',
      teamShortName: 'TEB',
      webName: 'Player B1',
    }),
  ];
}

// Invalid player value for validation testing
export const invalidPlayerValueFixture = {
  elementId: 'invalid', // Should be number
  webName: '', // Should not be empty
  elementType: 5, // Should be 1-4
  elementTypeName: 'INVALID', // Should be GKP, DEF, MID, or FWD
  eventId: -1, // Should be positive
  teamId: 0, // Should be positive
  teamName: '', // Should not be empty
  teamShortName: '', // Should not be empty
  value: 20, // Should be >= 35
  changeDate: '', // Should not be empty
  changeType: 'invalid', // Should be valid type
  lastValue: 200, // Should be <= 150
};

// Previous values map for transformation testing
export function createMockPreviousValuesMap(): Map<number, number> {
  const map = new Map();
  map.set(1, 138); // Haaland previous value
  map.set(20, 55); // Alisson previous value
  map.set(100, 74); // TAA previous value
  return map;
}
