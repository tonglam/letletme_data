import { randomBytes, randomUUID } from 'node:crypto';

import { ValidationError } from '../utils/errors';

export const BUG_REPORT_SOURCES = ['website', 'wechat_miniprogram'] as const;
export type BugReportSource = (typeof BUG_REPORT_SOURCES)[number];

export const BUG_REPORT_BODY_MIN = 8;
export const BUG_REPORT_BODY_MAX = 500;
const CLIENT_META_MAX_BYTES = 16 * 1024;

export type BugReportInsert = {
  id: string;
  publicId: string;
  source: BugReportSource;
  userId: string | null;
  entryId: number | null;
  body: string;
  screenshotUrl: string | null;
  clientMeta: Record<string, unknown>;
};

export type BugReportCreateInput = {
  source: string;
  userId?: string | null;
  entryId?: number | null;
  body: string;
  screenshotUrl?: string | null;
  clientMeta?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const createPublicBugReportId = (): string =>
  `LL-${randomBytes(3).toString('hex').toUpperCase()}`;

export const validateBugReportCreateInput = (input: BugReportCreateInput): BugReportInsert => {
  if (input.source !== 'website' && input.source !== 'wechat_miniprogram') {
    throw new ValidationError('Unknown report source.');
  }

  const body = input.body.trim();
  if (body.length < BUG_REPORT_BODY_MIN) {
    throw new ValidationError('Please write a little more about what happened.');
  }
  if (body.length > BUG_REPORT_BODY_MAX) {
    throw new ValidationError('Please keep the description under 500 characters.');
  }

  const entryId = input.entryId ?? null;
  if (entryId !== null && (!Number.isInteger(entryId) || entryId <= 0)) {
    throw new ValidationError('Invalid entry id.');
  }

  const userId = input.userId?.trim() || null;
  const screenshotUrl = input.screenshotUrl?.trim() || null;
  if (screenshotUrl && !screenshotUrl.startsWith('https://')) {
    throw new ValidationError('Screenshot URL must be https.');
  }

  const clientMeta = isRecord(input.clientMeta) ? input.clientMeta : {};
  if (Buffer.byteLength(JSON.stringify(clientMeta), 'utf8') > CLIENT_META_MAX_BYTES) {
    throw new ValidationError('Diagnostic payload is too large.');
  }

  return {
    id: randomUUID(),
    publicId: createPublicBugReportId(),
    source: input.source,
    userId,
    entryId,
    body,
    screenshotUrl,
    clientMeta,
  };
};
