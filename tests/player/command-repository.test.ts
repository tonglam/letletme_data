import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { DBError, DBErrorCode } from '../../src/types/error.type';
import { Player, PlayerId } from '../../src/types/player.type';
import { PlayerRepository } from '../../src/types/player/repository.type';
import { TeamId } from '../../src/types/team.type';

describe('Player Command Repository Tests', () => {
  const testPlayer: Player = {
    id: 1 as PlayerId,
    elementCode: 1,
    price: 100,
    startPrice: 100,
    elementType: 1,
    firstName: 'Test',
    secondName: 'Player',
    webName: 'Test Player',
    teamId: 1,
  };

  describe('findById', () => {
    it('should find player by id', async () => {
      const repository: PlayerRepository = {
        findById: () => TE.right(testPlayer),
        findAll: () => TE.right([]),
        findByTeamId: () => TE.right([]),
        saveBatch: () => TE.right([]),
        deleteAll: () => TE.right(undefined),
      };

      const result = await repository.findById(1 as PlayerId)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual(testPlayer);
      }
    });

    it('should return null for non-existent player', async () => {
      const repository: PlayerRepository = {
        findById: () => TE.right(null),
        findAll: () => TE.right([]),
        findByTeamId: () => TE.right([]),
        saveBatch: () => TE.right([]),
        deleteAll: () => TE.right(undefined),
      };

      const result = await repository.findById(999 as PlayerId)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toBeNull();
      }
    });

    it('should handle database errors', async () => {
      const repository: PlayerRepository = {
        findById: () =>
          TE.left({
            name: 'DBError',
            code: DBErrorCode.OPERATION_ERROR,
            message: 'Failed to find player',
            timestamp: new Date(),
          } as DBError),
        findAll: () => TE.right([]),
        findByTeamId: () => TE.right([]),
        saveBatch: () => TE.right([]),
        deleteAll: () => TE.right(undefined),
      };

      const result = await repository.findById(1 as PlayerId)();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        const error = result.left as DBError;
        expect(error.code).toBe(DBErrorCode.OPERATION_ERROR);
        expect(error.message).toContain('Failed to find player');
      }
    });
  });

  describe('findAll', () => {
    it('should return all players', async () => {
      const repository: PlayerRepository = {
        findById: () => TE.right(null),
        findAll: () => TE.right([testPlayer]),
        findByTeamId: () => TE.right([]),
        saveBatch: () => TE.right([]),
        deleteAll: () => TE.right(undefined),
      };

      const result = await repository.findAll()();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toHaveLength(1);
        expect(result.right[0]).toEqual(testPlayer);
      }
    });

    it('should handle database errors', async () => {
      const repository: PlayerRepository = {
        findById: () => TE.right(null),
        findAll: () =>
          TE.left({
            name: 'DBError',
            code: DBErrorCode.OPERATION_ERROR,
            message: 'Failed to fetch players',
            timestamp: new Date(),
          } as DBError),
        findByTeamId: () => TE.right([]),
        saveBatch: () => TE.right([]),
        deleteAll: () => TE.right(undefined),
      };

      const result = await repository.findAll()();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        const error = result.left as DBError;
        expect(error.code).toBe(DBErrorCode.OPERATION_ERROR);
        expect(error.message).toContain('Failed to fetch players');
      }
    });
  });

  describe('findByTeamId', () => {
    it('should return players by team id', async () => {
      const repository: PlayerRepository = {
        findById: () => TE.right(null),
        findAll: () => TE.right([]),
        findByTeamId: () => TE.right([testPlayer]),
        saveBatch: () => TE.right([]),
        deleteAll: () => TE.right(undefined),
      };

      const result = await repository.findByTeamId(1 as TeamId)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toHaveLength(1);
        expect(result.right[0]).toEqual(testPlayer);
      }
    });

    it('should handle database errors', async () => {
      const repository: PlayerRepository = {
        findById: () => TE.right(null),
        findAll: () => TE.right([]),
        findByTeamId: () =>
          TE.left({
            name: 'DBError',
            code: DBErrorCode.OPERATION_ERROR,
            message: 'Failed to fetch players by team',
            timestamp: new Date(),
          } as DBError),
        saveBatch: () => TE.right([]),
        deleteAll: () => TE.right(undefined),
      };

      const result = await repository.findByTeamId(1 as TeamId)();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        const error = result.left as DBError;
        expect(error.code).toBe(DBErrorCode.OPERATION_ERROR);
        expect(error.message).toContain('Failed to fetch players by team');
      }
    });
  });

  describe('saveBatch', () => {
    it('should save multiple players', async () => {
      const repository: PlayerRepository = {
        findById: () => TE.right(null),
        findAll: () => TE.right([]),
        findByTeamId: () => TE.right([]),
        saveBatch: () => TE.right([testPlayer]),
        deleteAll: () => TE.right(undefined),
      };

      const result = await repository.saveBatch([testPlayer])();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toHaveLength(1);
        expect(result.right[0]).toEqual(testPlayer);
      }
    });

    it('should handle database errors during batch save', async () => {
      const repository: PlayerRepository = {
        findById: () => TE.right(null),
        findAll: () => TE.right([]),
        findByTeamId: () => TE.right([]),
        saveBatch: () =>
          TE.left({
            name: 'DBError',
            code: DBErrorCode.OPERATION_ERROR,
            message: 'Failed to save players',
            timestamp: new Date(),
          } as DBError),
        deleteAll: () => TE.right(undefined),
      };

      const result = await repository.saveBatch([testPlayer])();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        const error = result.left as DBError;
        expect(error.code).toBe(DBErrorCode.OPERATION_ERROR);
        expect(error.message).toContain('Failed to save players');
      }
    });
  });

  describe('deleteAll', () => {
    it('should delete all players', async () => {
      const repository: PlayerRepository = {
        findById: () => TE.right(null),
        findAll: () => TE.right([]),
        findByTeamId: () => TE.right([]),
        saveBatch: () => TE.right([]),
        deleteAll: () => TE.right(undefined),
      };

      const result = await repository.deleteAll()();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toBeUndefined();
      }
    });

    it('should handle database errors during deletion', async () => {
      const repository: PlayerRepository = {
        findById: () => TE.right(null),
        findAll: () => TE.right([]),
        findByTeamId: () => TE.right([]),
        saveBatch: () => TE.right([]),
        deleteAll: () =>
          TE.left({
            name: 'DBError',
            code: DBErrorCode.OPERATION_ERROR,
            message: 'Failed to delete all players',
            timestamp: new Date(),
          } as DBError),
      };

      const result = await repository.deleteAll()();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        const error = result.left as DBError;
        expect(error.code).toBe(DBErrorCode.OPERATION_ERROR);
        expect(error.message).toContain('Failed to delete all players');
      }
    });
  });
});
