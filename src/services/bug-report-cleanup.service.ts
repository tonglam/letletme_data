import { createHash, createHmac, randomUUID } from 'node:crypto';

import { bugReportRepository, type StoredBugReport } from '../repositories/bug-reports';
import { logError, logInfo } from '../utils/logger';

const BATCH_SIZE = 100;

function storageEndpoint(): string {
  const value = process.env.BUG_REPORT_STORAGE_INTERNAL_URL?.trim();
  if (!value) throw new Error('BUG_REPORT_STORAGE_INTERNAL_URL is not set');
  return value.replace(/\/$/, '');
}

async function deleteScreenshot(locator: string): Promise<void> {
  const secret = process.env.BUG_REPORT_CLEANUP_SECRET;
  if (!secret) throw new Error('BUG_REPORT_CLEANUP_SECRET is not set');
  const body = JSON.stringify({ locator });
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}.${bodyHash}`)
    .digest('hex');
  const response = await fetch(`${storageEndpoint()}/delete`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bug-report-timestamp': timestamp,
      'x-bug-report-nonce': nonce,
      'x-bug-report-body-sha256': bodyHash,
      'x-bug-report-signature': signature,
    },
    body,
  });
  if (!response.ok) throw new Error(`Screenshot delete failed: ${response.status}`);
}

export type BugReportCleanupResult = {
  scanned: number;
  deleted: number;
  retried: number;
};

export async function runBugReportCleanup(now = new Date()): Promise<BugReportCleanupResult> {
  const expired = await bugReportRepository.listExpired(now, BATCH_SIZE);
  let deleted = 0;
  let retried = 0;
  for (const report of expired) {
    try {
      if (report.screenshotUrl) await deleteScreenshot(report.screenshotUrl);
      await bugReportRepository.backupAndDelete(report);
      deleted += 1;
    } catch (error) {
      retried += 1;
      logError('Bug report cleanup item failed', error, { publicId: report.publicId });
    }
  }
  logInfo('Bug report cleanup completed', { scanned: expired.length, deleted, retried });
  return { scanned: expired.length, deleted, retried };
}

export async function deleteBugReportScreenshotForCleanup(report: StoredBugReport): Promise<void> {
  if (report.screenshotUrl) await deleteScreenshot(report.screenshotUrl);
}
