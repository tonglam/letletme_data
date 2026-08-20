import { randomBytes, randomUUID } from 'node:crypto';

import { ValidationError } from '../utils/errors';

export const BUG_REPORT_SOURCES = ['website', 'wechat_miniprogram'] as const;
export type BugReportSource = (typeof BUG_REPORT_SOURCES)[number];

export const BUG_REPORT_BODY_MIN = 8;
export const BUG_REPORT_BODY_MAX = 500;
const CLIENT_META_MAX_BYTES = 16 * 1024;
const PG_INT_MAX = 2_147_483_647;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const createPublicBugReportId = (): string =>
  `LL-${randomBytes(3).toString('hex').toUpperCase()}`;

export const validateBugReportCreateInput = (input: BugReportCreateInput): BugReportInsert => {
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
    submissionId,
    screenshotObjectKey,
    screenshotUrl,
    clientMeta,
  };
};
