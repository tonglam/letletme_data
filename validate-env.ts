import 'dotenv/config';
import {
  assertPrivateBugReportScreenshotBucket,
  createBugReportScreenshotStorage,
} from './src/services/bug-report-screenshot-retention.service';
import { getConfig, validateEnvForCli } from './src/utils/config';
import { logInfo } from './src/utils/logger';

const result = validateEnvForCli();
if (!result.ok) {
  process.exit(1);
}

if (process.argv.includes('--probe-bug-report-storage')) {
  try {
    const config = getConfig();
    const storage = createBugReportScreenshotStorage(config);
    assertPrivateBugReportScreenshotBucket(
      await storage.getBucket(),
      config.BUG_REPORT_SCREENSHOT_BUCKET,
    );
    await storage.list('bug-reports/', 1, 0);
    logInfo('[env] bug-report screenshot storage probe OK', {
      bucket: config.BUG_REPORT_SCREENSHOT_BUCKET,
      retentionDays: config.BUG_REPORT_SCREENSHOT_RETENTION_DAYS,
    });
  } catch (error) {
    console.error('[env] bug-report screenshot storage probe FAILED', {
      error: error instanceof Error ? error.name : 'UnknownError',
    });
    process.exit(1);
  }
}
