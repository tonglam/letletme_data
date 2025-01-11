import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { CachePrefix } from '../../src/config/cache/cache.config';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import { createPlayerCache } from '../../src/domain/player/cache';
import { createPlayerRepository } from '../../src/domain/player/repository';
import { createTeamRepository } from '../../src/domain/team/repository';
import { createRedisCache } from '../../src/infrastructure/cache/redis-cache';
import { prisma } from '../../src/infrastructure/db/prisma';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import { createPlayerService } from '../../src/service/player';
import { EnhancedPlayer } from '../../src/service/player/types';
import { createTeamService } from '../../src/service/team';
import { ElementType, getCurrentSeason } from '../../src/types/base.type';
import { Player, PlayerId, toDomainPlayer } from '../../src/types/player.type';
import { TeamId } from '../../src/types/team.type';

jest.setTimeout(60000); // Increase global timeout to 60 seconds

describe('Player Service Integration Tests', () => {
  const fplClient = createFPLClient();
  const bootstrapAdapter = createBootstrapApiAdapter(fplClient);
  const repository = createPlayerRepository(prisma);
  const redisCache = createRedisCache<Player>({
    keyPrefix: CachePrefix.PLAYER,
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    db: Number(process.env.REDIS_DB ?? 0),
  });
  const cache = createPlayerCache(
    redisCache,
    {
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
    },
    {
      keyPrefix: CachePrefix.PLAYER,
      season: getCurrentSeason(),
    },
  );

  // Create team service for player enhancement
  const teamRepository = createTeamRepository(prisma);
  const teamService = createTeamService(bootstrapAdapter, teamRepository);
  const service = createPlayerService(
    bootstrapAdapter,
    repository,
    {
      bootstrapApi: bootstrapAdapter,
      teamService: {
        getTeam: (id: number) => teamService.getTeam(id as TeamId),
      },
    },
    cache,
  );

  beforeAll(async () => {
    // Clear existing data
    await prisma.player.deleteMany();
    await prisma.playerValue.deleteMany();
    await prisma.playerStat.deleteMany();
    await prisma.team.deleteMany();

    // Clear test-specific cache keys
    await redisCache.client.del('players');
    await redisCache.client.del('player:*');
    await redisCache.client.del('teams');
    await redisCache.client.del('team:*');

    // First sync teams as players depend on them
    console.log('Syncing teams...');
    const teamsResult = await pipe(
      teamService.syncTeamsFromApi(),
      TE.getOrElse((error) => {
        console.error('Failed to sync teams:', error);
        throw error;
      }),
    )();
    console.log(`Teams synced successfully: ${teamsResult.length} teams`);

    // Verify teams were synced
    const teams = await teamRepository.findAll()();
    if (E.isLeft(teams) || teams.right.length === 0) {
      throw new Error('Failed to sync teams or no teams were synced');
    }
    console.log(`Verified ${teams.right.length} teams in database`);

    // Then sync players
    console.log('Syncing players...');
    const playersResult = await pipe(
      service.syncPlayersFromApi(),
      TE.getOrElse((error) => {
        console.error('Failed to sync players:', error);
        throw error;
      }),
    )();
    console.log(`Players synced successfully: ${playersResult.length} players`);

    // Check Redis keys after sync
    const season = getCurrentSeason();
    const baseKey = `player::${season}`;
    console.log('Checking Redis keys after sync...');
    console.log('Base key:', baseKey);
    const keys = await redisCache.client.keys('player::*');
    console.log('Found keys:', keys);
    const values = await redisCache.client.hgetall(baseKey);
    console.log('Number of cached players:', values ? Object.keys(values).length : 0);

    // Verify players were synced
    const players = await repository.findAll()();
    if (E.isLeft(players) || players.right.length === 0) {
      throw new Error('Failed to sync players or no players were synced');
    }
    console.log(`Verified ${players.right.length} players in database`);
  }, 60000);

  afterAll(async () => {
    // Check Redis keys before cleanup
    const season = getCurrentSeason();
    const baseKey = `player::${season}`;
    console.log('Checking Redis keys before cleanup...');
    console.log('Base key:', baseKey);
    const keys = await redisCache.client.keys('player::*');
    console.log('Found keys:', keys);
    const values = await redisCache.client.hgetall(baseKey);
    console.log('Number of cached players:', values ? Object.keys(values).length : 0);

    await prisma.$disconnect();
    await redisCache.client.quit();
  });

  describe('Player Retrieval', () => {
    it('should get all players with enhanced information', async () => {
      console.log('Getting all players...');
      const startTime = Date.now();

      console.log('Calling service.getPlayers()...');
      const result = await pipe(
        service.getPlayers(),
        TE.getOrElse((error) => {
          console.error('Failed to get players:', error);
          throw error;
        }),
      )();
      const endTime = Date.now();
      console.log(`Got ${result.length} players in ${(endTime - startTime) / 1000}s`);

      expect(result.length).toBeGreaterThan(0);
      const player = result[0] as EnhancedPlayer;
      console.log('Sample player:', {
        id: player.id,
        name: player.webName,
        team: player.team.name,
        elementType: player.elementType,
      });

      expect(player).toMatchObject({
        id: expect.any(Number),
        elementCode: expect.any(Number),
        price: expect.any(Number),
        startPrice: expect.any(Number),
        elementType: expect.stringMatching(/^(Goalkeeper|Defender|Midfielder|Forward)$/),
        firstName: expect.any(String),
        secondName: expect.any(String),
        webName: expect.any(String),
        team: {
          id: expect.any(Number),
          name: expect.any(String),
          shortName: expect.any(String),
        },
      });
      expect(player).not.toHaveProperty('teamId');
    }, 60000);

    it('should get enhanced player by id', async () => {
      console.log('Getting players for ID test...');
      const startGetAll = Date.now();
      const players = await pipe(
        service.getPlayers(),
        TE.getOrElse((error) => {
          console.error('Failed to get players:', error);
          throw error;
        }),
      )();
      console.log(`Got all players in ${(Date.now() - startGetAll) / 1000}s`);
      expect(players.length).toBeGreaterThan(0);

      console.log('Getting enhanced player...');
      const startGetOne = Date.now();
      const result = await pipe(
        service.findPlayerById(players[0].id),
        TE.getOrElse((error) => {
          console.error('Failed to get enhanced player:', error);
          throw error;
        }),
      )();
      console.log(`Got enhanced player in ${(Date.now() - startGetOne) / 1000}s`);

      expect(result).not.toBeNull();
      console.log('Sample enhanced player:', {
        id: result?.id,
        name: result?.webName,
        team: result?.team.name,
        elementType: result?.elementType,
      });

      expect(result).toMatchObject({
        id: players[0].id,
        elementCode: expect.any(Number),
        price: expect.any(Number),
        startPrice: expect.any(Number),
        elementType: expect.stringMatching(/^(Goalkeeper|Defender|Midfielder|Forward)$/),
        firstName: expect.any(String),
        secondName: expect.any(String),
        webName: expect.any(String),
        team: {
          id: expect.any(Number),
          name: expect.any(String),
          shortName: expect.any(String),
        },
      });
      expect(result).not.toHaveProperty('teamId');
    }, 60000);

    it('should get raw player by id', async () => {
      console.log('Getting players for raw ID test...');
      const startGetAll = Date.now();
      const players = await pipe(
        service.getPlayers(),
        TE.getOrElse((error) => {
          console.error('Failed to get players:', error);
          throw error;
        }),
      )();
      console.log(`Got all players in ${(Date.now() - startGetAll) / 1000}s`);
      expect(players.length).toBeGreaterThan(0);

      console.log('Getting raw player...');
      const startGetOne = Date.now();
      const result = await pipe(
        service.getPlayer(players[0].id),
        TE.getOrElse((error) => {
          console.error('Failed to get raw player:', error);
          throw error;
        }),
      )();
      console.log(`Got raw player in ${(Date.now() - startGetOne) / 1000}s`);

      expect(result).not.toBeNull();
      console.log('Sample raw player:', {
        id: result?.id,
        name: result?.webName,
        teamId: result?.teamId,
        elementType: result?.elementType,
      });

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
    }, 60000);

    it('should return null for non-existent player id', async () => {
      const result = await pipe(
        service.findPlayerById(999999 as PlayerId),
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

      console.log('Saving test players...');
      const result = await pipe(
        service.savePlayers(newPlayers),
        TE.getOrElse((error) => {
          console.error('Failed to save players:', error);
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

      // Verify we can get the enhanced version of the saved player
      console.log('Getting enhanced version of saved player...');
      const enhanced = await pipe(
        service.findPlayerById(result[0].id),
        TE.getOrElse((error) => {
          console.error('Failed to get enhanced version:', error);
          throw error;
        }),
      )();

      expect(enhanced).not.toBeNull();
      expect(enhanced).toMatchObject({
        id: result[0].id,
        elementType: expect.stringMatching(/^(Goalkeeper|Defender|Midfielder|Forward)$/),
        team: {
          id: expect.any(Number),
          name: expect.any(String),
          shortName: expect.any(String),
        },
      });
    }, 30000);
  });
});
