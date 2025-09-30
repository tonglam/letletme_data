import type { Fixture, RawFPLFixture } from '../../src/types';

/**
 * Fixture test data
 */

export const mockRawFPLFixture1: RawFPLFixture = {
  code: 2561895,
  event: 1,
  finished: true,
  finished_provisional: true,
  id: 1,
  kickoff_time: '2025-08-15T19:00:00Z',
  minutes: 90,
  provisional_start_time: false,
  started: true,
  team_a: 4,
  team_a_score: 2,
  team_h: 12,
  team_h_score: 4,
  stats: [
    {
      identifier: 'goals_scored',
      a: [{ value: 2, element: 82 }],
      h: [
        { value: 1, element: 381 },
        { value: 1, element: 384 },
        { value: 1, element: 385 },
        { value: 1, element: 661 },
      ],
    },
    {
      identifier: 'assists',
      a: [
        { value: 1, element: 86 },
        { value: 1, element: 93 },
      ],
      h: [
        { value: 1, element: 386 },
        { value: 1, element: 392 },
        { value: 1, element: 661 },
      ],
    },
  ],
  team_h_difficulty: 3,
  team_a_difficulty: 5,
  pulse_id: 124791,
};

export const mockRawFPLFixture2: RawFPLFixture = {
  code: 2561896,
  event: 1,
  finished: true,
  finished_provisional: true,
  id: 2,
  kickoff_time: '2025-08-16T11:30:00Z',
  minutes: 90,
  provisional_start_time: false,
  started: true,
  team_a: 15,
  team_a_score: 0,
  team_h: 2,
  team_h_score: 0,
  stats: [
    {
      identifier: 'goals_scored',
      a: [],
      h: [],
    },
    {
      identifier: 'saves',
      a: [{ value: 3, element: 469 }],
      h: [{ value: 3, element: 33 }],
    },
  ],
  team_h_difficulty: 3,
  team_a_difficulty: 4,
  pulse_id: 124792,
};

export const mockRawFPLFixture3: RawFPLFixture = {
  code: 2561897,
  event: 2,
  finished: false,
  finished_provisional: false,
  id: 3,
  kickoff_time: '2025-08-23T14:00:00Z',
  minutes: 0,
  provisional_start_time: false,
  started: null,
  team_a: 7,
  team_a_score: null,
  team_h: 10,
  team_h_score: null,
  stats: [],
  team_h_difficulty: 4,
  team_a_difficulty: 3,
  pulse_id: 124793,
};

export const mockRawFPLFixtures: RawFPLFixture[] = [
  mockRawFPLFixture1,
  mockRawFPLFixture2,
  mockRawFPLFixture3,
];

export const mockFixture1: Fixture = {
  id: 1,
  code: 2561895,
  event: 1,
  finished: true,
  finishedProvisional: true,
  kickoffTime: new Date('2025-08-15T19:00:00Z'),
  minutes: 90,
  provisionalStartTime: false,
  started: true,
  teamA: 4,
  teamAScore: 2,
  teamH: 12,
  teamHScore: 4,
  stats: [
    {
      identifier: 'goals_scored',
      a: [{ value: 2, element: 82 }],
      h: [
        { value: 1, element: 381 },
        { value: 1, element: 384 },
        { value: 1, element: 385 },
        { value: 1, element: 661 },
      ],
    },
    {
      identifier: 'assists',
      a: [
        { value: 1, element: 86 },
        { value: 1, element: 93 },
      ],
      h: [
        { value: 1, element: 386 },
        { value: 1, element: 392 },
        { value: 1, element: 661 },
      ],
    },
  ],
  teamHDifficulty: 3,
  teamADifficulty: 5,
  pulseId: 124791,
  createdAt: null,
  updatedAt: null,
};

export const mockFixture2: Fixture = {
  id: 2,
  code: 2561896,
  event: 1,
  finished: true,
  finishedProvisional: true,
  kickoffTime: new Date('2025-08-16T11:30:00Z'),
  minutes: 90,
  provisionalStartTime: false,
  started: true,
  teamA: 15,
  teamAScore: 0,
  teamH: 2,
  teamHScore: 0,
  stats: [
    {
      identifier: 'goals_scored',
      a: [],
      h: [],
    },
    {
      identifier: 'saves',
      a: [{ value: 3, element: 469 }],
      h: [{ value: 3, element: 33 }],
    },
  ],
  teamHDifficulty: 3,
  teamADifficulty: 4,
  pulseId: 124792,
  createdAt: null,
  updatedAt: null,
};

export const mockFixture3: Fixture = {
  id: 3,
  code: 2561897,
  event: 2,
  finished: false,
  finishedProvisional: false,
  kickoffTime: new Date('2025-08-23T14:00:00Z'),
  minutes: 0,
  provisionalStartTime: false,
  started: null,
  teamA: 7,
  teamAScore: null,
  teamH: 10,
  teamHScore: null,
  stats: [],
  teamHDifficulty: 4,
  teamADifficulty: 3,
  pulseId: 124793,
  createdAt: null,
  updatedAt: null,
};

export const mockFixtures: Fixture[] = [mockFixture1, mockFixture2, mockFixture3];
