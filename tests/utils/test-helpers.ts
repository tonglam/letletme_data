import { expect } from 'bun:test';

import type { RawFPLTeam, Team } from '../../src/types';

// Test data generators
export const generateRawTeam = (overrides: Partial<RawFPLTeam> = {}): RawFPLTeam => ({
  id: 1,
  code: 3,
  name: 'Test Team',
  short_name: 'TST',
  strength: 3,
  position: 0,
  points: 0,
  played: 0,
  win: 0,
  draw: 0,
  loss: 0,
  form: null,
  team_division: null,
  unavailable: false,
  strength_overall_home: 1200,
  strength_overall_away: 1200,
  strength_attack_home: 1200,
  strength_attack_away: 1200,
  strength_defence_home: 1200,
  strength_defence_away: 1200,
  pulse_id: 1,
  ...overrides,
});

export const generateTeam = (overrides: Partial<Team> = {}): Team => ({
  id: 1,
  name: 'Test Team',
  shortName: 'TST',
  code: 3,
  draw: 0,
  form: null,
  loss: 0,
  played: 0,
  points: 0,
  position: 0,
  strength: 3,
  teamDivision: null,
  unavailable: false,
  win: 0,
  strengthOverallHome: 1200,
  strengthOverallAway: 1200,
  strengthAttackHome: 1200,
  strengthAttackAway: 1200,
  strengthDefenceHome: 1200,
  strengthDefenceAway: 1200,
  pulseId: 1,
  ...overrides,
});

export const generateTeams = (count: number): Team[] => {
  return Array.from({ length: count }, (_, index) =>
    generateTeam({
      id: index + 1,
      code: index + 1,
      name: `Team ${index + 1}`,
      shortName: `T${String(index + 1).padStart(2, '0')}`,
      strength: Math.floor(Math.random() * 5) + 1,
      position: index + 1,
      points: Math.floor(Math.random() * 100),
      pulseId: index + 1,
    }),
  );
};

// Assertion helpers
export const assertTeamStructure = (team: Team) => {
  expect(team).toBeDefined();
  expect(typeof team.id).toBe('number');
  expect(typeof team.name).toBe('string');
  expect(typeof team.shortName).toBe('string');
  expect(typeof team.code).toBe('number');
  expect(typeof team.strength).toBe('number');
  expect(typeof team.position).toBe('number');
  expect(typeof team.points).toBe('number');
  expect(typeof team.played).toBe('number');
  expect(typeof team.win).toBe('number');
  expect(typeof team.draw).toBe('number');
  expect(typeof team.loss).toBe('number');
  expect(typeof team.unavailable).toBe('boolean');

  // Strength values should be numbers
  expect(typeof team.strengthOverallHome).toBe('number');
  expect(typeof team.strengthOverallAway).toBe('number');
  expect(typeof team.strengthAttackHome).toBe('number');
  expect(typeof team.strengthAttackAway).toBe('number');
  expect(typeof team.strengthDefenceHome).toBe('number');
  expect(typeof team.strengthDefenceAway).toBe('number');
  expect(typeof team.pulseId).toBe('number');

  // These can be null
  if (team.form !== null) {
    expect(typeof team.form).toBe('string');
  }
  if (team.teamDivision !== null) {
    expect(typeof team.teamDivision).toBe('string');
  }
};

export const assertTeamsArray = (teams: Team[]) => {
  expect(Array.isArray(teams)).toBe(true);
  teams.forEach(assertTeamStructure);
};

// Database test helpers
export const createTempTable = async (db: any, tableName: string) => {
  await db.execute(`
    CREATE TEMP TABLE ${tableName} AS 
    SELECT * FROM teams WHERE 1=0
  `);
};

export const dropTempTable = async (db: any, tableName: string) => {
  await db.execute(`DROP TABLE IF EXISTS ${tableName}`);
};

// Redis test helpers
export const setTestKey = async (redis: any, key: string, value: any, ttl?: number) => {
  const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
  if (ttl) {
    await redis.setex(key, ttl, stringValue);
  } else {
    await redis.set(key, stringValue);
  }
};

export const getTestKey = async (redis: any, key: string) => {
  const value = await redis.get(key);
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

export const clearTestKeys = async (redis: any, pattern: string) => {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
};

// API test helpers
export const createTestApp = () => {
  // This would return a test Express app instance
  // For now, return a mock
  return {
    get: () => {},
    post: () => {},
    put: () => {},
    delete: () => {},
    listen: () => {},
  };
};

// Timing helpers
export const measureExecutionTime = async <T>(
  operation: () => Promise<T>,
): Promise<{ result: T; duration: number }> => {
  const startTime = performance.now();
  const result = await operation();
  const endTime = performance.now();

  return {
    result,
    duration: endTime - startTime,
  };
};

// Wait helper for async operations
export const waitFor = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

// Retry helper for flaky operations
export const retry = async <T>(
  operation: () => Promise<T>,
  maxAttempts: number = 3,
  delay: number = 100,
): Promise<T> => {
  let lastError: Error;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxAttempts) {
        await waitFor(delay * attempt); // Exponential backoff
      }
    }
  }

  throw lastError!;
};

// Data comparison helpers
export const compareTeams = (team1: Team, team2: Team): boolean => {
  return (
    team1.id === team2.id &&
    team1.name === team2.name &&
    team1.shortName === team2.shortName &&
    team1.code === team2.code &&
    team1.strength === team2.strength
  );
};

export const findTeamDifferences = (team1: Team, team2: Team): string[] => {
  const differences: string[] = [];

  Object.keys(team1).forEach((key) => {
    const key1 = key as keyof Team;
    if (team1[key1] !== team2[key1]) {
      differences.push(`${key}: ${team1[key1]} !== ${team2[key1]}`);
    }
  });

  return differences;
};

// Error simulation helpers
export const simulateNetworkError = () => {
  throw new Error('Network error: ECONNREFUSED');
};

export const simulateDatabaseError = () => {
  throw new Error('Database error: Connection lost');
};

export const simulateRedisError = () => {
  throw new Error('Redis error: Connection timeout');
};

// Environment helpers
export const withTestEnv = <T>(envVars: Record<string, string>, operation: () => T): T => {
  const originalEnv = { ...process.env };

  // Set test environment variables
  Object.entries(envVars).forEach(([key, value]) => {
    process.env[key] = value;
  });

  try {
    return operation();
  } finally {
    // Restore original environment
    process.env = originalEnv;
  }
};

// Logging helpers for tests
export const captureLogOutput = () => {
  const logs: string[] = [];
  // eslint-disable-next-line no-console
  const originalLog = console.log;
  const originalError = console.error;

  // eslint-disable-next-line no-console
  console.log = (...args) => logs.push(`LOG: ${args.join(' ')}`);
  console.error = (...args) => logs.push(`ERROR: ${args.join(' ')}`);

  return {
    logs,
    restore: () => {
      // eslint-disable-next-line no-console
      console.log = originalLog;
      console.error = originalError;
    },
  };
};
