import { AsyncLocalStorage } from 'async_hooks';

export const FPL_ENDPOINT_LABELS = [
  'bootstrap',
  'fixtures',
  'event_live',
  'entry_summary',
  'entry_picks',
  'entry_history',
  'entry_transfers',
  'league_classic',
  'league_h2h',
  'entry_cup',
  'unknown',
] as const;

export const FPL_REQUEST_OUTCOMES = [
  '2xx',
  '4xx',
  '429',
  '5xx',
  'timeout',
  'network_error',
] as const;

export type FplEndpointLabel = (typeof FPL_ENDPOINT_LABELS)[number];
export type FplRequestOutcome = (typeof FPL_REQUEST_OUTCOMES)[number];

export type FplRequestMetricsSnapshot = {
  logicalRequests: number;
  attempts: number;
  retries: number;
  byEndpoint: Record<FplEndpointLabel, number>;
  attemptsByOutcome: Record<FplRequestOutcome, number>;
  finalOutcomes: Record<FplRequestOutcome, number>;
};

type MutableFplRequestMetrics = FplRequestMetricsSnapshot;

const requestMetricsStore = new AsyncLocalStorage<MutableFplRequestMetrics>();

function zeroRecord<T extends readonly string[]>(keys: T): Record<T[number], number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T[number], number>;
}

export function createEmptyFplRequestMetrics(): FplRequestMetricsSnapshot {
  return {
    logicalRequests: 0,
    attempts: 0,
    retries: 0,
    byEndpoint: zeroRecord(FPL_ENDPOINT_LABELS),
    attemptsByOutcome: zeroRecord(FPL_REQUEST_OUTCOMES),
    finalOutcomes: zeroRecord(FPL_REQUEST_OUTCOMES),
  };
}

function cloneMetrics(metrics: MutableFplRequestMetrics): FplRequestMetricsSnapshot {
  return {
    logicalRequests: metrics.logicalRequests,
    attempts: metrics.attempts,
    retries: metrics.retries,
    byEndpoint: { ...metrics.byEndpoint },
    attemptsByOutcome: { ...metrics.attemptsByOutcome },
    finalOutcomes: { ...metrics.finalOutcomes },
  };
}

export async function runWithFplRequestMetrics<T>(runner: () => Promise<T>): Promise<T> {
  if (requestMetricsStore.getStore()) {
    return runner();
  }

  const metrics = createEmptyFplRequestMetrics();
  return requestMetricsStore.run(metrics, runner);
}

export function getFplRequestMetricsSnapshot(): FplRequestMetricsSnapshot {
  const metrics = requestMetricsStore.getStore();
  return metrics ? cloneMetrics(metrics) : createEmptyFplRequestMetrics();
}

export function classifyFplEndpoint(url: string): FplEndpointLabel {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return 'unknown';
  }

  if (path.endsWith('/bootstrap-static/')) return 'bootstrap';
  if (path.endsWith('/fixtures/')) return 'fixtures';
  if (/\/event\/\d+\/live\/$/.test(path)) return 'event_live';
  if (/\/entry\/\d+\/event\/\d+\/picks\/$/.test(path)) return 'entry_picks';
  if (/\/entry\/\d+\/history\/$/.test(path)) return 'entry_history';
  if (/\/entry\/\d+\/transfers\/$/.test(path)) return 'entry_transfers';
  if (/\/entry\/\d+\/cup\/$/.test(path)) return 'entry_cup';
  if (/\/entry\/\d+\/$/.test(path)) return 'entry_summary';
  if (/\/leagues-classic\/\d+\/standings\/$/.test(path)) return 'league_classic';
  if (/\/leagues-h2h\/\d+\/standings\/$/.test(path)) return 'league_h2h';
  return 'unknown';
}

export function classifyFplResponseStatus(status: number): FplRequestOutcome {
  if (status === 429) return '429';
  if (status >= 200 && status <= 299) return '2xx';
  if (status >= 500 && status <= 599) return '5xx';
  return '4xx';
}

export function classifyFplRequestError(error: unknown): FplRequestOutcome {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'timeout';
  }
  return 'network_error';
}

export type FplLogicalRequestMetric = {
  recordAttempt: (outcome: FplRequestOutcome) => void;
  finish: () => void;
};

const NOOP_REQUEST_METRIC: FplLogicalRequestMetric = {
  recordAttempt: () => undefined,
  finish: () => undefined,
};

export function beginFplLogicalRequest(url: string): FplLogicalRequestMetric {
  const metrics = requestMetricsStore.getStore();
  if (!metrics) return NOOP_REQUEST_METRIC;

  const endpoint = classifyFplEndpoint(url);
  metrics.logicalRequests += 1;
  metrics.byEndpoint[endpoint] += 1;
  let attempts = 0;
  let finalOutcome: FplRequestOutcome | null = null;
  let finished = false;

  return {
    recordAttempt(outcome) {
      if (finished) return;
      attempts += 1;
      finalOutcome = outcome;
      metrics.attempts += 1;
      metrics.attemptsByOutcome[outcome] += 1;
    },
    finish() {
      if (finished) return;
      finished = true;
      metrics.retries += Math.max(0, attempts - 1);
      if (finalOutcome) metrics.finalOutcomes[finalOutcome] += 1;
    },
  };
}
