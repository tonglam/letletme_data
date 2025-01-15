import { PrismaClient } from '@prisma/client';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { DeepMockProxy, mockDeep } from 'jest-mock-extended';
import { createPlayerQueryRepository } from '../../src/domain/player/query/repository';
import { TeamService } from '../../src/service/team/types';
import { DomainErrorCode } from '../../src/types/error.type';
import { PlayerId } from '../../src/types/player/base.type';
import { Team, TeamId } from '../../src/types/team.type';

describe('Player Query Repository Tests', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let teamService: DeepMockProxy<TeamService>;

  const testPlayer = {
    element: 1,
    elementCode: 12345,
    price: 100,
    startPrice: 100,
    elementType: 1,
    firstName: 'Test',
    secondName: 'Player',
    webName: 'T.Player',
    teamId: 1,
    createdAt: new Date(),
  };

  const testTeam: Team = {
    id: 1 as TeamId,
    name: 'Test Team',
    shortName: 'TST',
    code: 1,
    strength: 4,
    strengthOverallHome: 1200,
    strengthOverallAway: 1180,
    strengthAttackHome: 1150,
    strengthAttackAway: 1130,
    strengthDefenceHome: 1170,
    strengthDefenceAway: 1160,
    pulseId: 1,
    played: 0,
    position: 1,
    points: 0,
    form: null,
    win: 0,
    draw: 0,
    loss: 0,
    teamDivision: null,
    unavailable: false,
  };

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    teamService = mockDeep<TeamService>();
  });

  describe('getPlayer', () => {
    it('should return player with team data', async () => {
      prisma.player.findUnique.mockResolvedValue(testPlayer);
      teamService.getTeam.mockImplementation(() => TE.right(testTeam));
      const repository = createPlayerQueryRepository(prisma, teamService);

      const result = await repository.getPlayer(1 as PlayerId)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toMatchObject({
          id: testPlayer.element,
          webName: testPlayer.webName,
          team: {
            id: testTeam.id,
            name: testTeam.name,
          },
        });
      }
    });

    it('should return null for non-existent player', async () => {
      prisma.player.findUnique.mockResolvedValue(null);
      const repository = createPlayerQueryRepository(prisma, teamService);

      const result = await repository.getPlayer(999 as PlayerId)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toBeNull();
      }
    });

    it('should handle database errors', async () => {
      prisma.player.findUnique.mockRejectedValue(new Error('DB error'));
      const repository = createPlayerQueryRepository(prisma, teamService);

      const result = await repository.getPlayer(1 as PlayerId)();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(DomainErrorCode.DATABASE_ERROR);
        expect(result.left.message).toContain('Failed to fetch player from database');
      }
    });
  });

  describe('getAllPlayers', () => {
    it('should return all players with team data', async () => {
      prisma.player.findMany.mockResolvedValue([testPlayer]);
      teamService.getTeams.mockImplementation(() => TE.right([testTeam]));
      const repository = createPlayerQueryRepository(prisma, teamService);

      const result = await repository.getAllPlayers()();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toHaveLength(1);
        expect(result.right[0]).toMatchObject({
          id: testPlayer.element,
          webName: testPlayer.webName,
          team: {
            id: testTeam.id,
            name: testTeam.name,
          },
        });
      }
    });

    it('should handle database errors', async () => {
      prisma.player.findMany.mockRejectedValue(new Error('DB error'));
      const repository = createPlayerQueryRepository(prisma, teamService);

      const result = await repository.getAllPlayers()();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(DomainErrorCode.DATABASE_ERROR);
        expect(result.left.message).toContain('Failed to fetch players from database');
      }
    });
  });

  describe('getPlayersByTeam', () => {
    it('should return players by team', async () => {
      prisma.player.findMany.mockResolvedValue([testPlayer]);
      teamService.getTeams.mockImplementation(() => TE.right([testTeam]));
      const repository = createPlayerQueryRepository(prisma, teamService);

      const result = await repository.getPlayersByTeam(1)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toHaveLength(1);
        expect(result.right[0]).toMatchObject({
          id: testPlayer.element,
          webName: testPlayer.webName,
          team: {
            id: testTeam.id,
            name: testTeam.name,
          },
        });
      }
    });
  });

  describe('getPlayersByElementType', () => {
    it('should return players by element type', async () => {
      prisma.player.findMany.mockResolvedValue([testPlayer]);
      teamService.getTeams.mockImplementation(() => TE.right([testTeam]));
      const repository = createPlayerQueryRepository(prisma, teamService);

      const result = await repository.getPlayersByElementType('GOALKEEPER')();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toHaveLength(1);
        expect(result.right[0]).toMatchObject({
          id: testPlayer.element,
          webName: testPlayer.webName,
          team: {
            id: testTeam.id,
            name: testTeam.name,
          },
        });
      }
    });
  });
});
