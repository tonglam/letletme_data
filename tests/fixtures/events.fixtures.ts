import type { Event, RawFPLEvent } from '../../src/types';

// Raw FPL API response for events (sample data based on user-provided format)
export const rawFPLEventsFixture: RawFPLEvent[] = [
  {
    id: 1,
    name: 'Gameweek 1',
    deadline_time: '2025-08-15T17:30:00Z',
    release_time: null,
    average_entry_score: 0,
    finished: false,
    data_checked: false,
    highest_scoring_entry: null,
    deadline_time_epoch: 1755279000,
    deadline_time_game_offset: 0,
    highest_score: null,
    is_previous: false,
    is_current: false,
    is_next: true,
    cup_leagues_created: false,
    h2h_ko_matches_created: false,
    can_enter: true,
    can_manage: true,
    released: true,
    ranked_count: 0,
    overrides: {
      rules: {},
      scoring: {},
      element_types: [],
      pick_multiplier: null,
    },
    chip_plays: [],
    most_selected: null,
    most_transferred_in: null,
    top_element: null,
    top_element_info: null,
    transfers_made: 0,
    most_captained: null,
    most_vice_captained: null,
  },
  {
    id: 2,
    name: 'Gameweek 2',
    deadline_time: '2025-08-22T17:30:00Z',
    release_time: null,
    average_entry_score: 45,
    finished: true,
    data_checked: true,
    highest_scoring_entry: 123456,
    deadline_time_epoch: 1755883800,
    deadline_time_game_offset: 0,
    highest_score: 98,
    is_previous: true,
    is_current: false,
    is_next: false,
    cup_leagues_created: false,
    h2h_ko_matches_created: false,
    can_enter: false,
    can_manage: false,
    released: true,
    ranked_count: 5000000,
    overrides: {
      rules: {},
      scoring: {},
      element_types: [],
      pick_multiplier: null,
    },
    chip_plays: [
      { name: 'wildcard', num_played: 25000 },
      { name: 'bench_boost', num_played: 15000 },
    ],
    most_selected: 45678,
    most_transferred_in: 78901,
    top_element: 234567,
    top_element_info: {
      id: 234567,
      points: 15,
    },
    transfers_made: 8500000,
    most_captained: 345678,
    most_vice_captained: 456789,
  },
  {
    id: 3,
    name: 'Gameweek 3',
    deadline_time: '2025-08-29T17:30:00Z',
    release_time: null,
    average_entry_score: 52,
    finished: false,
    data_checked: false,
    highest_scoring_entry: null,
    deadline_time_epoch: 1756488600,
    deadline_time_game_offset: 0,
    highest_score: null,
    is_previous: false,
    is_current: true,
    is_next: false,
    cup_leagues_created: false,
    h2h_ko_matches_created: false,
    can_enter: true,
    can_manage: true,
    released: true,
    ranked_count: 0,
    overrides: {
      rules: {},
      scoring: {},
      element_types: [],
      pick_multiplier: null,
    },
    chip_plays: [],
    most_selected: 567890,
    most_transferred_in: 678901,
    top_element: null,
    top_element_info: null,
    transfers_made: 2500000,
    most_captained: 789012,
    most_vice_captained: 890123,
  },
];

// Expected transformed events (matching domain Event interface)
export const transformedEventsFixture: Event[] = [
  {
    id: 1,
    name: 'Gameweek 1',
    deadlineTime: new Date('2025-08-15T17:30:00Z'),
    averageEntryScore: 0,
    finished: false,
    dataChecked: false,
    highestScoringEntry: null,
    deadlineTimeEpoch: 1755279000,
    deadlineTimeGameOffset: 0,
    highestScore: null,
    isPrevious: false,
    isCurrent: false,
    isNext: true,
    cupLeagueCreate: false,
    h2hKoMatchesCreated: false,
    chipPlays: [],
    mostSelected: null,
    mostTransferredIn: null,
    topElement: null,
    topElementInfo: null,
    transfersMade: 0,
    mostCaptained: null,
    mostViceCaptained: null,
    createdAt: null,
    updatedAt: null,
  },
  {
    id: 2,
    name: 'Gameweek 2',
    deadlineTime: new Date('2025-08-22T17:30:00Z'),
    averageEntryScore: 45,
    finished: true,
    dataChecked: true,
    highestScoringEntry: 123456,
    deadlineTimeEpoch: 1755883800,
    deadlineTimeGameOffset: 0,
    highestScore: 98,
    isPrevious: true,
    isCurrent: false,
    isNext: false,
    cupLeagueCreate: false,
    h2hKoMatchesCreated: false,
    chipPlays: [
      { name: 'wildcard', num_played: 25000 },
      { name: 'bench_boost', num_played: 15000 },
    ],
    mostSelected: 45678,
    mostTransferredIn: 78901,
    topElement: 234567,
    topElementInfo: {
      id: 234567,
      points: 15,
    },
    transfersMade: 8500000,
    mostCaptained: 345678,
    mostViceCaptained: 456789,
    createdAt: null,
    updatedAt: null,
  },
  {
    id: 3,
    name: 'Gameweek 3',
    deadlineTime: new Date('2025-08-29T17:30:00Z'),
    averageEntryScore: 52,
    finished: false,
    dataChecked: false,
    highestScoringEntry: null,
    deadlineTimeEpoch: 1756488600,
    deadlineTimeGameOffset: 0,
    highestScore: null,
    isPrevious: false,
    isCurrent: true,
    isNext: false,
    cupLeagueCreate: false,
    h2hKoMatchesCreated: false,
    chipPlays: [],
    mostSelected: 567890,
    mostTransferredIn: 678901,
    topElement: null,
    topElementInfo: null,
    transfersMade: 2500000,
    mostCaptained: 789012,
    mostViceCaptained: 890123,
    createdAt: null,
    updatedAt: null,
  },
];

// Single event fixtures for focused testing
export const singleRawEventFixture: RawFPLEvent = rawFPLEventsFixture[0];
export const singleTransformedEventFixture: Event = transformedEventsFixture[0];

// Current event fixture for current event tests
export const currentEventFixture: Event = transformedEventsFixture[2]; // GW3 is current

// Next event fixture for next event tests
export const nextEventFixture: Event = transformedEventsFixture[0]; // GW1 is next

// Previous event fixture for previous event tests
export const previousEventFixture: Event = transformedEventsFixture[1]; // GW2 is previous

// Invalid/edge case data for error testing
export const invalidRawEventFixture = {
  // Missing required fields
  id: 999,
  name: 'Invalid Event', // Add required field
  deadline_time: 'invalid-date-format',
  finished: false, // Fixed to proper boolean type
  // Add other required fields with default values
  release_time: null,
  average_entry_score: 0,
  data_checked: false,
  highest_scoring_entry: null,
  deadline_time_epoch: 0,
  deadline_time_game_offset: 0,
  highest_score: null,
  is_previous: false,
  is_current: false,
  is_next: false,
  cup_leagues_created: false,
  h2h_ko_matches_created: false,
  can_enter: false,
  can_manage: false,
  released: false,
  ranked_count: 0,
  overrides: {
    rules: {},
    scoring: {},
    element_types: [],
    pick_multiplier: null,
  },
  chip_plays: [],
  most_selected: null,
  most_transferred_in: null,
  top_element: null,
  top_element_info: null,
  transfers_made: 0,
  most_captained: null,
  most_vice_captained: null,
} as RawFPLEvent;

// Database insertion data (matches DB schema)
export const dbEventInsertFixture = {
  id: 1,
  name: 'Gameweek 1',
  deadlineTime: new Date('2025-08-15T17:30:00Z'),
  averageEntryScore: 0,
  finished: false,
  dataChecked: false,
  highestScoringEntry: null,
  deadlineTimeEpoch: 1755279000,
  deadlineTimeGameOffset: 0,
  highestScore: null,
  isPrevious: false,
  isCurrent: false,
  isNext: true,
  cupLeagueCreate: false,
  h2hKoMatchesCreated: false,
  chipPlays: [],
  mostSelected: null,
  mostTransferredIn: null,
  topElement: null,
  topElementInfo: null,
  transfersMade: 0,
  mostCaptained: null,
  mostViceCaptained: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// Mock FPL Bootstrap response for integration tests
export const mockBootstrapResponseFixture = {
  events: rawFPLEventsFixture,
  teams: [],
  elements: [],
  element_types: [],
  total_players: 6051985,
  game_settings: {},
  phases: [],
};

// Redis cache data format
export const eventsCacheFixture = {
  key: 'events:all',
  value: JSON.stringify(transformedEventsFixture),
  ttl: 3600, // 1 hour
};

// Expected API response format
export const eventsApiResponseFixture = {
  success: true,
  data: transformedEventsFixture,
  count: transformedEventsFixture.length,
  timestamp: new Date().toISOString(),
};

// Test scenarios data
export const testScenarios = {
  empty: {
    raw: [],
    transformed: [],
    description: 'Empty events array',
  },
  single: {
    raw: [rawFPLEventsFixture[0]],
    transformed: [transformedEventsFixture[0]],
    description: 'Single event',
  },
  multiple: {
    raw: rawFPLEventsFixture,
    transformed: transformedEventsFixture,
    description: 'Multiple events',
  },
  invalid: {
    raw: [invalidRawEventFixture],
    description: 'Invalid event data',
  },
  current: {
    transformed: [currentEventFixture],
    description: 'Current event',
  },
  next: {
    transformed: [nextEventFixture],
    description: 'Next event',
  },
  previous: {
    transformed: [previousEventFixture],
    description: 'Previous event',
  },
};

// Event status test data
export const eventStatusFixtures = {
  finished: {
    ...singleTransformedEventFixture,
    id: 100,
    name: 'Finished Event',
    finished: true,
    dataChecked: true,
    isPrevious: true,
    isCurrent: false,
    isNext: false,
  },
  current: {
    ...singleTransformedEventFixture,
    id: 101,
    name: 'Current Event',
    finished: false,
    dataChecked: false,
    isPrevious: false,
    isCurrent: true,
    isNext: false,
  },
  upcoming: {
    ...singleTransformedEventFixture,
    id: 102,
    name: 'Upcoming Event',
    finished: false,
    dataChecked: false,
    isPrevious: false,
    isCurrent: false,
    isNext: true,
  },
};
