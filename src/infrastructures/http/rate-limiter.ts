import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { ERROR_CONFIG, ErrorCode, HTTP_STATUS } from '../../configs/http/http.config';
import { createErrorFromStatus } from './utils';

export interface RateLimiterConfig {
  readonly tokensPerInterval: number;
  readonly interval: number;
  readonly capacity: number;
}

export interface RateLimiterState {
  readonly tokens: number;
  readonly lastRefill: number;
  readonly config: RateLimiterConfig;
}

export const createRateLimiterState = (config: RateLimiterConfig): RateLimiterState => ({
  tokens: config.capacity,
  lastRefill: Date.now(),
  config,
});

export const refillTokens = (state: RateLimiterState): RateLimiterState => {
  const now = Date.now();
  const timeSinceLastRefill = now - state.lastRefill;

  if (timeSinceLastRefill < state.config.interval) {
    return state;
  }

  const intervals = Math.floor(timeSinceLastRefill / state.config.interval);
  const tokensToAdd = intervals * state.config.tokensPerInterval;
  const tokens = Math.min(state.config.capacity, state.tokens + tokensToAdd);
  const lastRefill = now - (timeSinceLastRefill % state.config.interval);

  return { ...state, tokens, lastRefill };
};

export const tryConsume =
  (tokens = 1) =>
  (state: RateLimiterState): E.Either<RateLimiterState, RateLimiterState> => {
    const refreshedState = refillTokens(state);

    if (refreshedState.tokens < tokens) {
      return E.left(refreshedState);
    }

    return E.right({
      ...refreshedState,
      tokens: refreshedState.tokens - tokens,
    });
  };

export const getNextRefillTime = (state: RateLimiterState): number => {
  const now = Date.now();
  const timeSinceLastRefill = now - state.lastRefill;
  return Math.max(0, state.config.interval - timeSinceLastRefill);
};

export const getAvailableTokens = (state: RateLimiterState): number => refillTokens(state).tokens;

export const consume =
  (tokens = 1) =>
  (state: RateLimiterState): E.Either<Error, RateLimiterState> =>
    pipe(
      tryConsume(tokens)(state),
      E.mapLeft((failedState) => {
        return createErrorFromStatus(
          HTTP_STATUS.TOO_MANY_REQUESTS,
          ERROR_CONFIG[ErrorCode.RATE_LIMIT_EXCEEDED].message,
          {
            remainingTokens: failedState.tokens,
            requestedTokens: tokens,
            nextRefillIn: getNextRefillTime(failedState),
          },
        );
      }),
    );

export const createRateLimiter = (config?: Partial<RateLimiterConfig>): RateLimiterState => {
  const defaultConfig: RateLimiterConfig = {
    tokensPerInterval: 10,
    interval: 1000,
    capacity: 10,
  };

  return createRateLimiterState({ ...defaultConfig, ...config });
};

export function withRateLimit<Args extends unknown[], Return>(
  fn: (...args: Args) => Promise<Return>,
  initialState: RateLimiterState,
): [(...args: Args) => TE.TaskEither<Error, Return>, () => RateLimiterState] {
  let state = initialState;

  return [
    (...args: Args): TE.TaskEither<Error, Return> =>
      pipe(
        TE.fromEither(consume()(state)),
        TE.map((newState) => {
          state = newState;
          return newState;
        }),
        TE.chain(() =>
          TE.tryCatch(
            () => fn(...args),
            (error): Error => (error instanceof Error ? error : new Error(String(error))),
          ),
        ),
      ),
    () => state,
  ];
}
