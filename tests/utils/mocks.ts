import {
  mockBootstrapResponseFixture as eventsMockFixture,
  transformedEventsFixture,
} from '../fixtures/events.fixtures';
import {
  mockBootstrapResponseFixture as teamsMockFixture,
  transformedTeamsFixture,
} from '../fixtures/teams.fixtures';

// Mock FPL Client - now supports both teams and events
export const createMockFPLClient = (mockResponse = teamsMockFixture) => ({
  getBootstrap: async () => mockResponse,
});

// Mock FPL Client specifically for events
export const createMockEventsClient = () => ({
  getBootstrap: async () => eventsMockFixture,
});

// Mock Database Client
export const createMockDb = () => ({
  select: async () => [],
  insert: async () => [],
  update: async () => [],
  delete: async () => undefined,
  execute: async () => undefined,
});

// Mock Redis Client
export const createMockRedis = () => ({
  get: async () => null,
  set: async () => 'OK',
  setex: async () => 'OK',
  del: async () => 1,
  exists: async () => 0,
  flushdb: async () => 'OK',
  connect: async () => undefined,
  disconnect: async () => undefined,
  on: () => undefined,
});

// Mock Teams Repository
export const createMockTeamRepository = () => ({
  findAll: async () => transformedTeamsFixture,
  findById: async () => transformedTeamsFixture[0],
  upsert: async () => transformedTeamsFixture[0],
  upsertBatch: async () => transformedTeamsFixture,
  deleteAll: async () => undefined,
});

// Mock Events Repository
export const createMockEventRepository = () => ({
  findAll: async () => transformedEventsFixture,
  findById: async () => transformedEventsFixture[0],
  findCurrent: async () => transformedEventsFixture.find((e) => e.isCurrent) || null,
  findNext: async () => transformedEventsFixture.find((e) => e.isNext) || null,
  upsert: async () => transformedEventsFixture[0],
  upsertBatch: async () => transformedEventsFixture,
  deleteAll: async () => undefined,
});

// Mock Cache Operations
export const createMockCacheOperations = () => ({
  get: async () => transformedTeamsFixture,
  set: async () => undefined,
  invalidate: async () => undefined,
  exists: async () => true,
});

// Mock Express Request/Response
export const createMockRequest = (overrides = {}) => ({
  method: 'GET',
  url: '/api/teams',
  headers: {},
  body: {},
  params: {},
  query: {},
  ...overrides,
});

export const createMockResponse = () => {
  const res = {
    status: () => res,
    json: () => res,
    send: () => res,
    end: () => res,
    setHeader: () => res,
    locals: {},
  };
  return res;
};

// Mock Next function for Express middleware
export const createMockNext = () => () => {};

// Mock Logger
export const createMockLogger = () => ({
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
});

// Mock fetch for HTTP requests
export const createMockFetch = (mockResponse = teamsMockFixture) => {
  return async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => mockResponse,
    text: async () => JSON.stringify(mockResponse),
    headers: new Headers({
      'Content-Type': 'application/json',
    }),
  });
};

// Mock Error for testing error scenarios
export class MockError extends Error {
  constructor(
    message: string,
    public code?: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'MockError';
  }
}

// Mock implementations with different scenarios
export const mockScenarios = {
  success: {
    fplClient: () => createMockFPLClient(),
    db: () => ({
      ...createMockDb(),
      select: async () => transformedTeamsFixture,
      insert: async () => [transformedTeamsFixture[0]],
    }),
    redis: () => ({
      ...createMockRedis(),
      get: async () => JSON.stringify(transformedTeamsFixture),
      set: async () => 'OK',
    }),
  },

  failure: {
    fplClient: () => ({
      getBootstrap: async () => {
        throw new MockError('FPL API Error', 'FPL_ERROR', 500);
      },
    }),
    db: () => ({
      ...createMockDb(),
      select: async () => {
        throw new MockError('Database Error', 'DB_ERROR');
      },
      insert: async () => {
        throw new MockError('Database Insert Error', 'DB_INSERT_ERROR');
      },
    }),
    redis: () => ({
      ...createMockRedis(),
      get: async () => {
        throw new MockError('Redis Error', 'REDIS_ERROR');
      },
      set: async () => {
        throw new MockError('Redis Set Error', 'REDIS_SET_ERROR');
      },
    }),
  },

  cacheHit: {
    redis: () => ({
      ...createMockRedis(),
      get: async () => JSON.stringify(transformedTeamsFixture),
      exists: async () => 1,
    }),
  },

  cacheMiss: {
    redis: () => ({
      ...createMockRedis(),
      get: async () => null,
      exists: async () => 0,
    }),
  },
};

// Helper to create mock environment
export const setupMockEnvironment = () => {
  // Mock global fetch if not available
  if (!global.fetch) {
    global.fetch = createMockFetch() as any;
  }

  // Mock console methods to reduce test noise (optional)
  // global.console.log = () => {};
  // global.console.info = () => {};
  // global.console.warn = () => {};
  // global.console.error = () => {};
};

// Helper to cleanup mocks
export const cleanupMocks = () => {
  // Cleanup would go here if needed
};
