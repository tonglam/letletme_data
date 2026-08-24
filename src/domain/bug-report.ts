import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { ValidationError } from '../utils/errors';

export const BUG_REPORT_SOURCES = ['website', 'wechat_miniprogram'] as const;
export type BugReportSource = (typeof BUG_REPORT_SOURCES)[number];

export const BUG_REPORT_BODY_MIN = 8;
export const BUG_REPORT_BODY_MAX = 500;
const CLIENT_META_MAX_BYTES = 16 * 1024;
const PG_INT_MAX = 2_147_483_647;
const RETENTION_DAYS = 180;
const CLOSED_RETENTION_DAYS = 30;

const DIAGNOSTIC_KEYS = new Set([
  'route',
  'currentGw',
  'envVersion',
  'clientTime',
  'platform',
  'osMajor',
  'sdkVersion',
  'language',
  'viewportBucket',
  'operations',
]);
const GRAPHQL_RATE_LIMIT_POLICIES = new Set(['graphql-v2', 'graphql-v3', 'graphql-v4']);
const GRAPHQL_RATE_LIMIT_SCOPES = new Set(['global', 'client', 'workload']);
const GRAPHQL_WORKLOADS = new Set([
  'interactive',
  'home',
  'fixtures',
  'market',
  'player-stats',
  'gameweek',
  'public-other',
]);
const SAFE_DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const DIAGNOSTIC_FIELD_MAX_LENGTH: Record<string, number> = {
  at: 40,
  operation: 80,
  requestId: 80,
  code: 80,
  message: 180,
  rateLimitPolicy: 32,
  rateLimitScope: 16,
  workload: 32,
};
const SUBMISSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCREENSHOT_OBJECT_KEY_PATTERN =
  /^bug-reports\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(?:jpg|png|webp|gif)$/i;

const codePointLength = (value: string): number => [...value].length;

export type BugReportInsert = {
  id: string;
  publicId: string;
  source: BugReportSource;
  userId: string | null;
  entryId: number | null;
  body: string;
  submissionId: string | null;
  screenshotObjectKey: string | null;
  screenshotDeletedAt?: Date | null;
  screenshotUrl: string | null;
  clientMeta: Record<string, unknown>;
  submissionRequestHash: string;
  closedAt: Date | null;
  expiresAt: Date;
};

export type BugReportCreateInput = {
  source: string;
  userId?: string | null;
  entryId?: number | null;
  body: string;
  submissionId?: string | null;
  screenshotObjectKey?: string | null;
  screenshotUrl?: string | null;
  clientMeta?: unknown;
};

export type BugReportStatus = 'open' | 'ack' | 'closed';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
};

type BugReportRequestIdentity = Pick<
  BugReportInsert,
  | 'source'
  | 'userId'
  | 'entryId'
  | 'body'
  | 'submissionId'
  | 'screenshotObjectKey'
  | 'screenshotUrl'
>;

// Client metadata is diagnostic telemetry, not the submitted report identity.
// Keep it out of the hash so adding a bounded diagnostic field cannot make a
// retry of the same submission look like a different report.
export const bugReportRequestHash = (input: BugReportRequestIdentity): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalize({ version: 2, ...input })), 'utf8')
    .digest('hex');

const redactDiagnosticText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const cleaned = value
    // Stop at JSON delimiters so a URL immediately before a sensitive field
    // cannot consume the field name and leave its value behind.
    .replace(/https?:\/\/[^\s"'<>，、；;},\]]+/gi, '[url]')
    .replace(
      /(["']?)\b(?:authorization|token)\b\1\s*[:=]\s*(?:[A-Za-z][A-Za-z0-9_-]*\s+)?(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
      '[redacted]',
    )
    .replace(
      /(["']?)\b(?:cookie|deviceId|entryId)\b\1\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
      '[redacted]',
    )
    .replace(/\bauthorization\b\s*[:=]\s*(?:[A-Za-z][A-Za-z0-9_-]*\s+)?[^\s,;&]+/gi, '[redacted]')
    .replace(/\btoken\b\s*[:=]\s*(?:[A-Za-z][A-Za-z0-9_-]*\s+)?[^\s,;&]+/gi, '[redacted]')
    .replace(/\b(?:cookie|deviceId|entryId)\b\s*[:=]\s*[^\s,;&]+(?:;\s*[^\s,;&]+)*/gi, '[redacted]')
    .replace(/([A-Za-z0-9_-]+)=(?:[^\s&]+)/g, '$1=[redacted]')
    .replace(/\b(?:token|authorization|cookie|deviceId|entryId)\b/gi, '[redacted]')
    .trim()
    .slice(0, 160);
  return cleaned || null;
};

export function sanitizeBugReportClientMeta(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const cleaned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!DIAGNOSTIC_KEYS.has(key)) continue;
    if (key === 'operations') {
      if (!Array.isArray(entry)) continue;
      const operations = entry.slice(-3).flatMap((operation) => {
        if (!isRecord(operation)) return [];
        const result: Record<string, unknown> = {};
        for (const field of [
          'at',
          'operation',
          'requestId',
          'code',
          'message',
          'rateLimitPolicy',
          'rateLimitScope',
          'workload',
        ]) {
          const text = redactDiagnosticText(operation[field]);
          if (!text) continue;
          const maxLength = DIAGNOSTIC_FIELD_MAX_LENGTH[field] ?? 160;
          const bounded = text.slice(0, maxLength);
          if (field === 'code' && !SAFE_DIAGNOSTIC_CODE.test(bounded)) continue;
          result[field] = bounded;
        }
        if (
          typeof result.rateLimitPolicy === 'string' &&
          !GRAPHQL_RATE_LIMIT_POLICIES.has(result.rateLimitPolicy)
        )
          delete result.rateLimitPolicy;
        if (
          typeof result.rateLimitScope === 'string' &&
          !GRAPHQL_RATE_LIMIT_SCOPES.has(result.rateLimitScope)
        )
          delete result.rateLimitScope;
        if (typeof result.workload === 'string' && !GRAPHQL_WORKLOADS.has(result.workload))
          delete result.workload;
        const status = operation.status;
        if (
          typeof status === 'number' &&
          Number.isSafeInteger(status) &&
          status >= 0 &&
          status <= 599
        ) {
          result.status = status;
        }
        const retryAfterSeconds = operation.retryAfterSeconds;
        if (
          typeof retryAfterSeconds === 'number' &&
          Number.isSafeInteger(retryAfterSeconds) &&
          retryAfterSeconds >= 0 &&
          retryAfterSeconds <= 120
        ) {
          result.retryAfterSeconds = retryAfterSeconds;
        }
        return Object.keys(result).length > 0 ? [result] : [];
      });
      if (operations.length > 0) cleaned.operations = operations;
      continue;
    }
    if (typeof entry === 'string') {
      const text = redactDiagnosticText(entry);
      if (text) cleaned[key] = text;
      continue;
    }
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      cleaned[key] = entry;
      continue;
    }
    if (typeof entry === 'boolean') cleaned[key] = entry;
  }
  if (Buffer.byteLength(JSON.stringify(cleaned), 'utf8') > CLIENT_META_MAX_BYTES)
    return { truncated: true };
  return cleaned;
}

export function retentionDeadline(
  createdAt: Date,
  status: BugReportStatus,
  closedAt: Date | null,
): Date {
  const hard = new Date(createdAt.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000);
  if (status !== 'closed' || !closedAt) return hard;
  const closed = new Date(closedAt.getTime() + CLOSED_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return closed < hard ? closed : hard;
}

export const createPublicBugReportId = (): string =>
  `LL-${randomBytes(6).toString('hex').toUpperCase()}`;

export const validateBugReportCreateInput = (
  input: BugReportCreateInput,
  options: { publicIdGenerator?: () => string } = {},
): BugReportInsert => {
  if (input.source !== 'website' && input.source !== 'wechat_miniprogram') {
    throw new ValidationError('Unknown report source.');
  }

  const body = input.body.trim();
  const bodyLength = codePointLength(body);
  if (bodyLength < BUG_REPORT_BODY_MIN) {
    throw new ValidationError('Please write a little more about what happened.');
  }
  if (bodyLength > BUG_REPORT_BODY_MAX) {
    throw new ValidationError('Please keep the description under 500 characters.');
  }

  const entryId = input.entryId ?? null;
  if (entryId !== null && (!Number.isInteger(entryId) || entryId <= 0 || entryId > PG_INT_MAX)) {
    throw new ValidationError('Invalid entry id.');
  }

  const userId = input.userId?.trim() || null;
  const submissionId = input.submissionId?.trim() || null;
  if (submissionId && !SUBMISSION_ID_PATTERN.test(submissionId)) {
    throw new ValidationError('Invalid submission id.');
  }

  const screenshotObjectKey = input.screenshotObjectKey?.trim() || null;
  const screenshotObjectKeyMatch = screenshotObjectKey
    ? SCREENSHOT_OBJECT_KEY_PATTERN.exec(screenshotObjectKey)
    : null;
  if (screenshotObjectKey && !screenshotObjectKeyMatch) {
    throw new ValidationError('Invalid screenshot object key.');
  }

  const screenshotUrl = input.screenshotUrl?.trim() || null;
  if (screenshotObjectKey && screenshotUrl) {
    throw new ValidationError('Screenshot URL and object key cannot both be provided.');
  }
  if (screenshotObjectKey && !submissionId) {
    throw new ValidationError('Screenshot object key requires a submission id.');
  }
  if (
    screenshotObjectKey &&
    submissionId &&
    screenshotObjectKeyMatch?.[1].toLowerCase() !== submissionId.toLowerCase()
  ) {
    throw new ValidationError('Screenshot object key does not belong to the submission.');
  }
  if (screenshotUrl && !screenshotUrl.startsWith('https://')) {
    throw new ValidationError('Screenshot URL must be https.');
  }

  const clientMeta = sanitizeBugReportClientMeta(input.clientMeta);
  const createdAt = new Date();

  return {
    id: randomUUID(),
    source: input.source,
    userId,
    entryId,
    body,
    submissionId,
    screenshotObjectKey,
    screenshotUrl,
    clientMeta,
    submissionRequestHash: bugReportRequestHash({
      source: input.source as BugReportSource,
      userId,
      entryId,
      body,
      submissionId,
      screenshotObjectKey,
      screenshotUrl,
    }),
    publicId: (options.publicIdGenerator ?? createPublicBugReportId)(),
    closedAt: null,
    expiresAt: retentionDeadline(createdAt, 'open', null),
  };
};
