import { fplClient } from '../../../src/clients/fpl';

type FPLClientMethod = keyof typeof fplClient;

const originals: Partial<Record<FPLClientMethod, (...args: unknown[]) => unknown>> = {};

function captureOriginal(method: FPLClientMethod) {
  const original = (fplClient[method] as (...args: unknown[]) => unknown).bind(fplClient);
  originals[method] = original;
  return original;
}

/**
 * Replace FPL client methods with deterministic fixture responses.
 *
 * Use this in integration tests that need FPL-shaped payloads but should not
 * call the real fantasy.premierleague.com API. Call `resetMockFPLClient()` in
 * `afterEach`/`afterAll` to restore the original implementations.
 */
export function mockFPLClient(
  responses: Partial<Record<FPLClientMethod, (...args: unknown[]) => unknown>>,
) {
  for (const method of Object.keys(responses) as FPLClientMethod[]) {
    if (!(method in originals)) {
      captureOriginal(method);
    }
    (fplClient as Record<FPLClientMethod, (...args: unknown[]) => unknown>)[method] =
      responses[method]!;
  }
}

/** Restore the original FPL client implementations. */
export function resetMockFPLClient() {
  for (const method of Object.keys(originals) as FPLClientMethod[]) {
    const original = originals[method];
    if (original) {
      (fplClient as Record<FPLClientMethod, (...args: unknown[]) => unknown>)[method] = original;
      delete originals[method];
    }
  }
}
