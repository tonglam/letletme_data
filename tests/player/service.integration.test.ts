import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import { createPlayerCache } from '../../src/domain/player/cache';
import { createPlayerRepository } from '../../src/domain/player/repository';
import { createRedisCache } from '../../src/infrastructure/cache/redis-cache';
import { prisma } from '../../src/infrastructure/db/prisma';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import { createPlayerService } from '../../src/service/player';
import { ElementType } from '../../src/types/base.type';
import { Player, PlayerId, toDomainPlayer } from '../../src/types/player.type';

describe('Player Service Integration Tests', () => {
  const fplClient = createFPLClient();
  const bootstrapAdapter = createBootstrapApiAdapter(fplClient);
  const repository = createPlayerRepository(prisma);
  const redisCache = createRedisCache<Player>({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    db: Number(process.env.REDIS_DB ?? 0),
  });
  const cache = createPlayerCache(redisCache, {
    getOne: async (id: number) => {
      const result = await repository.findById(id as PlayerId)();
      if (E.isRight(result) && result.right) {
        return toDomainPlayer(result.right);
      }
      return null;
    },
    getAll: async () => {
      const result = await repository.findAll()();
      if (E.isRight(result)) {
        return result.right.map(toDomainPlayer);
      }
      return [];
    },
  });
  const service = createPlayerService(bootstrapAdapter, repository, cache);

  beforeAll(async () => {
    // Clear existing data
    await prisma.player.deleteMany();
    await prisma.playerValue.deleteMany();
    await prisma.playerStat.deleteMany();

    // Clear test-specific cache keys
    await redisCache.client.del('players');
    await redisCache.client.del('player:*');

    await pipe(
      service.syncPlayersFromApi(),
      TE.getOrElse((error) => {
        throw error;
      }),
    )();
  }, 30000);

  afterAll(async () => {
    await prisma.$disconnect();
    await redisCache.client.quit();
  });

  describe('Player Retrieval', () => {
    it('should get all players', async () => {
      const result = await pipe(
        service.getPlayers(),
        TE.getOrElse((error) => {
          throw error;
        }),
      )();

      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toMatchObject({
        id: expect.any(Number),
        elementCode: expect.any(Number),
        price: expect.any(Number),
        startPrice: expect.any(Number),
        elementType: expect.any(Number),
        firstName: expect.any(String),
        secondName: expect.any(String),
        webName: expect.any(String),
        teamId: expect.any(Number),
      });
    });

    it('should get player by id', async () => {
      const players = await pipe(
        service.getPlayers(),
        TE.getOrElse((error) => {
          throw error;
        }),
      )();
      expect(players.length).toBeGreaterThan(0);

      const result = await pipe(
        service.getPlayer(players[0].id),
        TE.getOrElse((error) => {
          throw error;
        }),
      )();

      expect(result).toMatchObject({
        id: players[0].id,
        elementCode: expect.any(Number),
        price: expect.any(Number),
        startPrice: expect.any(Number),
        elementType: expect.any(Number),
        firstName: expect.any(String),
        secondName: expect.any(String),
        webName: expect.any(String),
        teamId: expect.any(Number),
      });
    });

    it('should return null for non-existent player id', async () => {
      const result = await pipe(
        service.getPlayer(999999 as PlayerId),
        TE.getOrElse((error) => {
          throw error;
        }),
      )();

      expect(result).toBeNull();
    });
  });

  describe('Player Creation', () => {
    it('should save players', async () => {
      const newPlayers: Player[] = [
        {
          id: 1000 as PlayerId,
          elementCode: 1000,
          price: 100,
          startPrice: 100,
          elementType: ElementType.GKP,
          firstName: 'Test',
          secondName: 'Player 1',
          webName: 'Test Player 1',
          teamId: 1,
        },
        {
          id: 1001 as PlayerId,
          elementCode: 1001,
          price: 100,
          startPrice: 100,
          elementType: ElementType.DEF,
          firstName: 'Test',
          secondName: 'Player 2',
          webName: 'Test Player 2',
          teamId: 1,
        },
      ];

      const result = await pipe(
        service.savePlayers(newPlayers),
        TE.getOrElse((error) => {
          throw error;
        }),
      )();

      expect(result.length).toBe(newPlayers.length);
      expect(result[0]).toMatchObject({
        id: expect.any(Number),
        elementCode: expect.any(Number),
        price: expect.any(Number),
        startPrice: expect.any(Number),
        elementType: expect.any(Number),
        firstName: expect.any(String),
        secondName: expect.any(String),
        webName: expect.any(String),
        teamId: expect.any(Number),
      });
    });
  });
});
