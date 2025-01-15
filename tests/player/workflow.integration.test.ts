import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import { createPlayerCommandOperations } from '../../src/domain/player/command/operation';
import { createPlayerCommandRepository } from '../../src/domain/player/command/repository';
import { createPlayerQueryOperations } from '../../src/domain/player/query/operation';
import { createPlayerQueryRepository } from '../../src/domain/player/query/repository';
import { createTeamRepository } from '../../src/domain/team/repository';
import { prisma } from '../../src/infrastructure/db/prisma';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import { createPlayerService } from '../../src/service/player/service';
import { createTeamService } from '../../src/service/team/service';
import { APIErrorCode } from '../../src/types/error.type';
import { PlayerEventBus } from '../../src/types/player/event.type';

describe('Player Workflow Integration Test', () => {
  const fplClient = createFPLClient();
  const bootstrapApi = createBootstrapApiAdapter(fplClient);
  const eventBus: PlayerEventBus = {
    publish: () => TE.right(undefined),
    subscribe: () => undefined,
  };

  const teamRepository = createTeamRepository(prisma);
  const teamService = createTeamService(bootstrapApi, teamRepository);

  const queryRepository = createPlayerQueryRepository(prisma, teamService);
  const commandRepository = createPlayerCommandRepository(prisma, eventBus);

  const queryOps = createPlayerQueryOperations(queryRepository, teamRepository);
  const commandOps = createPlayerCommandOperations(commandRepository);
  const playerService = createPlayerService(bootstrapApi, queryOps, commandOps);

  beforeAll(async () => {
    await prisma.player.deleteMany();
    await prisma.team.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('should sync players from API', async () => {
    const result = await pipe(
      playerService.workflows.syncPlayers(),
      TE.getOrElse((error) => {
        throw error;
      }),
    )();

    expect(result.result).toBeDefined();
    expect(Array.isArray(result.result)).toBe(true);
    expect(result.result.length).toBeGreaterThan(0);
    expect(result.result[0]).toHaveProperty('id');
    expect(result.result[0]).toHaveProperty('webName');
    expect(result.result[0]).toHaveProperty('teamId');
    expect(result.duration).toBeGreaterThan(0);
  });

  it('should handle API errors gracefully', async () => {
    const invalidBootstrapApi = {
      ...bootstrapApi,
      getBootstrapElements: () =>
        TE.left({
          name: 'APIError',
          code: APIErrorCode.SERVICE_ERROR,
          message: 'API Error',
          timestamp: new Date(),
        }),
    };
    const invalidService = createPlayerService(invalidBootstrapApi, queryOps, commandOps);

    const result = await invalidService.workflows.syncPlayers()();

    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left.code).toBe('INTEGRATION_ERROR');
      expect(result.left.message).toBe('Failed to fetch players from API');
    }
  });
});
