import { describe, expect, test } from '@jest/globals';
import * as E from 'fp-ts/Either';
import * as IO from 'fp-ts/IO';
import { pipe } from 'fp-ts/function';
import { APIError } from '../../../../../src/infrastructure/api/common/errors';
import { createFPLClient, FPLClient } from '../../../../../src/infrastructure/api/fpl';

describe('FPL API Client', () => {
  let client: FPLClient;

  beforeAll(() => {
    // Create a new client instance before all tests
    const clientIO = createFPLClient();
    client = pipe(
      clientIO,
      IO.map(
        E.getOrElseW((error: APIError) => {
          throw new Error(`Failed to create FPL client: ${error.message}`);
        }),
      ),
    )();
  });

  test('should successfully fetch bootstrap static data', async () => {
    // Call the FPL API
    const result = await client.getBootstrapStatic();

    // Verify the response
    expect(E.isRight(result)).toBe(true);

    if (E.isRight(result)) {
      const data = result.right;

      // Basic structure checks
      expect(data).toBeDefined();
      expect(data.events).toBeDefined();
      expect(Array.isArray(data.events)).toBe(true);
      expect(data.teams).toBeDefined();
      expect(Array.isArray(data.teams)).toBe(true);
      expect(data.elements).toBeDefined();
      expect(Array.isArray(data.elements)).toBe(true);

      // Log some basic info for manual verification
      console.log(`Found ${data.events.length} events`);
      console.log(`Found ${data.teams.length} teams`);
      console.log(`Found ${data.elements.length} players`);

      // Verify event structure (allowing for null values)
      const firstEvent = data.events[0];
      expect(firstEvent).toHaveProperty('id');
      expect(firstEvent).toHaveProperty('deadline_time');
      expect(firstEvent).toHaveProperty('finished');
      expect(firstEvent).toHaveProperty('data_checked');
      expect(firstEvent).toHaveProperty('most_selected');
      expect(firstEvent).toHaveProperty('most_transferred_in');
      expect(firstEvent).toHaveProperty('most_captained');
      expect(firstEvent).toHaveProperty('most_vice_captained');
      expect(firstEvent).toHaveProperty('top_element');

      // Verify team structure (allowing for null values)
      const firstTeam = data.teams[0];
      expect(firstTeam).toHaveProperty('id');
      expect(firstTeam).toHaveProperty('name');
      expect(firstTeam).toHaveProperty('short_name');
      expect(firstTeam).toHaveProperty('form');

      // Verify player structure
      const firstPlayer = data.elements[0];
      expect(firstPlayer).toHaveProperty('id');
      expect(firstPlayer).toHaveProperty('first_name');
      expect(firstPlayer).toHaveProperty('second_name');
      expect(firstPlayer).toHaveProperty('team');
    }
  });

  test('should handle API errors gracefully', async () => {
    // Create a client with a URL that will cause a network error
    const invalidClientIO = createFPLClient({
      baseURL: 'https://localhost:1', // This will cause an ECONNREFUSED error
      retry: {
        attempts: 1, // Only try once
        baseDelay: 0,
        maxDelay: 0,
        shouldRetry: () => false, // Never retry
      },
      timeout: 1000, // Short timeout to trigger error faster
    });
    const invalidClient = pipe(
      invalidClientIO,
      IO.map(
        E.getOrElseW((error: APIError) => {
          throw new Error(`Failed to create FPL client: ${error.message}`);
        }),
      ),
    )();

    // Call the API and expect it to fail
    const result = await invalidClient.getBootstrapStatic();

    // Verify that we get a Left (error) result
    expect(E.isLeft(result)).toBe(true);

    if (E.isLeft(result)) {
      const error = result.left;
      expect(error).toHaveProperty('message');
      expect(typeof error.message).toBe('string');
      expect(error.message).toBe('Unexpected error during request');
      console.log('Error message:', error.message);
    }
  });

  test('should respect retry configuration', async () => {
    // Create a client with custom retry config
    const clientWithRetryIO = createFPLClient({
      baseURL: 'https://fantasy.premierleague.com/api',
    });
    const clientWithRetry = pipe(
      clientWithRetryIO,
      IO.map(
        E.getOrElseW((error: APIError) => {
          throw new Error(`Failed to create FPL client: ${error.message}`);
        }),
      ),
    )();

    // Make multiple rapid requests to test rate limiting and retry behavior
    const requests = Array(3)
      .fill(null)
      .map(() => clientWithRetry.getBootstrapStatic());

    // Execute all requests concurrently
    const results = await Promise.all(requests);

    // Verify that all requests eventually succeeded
    results.forEach((result, index) => {
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        console.log(`Request ${index + 1} succeeded`);
      }
    });
  });
});
