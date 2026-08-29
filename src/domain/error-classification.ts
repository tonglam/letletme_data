import { FPLClientError, IncompleteDataSyncError, ValidationError } from '../utils/errors';

export type DataErrorClass =
  | 'SOURCE_NOT_READY'
  | 'TRANSIENT_PROVIDER'
  | 'TRANSIENT_INFRA'
  | 'DATA_INCOMPLETE'
  | 'CONTRACT_DRIFT'
  | 'CONFIG_AUTH'
  | 'STALE_GENERATION'
  | 'SOURCE_ARCHIVE_MISSING'
  | 'CONSUMER_STALE';

const DATA_ERROR_CLASSES = new Set<DataErrorClass>([
  'SOURCE_NOT_READY',
  'TRANSIENT_PROVIDER',
  'TRANSIENT_INFRA',
  'DATA_INCOMPLETE',
  'CONTRACT_DRIFT',
  'CONFIG_AUTH',
  'STALE_GENERATION',
  'SOURCE_ARCHIVE_MISSING',
  'CONSUMER_STALE',
]);

const PERSISTED_ERROR_PREFIX = /^([A-Z][A-Z0-9_]{1,79}):([A-Z][A-Z0-9_.-]{0,79})(?:\s|$)/;

export type PersistedDataError = Readonly<{
  errorClass: DataErrorClass;
  errorCode: string;
  prefixLength: number;
}>;

/**
 * Parse the bounded `CLASS:CODE` prefix written to durable scheduler and hot
 * reconciliation evidence. The remainder is deliberately ignored: it is
 * diagnostic text and must never be returned by an operational status API.
 */
export function parsePersistedDataError(
  value: string | null | undefined,
): PersistedDataError | null {
  if (!value) return null;
  const match = PERSISTED_ERROR_PREFIX.exec(value);
  if (!match || !DATA_ERROR_CLASSES.has(match[1] as DataErrorClass)) return null;
  return {
    errorClass: match[1] as DataErrorClass,
    errorCode: match[2].slice(0, 80),
    prefixLength: match[0].length,
  };
}

export type RetryPolicy = Readonly<{
  errorClass: DataErrorClass;
  retryable: boolean;
  maxAttempts: number;
  createGovernanceCase: boolean;
  preserveActiveRevision: boolean;
}>;

export function classifyDataError(error: unknown): DataErrorClass {
  const code =
    error instanceof IncompleteDataSyncError && error.detailCode
      ? error.detailCode
      : error instanceof Error && 'code' in error
        ? String(error.code)
        : '';
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (code === 'STALE_GENERATION' || message.includes('stale scheduler')) return 'STALE_GENERATION';
  if (code === 'SOURCE_ARCHIVE_MISSING' || message.includes('archive'))
    return 'SOURCE_ARCHIVE_MISSING';
  if (
    code.includes('DRIFT') ||
    code.includes('CHANGED') ||
    message.includes('schedule changed') ||
    message.includes('schema changed')
  ) {
    return 'CONTRACT_DRIFT';
  }
  if (
    error instanceof IncompleteDataSyncError ||
    code === 'DATA_SYNC_INCOMPLETE' ||
    message.includes('incomplete')
  )
    return 'DATA_INCOMPLETE';
  if (error instanceof ValidationError) return 'CONTRACT_DRIFT';
  if (code === 'FPL_ADMISSION_STORE_UNAVAILABLE') return 'TRANSIENT_INFRA';
  if (error instanceof FPLClientError) {
    if (error.status === 401 || error.status === 403) return 'CONFIG_AUTH';
    if (error.status === 404 || error.status === 409) return 'SOURCE_NOT_READY';
    if (error.status === 429 || (error.status !== undefined && error.status >= 500))
      return 'TRANSIENT_PROVIDER';
  }
  if (code === 'QUEUE_DRAIN_ONLY' || code === 'CONSUMER_STALE') return 'CONSUMER_STALE';
  if (message.includes('timeout') || message.includes('redis') || message.includes('postgres'))
    return 'TRANSIENT_INFRA';
  return 'TRANSIENT_INFRA';
}

export function retryPolicyForError(errorClass: DataErrorClass): RetryPolicy {
  switch (errorClass) {
    case 'SOURCE_NOT_READY':
    case 'TRANSIENT_PROVIDER':
      return {
        errorClass,
        retryable: true,
        maxAttempts: 3,
        createGovernanceCase: false,
        preserveActiveRevision: true,
      };
    case 'TRANSIENT_INFRA':
      return {
        errorClass,
        retryable: true,
        maxAttempts: 3,
        createGovernanceCase: true,
        preserveActiveRevision: true,
      };
    case 'DATA_INCOMPLETE':
      return {
        errorClass,
        retryable: false,
        maxAttempts: 1,
        createGovernanceCase: true,
        preserveActiveRevision: true,
      };
    case 'CONTRACT_DRIFT':
      return {
        errorClass,
        retryable: false,
        maxAttempts: 1,
        createGovernanceCase: true,
        preserveActiveRevision: true,
      };
    case 'CONFIG_AUTH':
      return {
        errorClass,
        retryable: false,
        maxAttempts: 1,
        createGovernanceCase: true,
        preserveActiveRevision: true,
      };
    case 'STALE_GENERATION':
      return {
        errorClass,
        retryable: false,
        maxAttempts: 1,
        createGovernanceCase: false,
        preserveActiveRevision: true,
      };
    case 'SOURCE_ARCHIVE_MISSING':
      return {
        errorClass,
        retryable: false,
        maxAttempts: 1,
        createGovernanceCase: true,
        preserveActiveRevision: true,
      };
    case 'CONSUMER_STALE':
      return {
        errorClass,
        retryable: true,
        maxAttempts: 2,
        createGovernanceCase: true,
        preserveActiveRevision: true,
      };
  }
}

export function safeDataErrorCode(error: unknown, errorClass = classifyDataError(error)): string {
  const candidate =
    error instanceof IncompleteDataSyncError && error.detailCode
      ? error.detailCode
      : error instanceof Error && 'code' in error
        ? String(error.code)
        : errorClass;
  const normalized = candidate.toUpperCase().replace(/[^A-Z0-9_.-]/g, '_');
  return normalized.slice(0, 80) || errorClass;
}

/**
 * Return a stable, bounded token for an already-persisted error. Preserve the
 * original classification/code prefix when it exists; older rows without the
 * prefix fall back to the generic classifier without exposing their message.
 */
export function safePersistedDataErrorCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = parsePersistedDataError(value);
  if (parsed) return `${parsed.errorClass}:${parsed.errorCode}`;
  return safeDataErrorCode(new Error(value));
}

/** Keep durable control-plane error text useful without persisting secrets or
 * identifiers that are only appropriate for local structured logs. */
export function summarizeDataError(error: unknown): Readonly<{
  errorClass: DataErrorClass;
  errorCode: string;
  summary: string;
}> {
  const errorClass = classifyDataError(error);
  const errorCode = safeDataErrorCode(error, errorClass);
  const raw = error instanceof Error ? error.message : String(error);
  const summary = raw
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(
      /\b(?:authorization|token|cookie|password|secret|entryId|entry_id)\b\s*[:=]\s*\S+/gi,
      '[redacted]',
    )
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[id]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  return { errorClass, errorCode, summary: summary || errorCode };
}
