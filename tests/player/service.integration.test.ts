import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import { createPlayerCommandOperations } from '../../src/domain/player/command/operation';
import { createPlayerQueryOperations } from '../../src/domain/player/query/operation';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructure/http/client/utils';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import { createPlayerService } from '../../src/service/player';
import { ElementResponse } from '../../src/types/element.type';
import {
  APIErrorCode,
  DBErrorCode,
  createAPIError,
  createDBError,
} from '../../src/types/error.type';
import { Player, PlayerId, toDomainPlayer } from '../../src/types/player.type';
import { PlayerRepository } from '../../src/types/player/repository.type';
import { TeamId, TeamResponse, toDomainTeam } from '../../src/types/team.type';
import { TeamRepository } from '../../src/types/team/repository.type';

describe('Player Service Integration Tests', () => {
  const fplClient = createFPLClient({
    retryConfig: {
      ...DEFAULT_RETRY_CONFIG,
      attempts: 3,
    },
  });
  const bootstrapApi = createBootstrapApiAdapter(fplClient);

  const playerRepository: PlayerRepository = {
    findById: (id: PlayerId) =>
      pipe(
        TE.tryCatch(
          () => fplClient.bootstrap.getBootstrapStatic(),
          (error) =>
            createDBError({
              code: DBErrorCode.QUERY_ERROR,
              message: `Failed to fetch player: ${error}`,
            }),
        ),
        TE.chain((result) =>
          result._tag === 'Right'
            ? TE.right(result.right.elements.find((p: ElementResponse) => p.id === Number(id)))
            : TE.left(
                createDBError({
                  code: DBErrorCode.QUERY_ERROR,
                  message: `Failed to fetch player: ${result.left.message}`,
                }),
              ),
        ),
        TE.map((p) => (p ? toDomainPlayer(p) : null)),
      ),
    findAll: () =>
      pipe(
        TE.tryCatch(
          () => fplClient.bootstrap.getBootstrapStatic(),
          (error) =>
            createDBError({
              code: DBErrorCode.QUERY_ERROR,
              message: `Failed to fetch players: ${error}`,
            }),
        ),
        TE.chain((result) =>
          result._tag === 'Right'
            ? TE.right(result.right.elements)
            : TE.left(
                createDBError({
                  code: DBErrorCode.QUERY_ERROR,
                  message: `Failed to fetch players: ${result.left.message}`,
                }),
              ),
        ),
        TE.map((players) => players.map((p: ElementResponse) => toDomainPlayer(p))),
      ),
    findByTeamId: (teamId: TeamId) =>
      pipe(
        TE.tryCatch(
          () => fplClient.bootstrap.getBootstrapStatic(),
          (error) =>
            createDBError({
              code: DBErrorCode.QUERY_ERROR,
              message: `Failed to fetch players by team: ${error}`,
            }),
        ),
        TE.chain((result) =>
          result._tag === 'Right'
            ? TE.right(
                result.right.elements.filter((p: ElementResponse) => p.team === Number(teamId)),
              )
            : TE.left(
                createDBError({
                  code: DBErrorCode.QUERY_ERROR,
                  message: `Failed to fetch players by team: ${result.left.message}`,
                }),
              ),
        ),
        TE.map((players) => players.map(toDomainPlayer)),
      ),
    saveBatch: (players: readonly Player[]) => TE.right([...players] as Player[]),
    deleteAll: () => TE.right(undefined),
  };

  const teamRepository: TeamRepository = {
    findById: (id: TeamId) =>
      pipe(
        TE.tryCatch(
          () => fplClient.bootstrap.getBootstrapStatic(),
          (error) =>
            createDBError({
              code: DBErrorCode.QUERY_ERROR,
              message: `Failed to fetch team: ${error}`,
            }),
        ),
        TE.chain((result) =>
          result._tag === 'Right'
            ? TE.right(result.right.teams.find((t: TeamResponse) => t.id === Number(id)))
            : TE.left(
                createDBError({
                  code: DBErrorCode.QUERY_ERROR,
                  message: `Failed to fetch team: ${result.left.message}`,
                }),
              ),
        ),
        TE.map((t) => (t ? toDomainTeam(t) : null)),
      ),
    findAll: () =>
      pipe(
        TE.tryCatch(
          () => fplClient.bootstrap.getBootstrapStatic(),
          (error) =>
            createDBError({
              code: DBErrorCode.QUERY_ERROR,
              message: `Failed to fetch teams: ${error}`,
            }),
        ),
        TE.chain((result) =>
          result._tag === 'Right'
            ? TE.right(result.right.teams)
            : TE.left(
                createDBError({
                  code: DBErrorCode.QUERY_ERROR,
                  message: `Failed to fetch teams: ${result.left.message}`,
                }),
              ),
        ),
        TE.map((teams) => teams.map((t: TeamResponse) => toDomainTeam(t))),
      ),
  };

  const queryOperations = createPlayerQueryOperations(playerRepository, teamRepository);
  const commandOperations = createPlayerCommandOperations(playerRepository);
  const service = createPlayerService(bootstrapApi, queryOperations, commandOperations);

  describe('getPlayers', () => {
    it('should return all players with team details', async () => {
      const result = await service.getPlayers()();
      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(Array.isArray(result.right)).toBe(true);
        expect(result.right.length).toBeGreaterThan(0);
        // Verify player structure
        const player = result.right[0];
        expect(player).toHaveProperty('id');
        expect(player).toHaveProperty('elementCode');
        expect(player).toHaveProperty('price');
        expect(player).toHaveProperty('startPrice');
        expect(player).toHaveProperty('elementType');
        expect(player).toHaveProperty('firstName');
        expect(player).toHaveProperty('secondName');
        expect(player).toHaveProperty('webName');
        expect(player).toHaveProperty('team');
      }
    });
  });

  describe('getPlayer', () => {
    it('should return a player with team details when found', async () => {
      const result = await service.getPlayer(1 as PlayerId)();
      expect(result._tag).toBe('Right');
      if (result._tag === 'Right' && result.right) {
        expect(result.right).toHaveProperty('id', 1);
        expect(result.right).toHaveProperty('elementCode');
        expect(result.right).toHaveProperty('price');
        expect(result.right).toHaveProperty('startPrice');
        expect(result.right).toHaveProperty('elementType');
        expect(result.right).toHaveProperty('firstName');
        expect(result.right).toHaveProperty('secondName');
        expect(result.right).toHaveProperty('webName');
        expect(result.right).toHaveProperty('teamId');
      }
    });

    it('should return null when player is not found', async () => {
      const result = await service.getPlayer(99999 as PlayerId)();
      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right).toBeNull();
      }
    });
  });

  describe('findPlayerById', () => {
    it('should return a player with team details when found', async () => {
      const result = await service.findPlayerById(1 as PlayerId)();
      expect(result._tag).toBe('Right');
      if (result._tag === 'Right' && result.right) {
        expect(result.right).toHaveProperty('id');
        expect(result.right).toHaveProperty('elementCode');
        expect(result.right).toHaveProperty('price');
        expect(result.right).toHaveProperty('startPrice');
        expect(result.right).toHaveProperty('elementType');
        expect(result.right).toHaveProperty('firstName');
        expect(result.right).toHaveProperty('secondName');
        expect(result.right).toHaveProperty('webName');
        expect(result.right).toHaveProperty('team');
        expect(result.right.team).toHaveProperty('id');
        expect(result.right.team).toHaveProperty('name');
        expect(result.right.team).toHaveProperty('shortName');
      }
    });

    it('should return null when player is not found', async () => {
      const result = await service.findPlayerById(99999 as PlayerId)();
      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right).toBeNull();
      }
    });
  });

  describe('savePlayers', () => {
    it('should save players successfully', async () => {
      // First get some players to save
      const getResult = await service.getPlayer(1 as PlayerId)();
      expect(getResult._tag).toBe('Right');
      if (getResult._tag === 'Right' && getResult.right) {
        const players = [getResult.right];
        const saveResult = await service.savePlayers(players)();
        expect(saveResult._tag).toBe('Right');
        if (saveResult._tag === 'Right') {
          expect(saveResult.right).toHaveLength(1);
          expect(saveResult.right[0]).toEqual(players[0]);
        }
      }
    });
  });

  describe('syncPlayersFromApi', () => {
    it('should sync players from bootstrap API successfully', async () => {
      const result = await service.syncPlayersFromApi()();
      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(Array.isArray(result.right)).toBe(true);
        expect(result.right.length).toBeGreaterThan(0);
        // Verify synced player structure
        const player = result.right[0];
        expect(player).toHaveProperty('id');
        expect(player).toHaveProperty('elementCode');
        expect(player).toHaveProperty('price');
        expect(player).toHaveProperty('startPrice');
        expect(player).toHaveProperty('elementType');
        expect(player).toHaveProperty('firstName');
        expect(player).toHaveProperty('secondName');
        expect(player).toHaveProperty('webName');
        expect(player).toHaveProperty('teamId');
      }
    });

    it('should handle API errors gracefully', async () => {
      // Create a service with a failing bootstrap API
      const failingBootstrapApi = {
        ...bootstrapApi,
        getBootstrapElements: () =>
          TE.left(
            createAPIError({
              code: APIErrorCode.INTERNAL_SERVER_ERROR,
              message: 'API Error',
            }),
          ),
      };
      const failingService = createPlayerService(
        failingBootstrapApi,
        queryOperations,
        commandOperations,
      );

      const result = await failingService.syncPlayersFromApi()();
      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') {
        expect(result.left.message).toBe('Service integration failed');
      }
    });
  });
});
