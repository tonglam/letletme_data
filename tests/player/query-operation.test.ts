import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { DeepMockProxy, mockDeep } from 'jest-mock-extended';
import { createPlayerQueryOperations } from '../../src/domain/player/query/operation';
import { ElementType } from '../../src/types/base.type';
import { createDBError, DBErrorCode, DomainErrorCode } from '../../src/types/error.type';
import { Player, PlayerId } from '../../src/types/player/base.type';
import { PlayerRepository } from '../../src/types/player/repository.type';
import { Team, TeamId } from '../../src/types/team.type';
import { TeamRepository } from '../../src/types/team/repository.type';

describe('Player Query Operations Tests', () => {
  let playerRepository: DeepMockProxy<PlayerRepository>;
  let teamRepository: DeepMockProxy<TeamRepository>;

  const testPlayer: Player = {
    id: 1 as PlayerId,
    elementCode: 12345,
    price: 100,
    startPrice: 100,
    elementType: ElementType.GKP,
    firstName: 'Test',
    secondName: 'Player',
    webName: 'T.Player',
    teamId: 1 as TeamId,
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
    playerRepository = mockDeep<PlayerRepository>();
    teamRepository = mockDeep<TeamRepository>();
  });

  describe('getPlayerWithTeam', () => {
    it('should return player with team data', async () => {
      playerRepository.findById.mockImplementation(() => TE.right(testPlayer));
      teamRepository.findById.mockImplementation(() => TE.right(testTeam));

      const operations = createPlayerQueryOperations(playerRepository, teamRepository);
      const result = await operations.getPlayerWithTeam(1 as PlayerId)();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toMatchObject({
          id: testPlayer.id,
          webName: testPlayer.webName,
          team: {
            id: testTeam.id,
            name: testTeam.name,
          },
        });
      }
    });

    it('should return null for non-existent player', async () => {
      playerRepository.findById.mockImplementation(() => TE.right(null));

      const operations = createPlayerQueryOperations(playerRepository, teamRepository);
      const result = await operations.getPlayerWithTeam(999 as PlayerId)();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toBeNull();
      }
    });

    it('should handle missing team data', async () => {
      playerRepository.findById.mockImplementation(() => TE.right(testPlayer));
      teamRepository.findById.mockImplementation(() => TE.right(null));

      const operations = createPlayerQueryOperations(playerRepository, teamRepository);
      const result = await operations.getPlayerWithTeam(1 as PlayerId)();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(DomainErrorCode.DATABASE_ERROR);
        expect(result.left.message).toContain('Team not found');
      }
    });

    it('should handle repository errors', async () => {
      playerRepository.findById.mockImplementation(() =>
        TE.left(
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: 'DB error',
          }),
        ),
      );

      const operations = createPlayerQueryOperations(playerRepository, teamRepository);
      const result = await operations.getPlayerWithTeam(1 as PlayerId)();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(DomainErrorCode.DATABASE_ERROR);
      }
    });
  });

  describe('getAllPlayersWithTeams', () => {
    it('should return all players with team data', async () => {
      playerRepository.findAll.mockImplementation(() => TE.right([testPlayer]));
      teamRepository.findAll.mockImplementation(() => TE.right([testTeam]));

      const operations = createPlayerQueryOperations(playerRepository, teamRepository);
      const result = await operations.getAllPlayersWithTeams()();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toHaveLength(1);
        expect(result.right[0]).toMatchObject({
          id: testPlayer.id,
          webName: testPlayer.webName,
          team: {
            id: testTeam.id,
            name: testTeam.name,
          },
        });
      }
    });

    it('should handle empty results', async () => {
      playerRepository.findAll.mockImplementation(() => TE.right([]));
      teamRepository.findAll.mockImplementation(() => TE.right([]));

      const operations = createPlayerQueryOperations(playerRepository, teamRepository);
      const result = await operations.getAllPlayersWithTeams()();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toHaveLength(0);
      }
    });

    it('should handle repository errors', async () => {
      playerRepository.findAll.mockImplementation(() =>
        TE.left(
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: 'DB error',
          }),
        ),
      );

      const operations = createPlayerQueryOperations(playerRepository, teamRepository);
      const result = await operations.getAllPlayersWithTeams()();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(DomainErrorCode.DATABASE_ERROR);
      }
    });
  });

  describe('getPlayersByTeam', () => {
    it('should return players by team', async () => {
      playerRepository.findByTeamId.mockImplementation(() => TE.right([testPlayer]));
      teamRepository.findById.mockImplementation(() => TE.right(testTeam));

      const operations = createPlayerQueryOperations(playerRepository, teamRepository);
      const result = await operations.getPlayersByTeam(1 as TeamId)();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toHaveLength(1);
        expect(result.right[0]).toMatchObject({
          id: testPlayer.id,
          webName: testPlayer.webName,
          team: {
            id: testTeam.id,
            name: testTeam.name,
          },
        });
      }
    });

    it('should handle non-existent team', async () => {
      playerRepository.findByTeamId.mockImplementation(() => TE.right([]));
      teamRepository.findById.mockImplementation(() => TE.right(null));

      const operations = createPlayerQueryOperations(playerRepository, teamRepository);
      const result = await operations.getPlayersByTeam(999 as TeamId)();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(DomainErrorCode.DATABASE_ERROR);
        expect(result.left.message).toContain('Team 999 not found');
      }
    });

    it('should handle repository errors', async () => {
      playerRepository.findByTeamId.mockImplementation(() =>
        TE.left(
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: 'DB error',
          }),
        ),
      );

      const operations = createPlayerQueryOperations(playerRepository, teamRepository);
      const result = await operations.getPlayersByTeam(1 as TeamId)();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(DomainErrorCode.DATABASE_ERROR);
      }
    });
  });
});
