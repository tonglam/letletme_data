import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { DeepMockProxy, mockDeep } from 'jest-mock-extended';
import { createPlayerCommandOperations } from '../../src/domain/player/command/operation';
import { ElementType } from '../../src/types/base.type';
import { createDBError, DBErrorCode, DomainErrorCode } from '../../src/types/error.type';
import { Player, PlayerId } from '../../src/types/player/base.type';
import { PlayerRepository } from '../../src/types/player/repository.type';

describe('Player Command Operations Tests', () => {
  let playerRepository: DeepMockProxy<PlayerRepository>;

  const testPlayer: Player = {
    id: 1 as PlayerId,
    elementCode: 12345,
    price: 100,
    startPrice: 100,
    elementType: ElementType.GKP,
    firstName: 'Test',
    secondName: 'Player',
    webName: 'T.Player',
    teamId: 1,
  };

  beforeEach(() => {
    playerRepository = mockDeep<PlayerRepository>();
  });

  describe('getPlayerById', () => {
    it('should return player by id', async () => {
      playerRepository.findById.mockImplementation(() => TE.right(testPlayer));
      const operations = createPlayerCommandOperations(playerRepository);

      const result = await operations.getPlayerById(1 as PlayerId)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual(testPlayer);
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
      const operations = createPlayerCommandOperations(playerRepository);

      const result = await operations.getPlayerById(1 as PlayerId)();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(DomainErrorCode.DATABASE_ERROR);
      }
    });
  });

  describe('createPlayers', () => {
    const players = [testPlayer];

    it('should create multiple players', async () => {
      playerRepository.saveBatch.mockImplementation(() => TE.right(players));
      const operations = createPlayerCommandOperations(playerRepository);

      const result = await operations.createPlayers(players)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual(players);
      }
    });

    it('should handle repository errors', async () => {
      playerRepository.saveBatch.mockImplementation(() =>
        TE.left(
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: 'DB error',
          }),
        ),
      );
      const operations = createPlayerCommandOperations(playerRepository);

      const result = await operations.createPlayers(players)();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(DomainErrorCode.DATABASE_ERROR);
      }
    });
  });

  describe('deleteAll', () => {
    it('should delete all players', async () => {
      playerRepository.deleteAll.mockImplementation(() => TE.right(void 0));
      const operations = createPlayerCommandOperations(playerRepository);

      const result = await operations.deleteAll()();
      expect(E.isRight(result)).toBe(true);
    });

    it('should handle repository errors', async () => {
      playerRepository.deleteAll.mockImplementation(() =>
        TE.left(
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: 'DB error',
          }),
        ),
      );
      const operations = createPlayerCommandOperations(playerRepository);

      const result = await operations.deleteAll()();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(DomainErrorCode.DATABASE_ERROR);
      }
    });
  });
});
