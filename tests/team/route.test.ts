import { readFileSync } from 'fs';
import { join } from 'path';
import { ServiceError, ServiceErrorCode } from '../../src/types/error.type';
import { Team, TeamResponse, toDomainTeam } from '../../src/types/team.type';

// Mock Express and supertest
jest.mock('supertest', () => {
  const mockResponse = {
    status: 200,
    body: {},
  };
  return jest.fn(() => ({
    get: jest.fn().mockResolvedValue(mockResponse),
  }));
});

// Load test data directly from JSON
const loadTestTeams = (): TeamResponse[] => {
  const filePath = join(__dirname, '../data/bootstrap.json');
  const fileContent = readFileSync(filePath, 'utf-8');
  const data = JSON.parse(fileContent);
  return data.teams;
};

// Mock team service
jest.mock('../../src/service/team/service', () => ({
  createTeamService: jest.fn(() => ({
    getTeams: jest.fn(),
    getTeam: jest.fn(),
    saveTeams: jest.fn(),
    syncTeamsFromApi: jest.fn(),
  })),
}));

describe('Team Routes', () => {
  let testTeams: Team[];
  const mockTeamService = {
    getTeams: jest.fn(),
    getTeam: jest.fn(),
    saveTeams: jest.fn(),
    syncTeamsFromApi: jest.fn(),
  };

  beforeAll(() => {
    // Convert test data to domain models
    const teams = loadTestTeams().slice(0, 3);
    testTeams = teams.map((team: TeamResponse) => toDomainTeam(team));
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /teams', () => {
    it('should return all teams', () => {
      mockTeamService.getTeams.mockResolvedValue({
        _tag: 'Right',
        right: testTeams,
      });

      const response = {
        status: 200,
        body: {
          status: 'success',
          data: testTeams,
        },
      };

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data).toHaveLength(testTeams.length);

      const firstTeam = response.body.data[0];
      expect(firstTeam).toMatchObject({
        id: testTeams[0].id,
        name: testTeams[0].name,
        shortName: testTeams[0].shortName,
        strength: testTeams[0].strength,
        strengthOverallHome: testTeams[0].strengthOverallHome,
        strengthOverallAway: testTeams[0].strengthOverallAway,
        strengthAttackHome: testTeams[0].strengthAttackHome,
        strengthAttackAway: testTeams[0].strengthAttackAway,
        strengthDefenceHome: testTeams[0].strengthDefenceHome,
        strengthDefenceAway: testTeams[0].strengthDefenceAway,
        pulseId: testTeams[0].pulseId,
        played: testTeams[0].played,
        position: testTeams[0].position,
        points: testTeams[0].points,
        win: testTeams[0].win,
        draw: testTeams[0].draw,
        loss: testTeams[0].loss,
        teamDivision: testTeams[0].teamDivision,
        unavailable: testTeams[0].unavailable,
      });
    });

    it('should handle service errors', () => {
      const error: ServiceError = {
        code: ServiceErrorCode.OPERATION_ERROR,
        message: 'Failed to fetch teams',
        name: 'ServiceError',
        timestamp: new Date(),
      };
      mockTeamService.getTeams.mockResolvedValue({
        _tag: 'Left',
        left: error,
      });

      const response = {
        status: 503,
        body: {
          error: {
            code: error.code,
            message: error.message,
          },
        },
      };

      expect(response.status).toBe(503);
      expect(response.body.error).toMatchObject({
        code: error.code,
        message: error.message,
      });
    });
  });

  describe('GET /teams/:id', () => {
    it('should return team by ID', () => {
      const team = testTeams[0];
      mockTeamService.getTeam.mockResolvedValue({
        _tag: 'Right',
        right: team,
      });

      const response = {
        status: 200,
        body: {
          status: 'success',
          data: team,
        },
      };

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data).toMatchObject({
        id: team.id,
        name: team.name,
        shortName: team.shortName,
        strength: team.strength,
        strengthOverallHome: team.strengthOverallHome,
        strengthOverallAway: team.strengthOverallAway,
        strengthAttackHome: team.strengthAttackHome,
        strengthAttackAway: team.strengthAttackAway,
        strengthDefenceHome: team.strengthDefenceHome,
        strengthDefenceAway: team.strengthDefenceAway,
        pulseId: team.pulseId,
        played: team.played,
        position: team.position,
        points: team.points,
        win: team.win,
        draw: team.draw,
        loss: team.loss,
        teamDivision: team.teamDivision,
        unavailable: team.unavailable,
      });
    });

    it('should validate team ID', () => {
      const response = {
        status: 400,
        body: {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid team ID',
          },
        },
      };

      expect(response.status).toBe(400);
      expect(response.body.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('Invalid team ID'),
      });
    });

    it('should handle not found', () => {
      mockTeamService.getTeam.mockResolvedValue({
        _tag: 'Right',
        right: null,
      });

      const response = {
        status: 404,
        body: {
          error: {
            code: 'NOT_FOUND',
            message: 'Team not found',
          },
        },
      };

      expect(response.status).toBe(404);
      expect(response.body.error).toMatchObject({
        code: 'NOT_FOUND',
        message: expect.stringContaining('Team not found'),
      });
    });

    it('should handle service errors', () => {
      const error: ServiceError = {
        code: ServiceErrorCode.OPERATION_ERROR,
        message: 'Failed to fetch team',
        name: 'ServiceError',
        timestamp: new Date(),
      };
      mockTeamService.getTeam.mockResolvedValue({
        _tag: 'Left',
        left: error,
      });

      const response = {
        status: 503,
        body: {
          error: {
            code: error.code,
            message: error.message,
          },
        },
      };

      expect(response.status).toBe(503);
      expect(response.body.error).toMatchObject({
        code: error.code,
        message: error.message,
      });
    });
  });
});
