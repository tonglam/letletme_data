import { beforeAll, describe, expect, it } from 'bun:test';
import { createFplLiveDataService } from 'data/fpl/live.data';
import { type FplLiveDataService } from 'data/types';
import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import { redisClient } from 'infrastructure/cache/client';
import { type Logger } from 'pino';
import { createEventLiveExplainRepository } from 'repository/event-live-explain/repository';
import { type EventLiveExplainRepository } from 'repository/event-live-explain/types';
import { createEventLiveExplainService } from 'service/event-live-explain/service';
import { type EventLiveExplainService } from 'service/event-live-explain/types';
import { type EventId } from 'types/domain/event.type';
import { type PlayerId } from 'types/domain/player.type';
import { DomainErrorCode } from 'types/error.type';

import {
  type IntegrationTestSetupResult,
  setupIntegrationTest,
} from '../setup/integrationTestSetup';

describe('Event Live Explain Service Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let logger: Logger;
  let fplLiveDataService: FplLiveDataService;
  let eventLiveExplainService: EventLiveExplainService;
  let eventLiveExplainRepository: EventLiveExplainRepository;

  const testEventId = 1 as EventId;
  const testPlayerIdWithExplain = 495 as PlayerId;

  beforeAll(async () => {
    setup = await setupIntegrationTest();
    logger = setup.logger;

    try {
      await redisClient.ping();
    } catch (error) {
      logger.error({ err: error }, 'Shared redisClient ping failed in beforeAll.');
    }

    // Repositories
    eventLiveExplainRepository = createEventLiveExplainRepository();

    // Data Services
    fplLiveDataService = createFplLiveDataService();

    // Services
    eventLiveExplainService = createEventLiveExplainService(
      fplLiveDataService,
      eventLiveExplainRepository,
    );
  });

  it('should sync event live explains from API and save/retrieve from repository', async () => {
    const syncResult = await eventLiveExplainService.syncEventLiveExplainsFromApi(testEventId)();

    expect(E.isRight(syncResult)).toBe(true);

    const findResult = await eventLiveExplainRepository.findByElementIdAndEventId(
      testPlayerIdWithExplain,
      testEventId,
    )();

    expect(E.isRight(findResult)).toBe(true);
    if (E.isRight(findResult)) {
      expect(O.isSome(findResult.right)).toBe(true);
      if (O.isSome(findResult.right)) {
        const explainData = findResult.right.value;
        expect(explainData).toBeDefined();
        expect(explainData.eventId).toBe(testEventId);
        expect(explainData.elementId).toBe(testPlayerIdWithExplain);
        expect(explainData).toHaveProperty('minutes');
      }
    }
  });

  it('should return NotFound error for non-existent player ID', async () => {
    const nonExistentPlayerId = 9999 as PlayerId;
    const explainResult = await eventLiveExplainService.getEventLiveExplainByElementId(
      testEventId,
      nonExistentPlayerId,
    )();

    expect(E.isLeft(explainResult)).toBe(true);
    if (E.isLeft(explainResult)) {
      expect(explainResult.left.cause).toBeDefined();
      expect(explainResult.left.cause?.name).toBe('DomainError');
      if (explainResult.left.cause && 'code' in explainResult.left.cause) {
        expect(explainResult.left.cause.code).toBe(DomainErrorCode.NOT_FOUND);
      }
      expect(explainResult.left.message).toContain('not found');
    }
  });
});
