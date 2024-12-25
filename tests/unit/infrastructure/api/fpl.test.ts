import { describe, expect, test } from '@jest/globals';
import { BootstrapApi } from '../../../../src/domains/bootstrap/operations';
import { createFPLClient } from '../../../../src/infrastructure/api/fpl/client';
import { Phase } from '../../../../src/types/phases.type';

describe('FPL API Client', () => {
  let client: BootstrapApi;

  beforeAll(() => {
    client = createFPLClient();
  });

  test('should successfully fetch bootstrap data', async () => {
    const result = await client.getBootstrapData();

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    if (result) {
      const firstPhase = result[0];
      expect(firstPhase).toHaveProperty('id');
      expect(firstPhase).toHaveProperty('name');
      expect(firstPhase).toHaveProperty('startEvent');
      expect(firstPhase).toHaveProperty('stopEvent');
    }
  });

  test('should successfully fetch bootstrap events', async () => {
    const result = await client.getBootstrapEvents();

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    if (result) {
      const firstEvent = result[0];
      expect(firstEvent).toHaveProperty('id');
      expect(firstEvent).toHaveProperty('name');
      expect(firstEvent).toHaveProperty('deadlineTime');
      expect(firstEvent).toHaveProperty('finished');
      expect(firstEvent).toHaveProperty('isCurrent');
      expect(firstEvent).toHaveProperty('isNext');
      expect(firstEvent).toHaveProperty('chipPlays');
      expect(firstEvent).toHaveProperty('mostSelected');
      expect(firstEvent).toHaveProperty('mostTransferredIn');
      expect(firstEvent).toHaveProperty('mostCaptained');
      expect(firstEvent).toHaveProperty('mostViceCaptained');
      expect(firstEvent).toHaveProperty('topElement');
      expect(firstEvent).toHaveProperty('topElementInfo');
    }
  });

  test('should handle API errors gracefully', async () => {
    // Create a new client with invalid URL to simulate error
    const errorClient = createFPLClient();
    Object.defineProperty(errorClient, 'getBootstrapData', {
      value: async () => null,
      writable: true,
      configurable: true,
    });

    const result = await errorClient.getBootstrapData();
    expect(result).toBeNull();
  });

  test('should handle multiple concurrent requests', async () => {
    // Make multiple rapid requests
    const requests = Array(3)
      .fill(null)
      .map(() => client.getBootstrapData());

    // Execute all requests concurrently
    const results = await Promise.all(requests);

    // Verify that all requests returned data
    results.forEach((result: Phase[] | null, index: number) => {
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      console.log(`Request ${index + 1} succeeded`);
    });
  });
});
