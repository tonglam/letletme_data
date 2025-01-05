import * as E from 'fp-ts/Either';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import { BootStrapResponse, BootStrapResponseSchema } from '../../src/types/bootstrap.type';
import { APIError } from '../../src/types/errors.type';

describe('FPL API Client', () => {
  const client = createFPLClient();

  describe('Bootstrap API', () => {
    const toTaskEither = (promise: Promise<E.Either<APIError, BootStrapResponse>>) =>
      TE.tryCatch(
        async () => {
          const result = await promise;
          if (E.isLeft(result)) {
            throw result.left;
          }
          return result.right;
        },
        (error) => error as APIError,
      );

    it('should successfully retrieve bootstrap data with proper structure', async () => {
      const result = await pipe(
        client.bootstrap.getBootstrapStatic(),
        toTaskEither,
        TE.fold(
          (error: APIError): T.Task<BootStrapResponse> =>
            () =>
              Promise.reject(error),
          (success: BootStrapResponse): T.Task<BootStrapResponse> =>
            () =>
              Promise.resolve(success),
        ),
      )();

      // Verify response structure
      expect(result).toBeDefined();
      expect(result).toHaveProperty('events');
      expect(result).toHaveProperty('phases');
      expect(result).toHaveProperty('teams');
      expect(result).toHaveProperty('elements');

      // Verify events array
      expect(Array.isArray(result.events)).toBe(true);
      expect(result.events.length).toBeGreaterThan(0);

      // Verify event structure
      const firstEvent = result.events[0];
      expect(firstEvent).toHaveProperty('id');
      expect(firstEvent).toHaveProperty('name');
      expect(firstEvent).toHaveProperty('deadline_time');
      expect(firstEvent).toHaveProperty('chip_plays');
      expect(Array.isArray(firstEvent.chip_plays)).toBe(true);

      // Verify schema validation
      const validationResult = BootStrapResponseSchema.safeParse(result);
      expect(validationResult.success).toBe(true);
    });

    it('should handle timeout scenarios', async () => {
      const shortTimeoutClient = createFPLClient({
        timeout: 1, // 1ms timeout to force timeout error
      });

      await expect(
        pipe(
          shortTimeoutClient.bootstrap.getBootstrapStatic(),
          toTaskEither,
          TE.fold(
            (error: APIError): T.Task<BootStrapResponse> =>
              () =>
                Promise.reject(error),
            (success: BootStrapResponse): T.Task<BootStrapResponse> =>
              () =>
                Promise.resolve(success),
          ),
        )(),
      ).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: expect.stringContaining('timeout'),
      });
    });

    it('should handle retry behavior with slow responses', async () => {
      const retryClient = createFPLClient({
        retry: {
          retries: 2,
          minTimeout: 100,
          maxTimeout: 200,
        },
      });

      const result = await pipe(
        retryClient.bootstrap.getBootstrapStatic(),
        toTaskEither,
        TE.fold(
          (error: APIError): T.Task<BootStrapResponse> =>
            () =>
              Promise.reject(error),
          (success: BootStrapResponse): T.Task<BootStrapResponse> =>
            () =>
              Promise.resolve(success),
        ),
      )();

      expect(result).toBeDefined();
      expect(result).toHaveProperty('events');
    });

    it('should handle custom headers', async () => {
      const result = await pipe(
        client.bootstrap.getBootstrapStatic({
          headers: {
            'User-Agent': 'FPL-Test-Suite',
            'Accept-Language': 'en-US',
          },
        }),
        toTaskEither,
        TE.fold(
          (error: APIError): T.Task<BootStrapResponse> =>
            () =>
              Promise.reject(error),
          (success: BootStrapResponse): T.Task<BootStrapResponse> =>
            () =>
              Promise.resolve(success),
        ),
      )();

      expect(result).toBeDefined();
      expect(result).toHaveProperty('events');
    });

    // Note: Rate limiting test is commented out to avoid actual rate limits during normal test runs
    // Uncomment and run separately when testing rate limit handling
    /*
    it('should handle rate limiting', async () => {
      // Make multiple rapid requests to trigger rate limiting
      const requests = Array(10).fill(null).map(() =>
        pipe(
          client.bootstrap.getBootstrapStatic(),
          toTaskEither,
          TE.fold(
            (error: APIError): T.Task<BootStrapResponse> =>
              () =>
                Promise.reject(error),
            (success: BootStrapResponse): T.Task<BootStrapResponse> =>
              () =>
                Promise.resolve(success),
          ),
        )()
      );

      await expect(Promise.all(requests)).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: expect.stringContaining('rate limit'),
      });
    });
    */
  });
});
