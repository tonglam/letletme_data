import type { FormalRunRequestV1 } from './formal-run-contract';

type HostState = {
  active: number;
  waiters: Array<() => void>;
};

export class HostConcurrencyLimiter {
  private readonly limit: number;
  private readonly states = new Map<string, HostState>();

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Host concurrency limit must be a positive safe integer');
    }
    this.limit = limit;
  }

  async withPermit<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const normalizedKey = key.trim().toLowerCase();
    if (!normalizedKey) throw new Error('Host concurrency key cannot be blank');
    await this.acquire(normalizedKey);
    try {
      return await operation();
    } finally {
      this.release(normalizedKey);
    }
  }

  private async acquire(key: string): Promise<void> {
    const state = this.states.get(key) ?? { active: 0, waiters: [] };
    this.states.set(key, state);
    if (state.active < this.limit) {
      state.active += 1;
      return;
    }
    await new Promise<void>((resolve) => state.waiters.push(resolve));
  }

  private release(key: string): void {
    const state = this.states.get(key);
    if (!state || state.active < 1) throw new Error('Host concurrency permit was not held');
    const next = state.waiters.shift();
    if (next) {
      next();
      return;
    }
    state.active -= 1;
    if (state.active === 0) this.states.delete(key);
  }
}

function origin(value: string): string {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Formal HTTP acquisition target must use HTTP(S)');
  }
  return parsed.origin.toLowerCase();
}

export function formalHttpHostKey(request: FormalRunRequestV1): string {
  if (request.jobKind === 'FEED_POLL') {
    if (request.adapterKind === 'YOUTUBE_CHANNEL') return 'https://www.youtube.com';
    const locatorUrl = request.endpoint.locator.url;
    if (!locatorUrl) throw new Error('Feed request has no locator URL');
    return origin(locatorUrl);
  }
  if (request.jobKind === 'ARTICLE_FETCH') {
    if (!request.discoveryItem.sourceUrl) throw new Error('Article request has no source URL');
    return origin(request.discoveryItem.sourceUrl);
  }
  if (request.jobKind === 'YOUTUBE_METADATA') return 'https://www.googleapis.com';
  if (request.jobKind === 'YOUTUBE_TRANSCRIPT') return 'https://api.supadata.ai';
  throw new Error(`Run kind ${request.jobKind} does not belong on the formal HTTP queue`);
}
