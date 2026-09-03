import 'dotenv/config';
import {
  assertPrivateBugReportScreenshotBucket,
  createBugReportScreenshotStorage,
} from './src/services/bug-report-screenshot-retention.service';
import { createFplSourceArtifactStorage } from './src/services/fpl-source-artifact-storage.service';
import { assertContentRuntimeFlags, getContentRuntimeFlags } from './src/content/config';
import { getConfig, validateEnvForCli } from './src/utils/config';
import { logInfo } from './src/utils/logger';

const result = validateEnvForCli();
if (!result.ok) {
  process.exit(1);
}

function describeProbeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      // Keep diagnostics useful without allowing a provider response to flood
      // the deploy log. Storage credentials are never included in these
      // messages by the client implementation.
      message: error.message.slice(0, 240),
    };
  }
  return { name: 'UnknownError', message: String(error).slice(0, 240) };
}

try {
  assertContentRuntimeFlags(getContentRuntimeFlags());
} catch (error) {
  console.error('[env] content runtime validation FAILED', {
    error: error instanceof Error ? error.message : 'UnknownError',
  });
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
      error: describeProbeError(error),
    });
    process.exit(1);
  }
}

if (process.argv.includes('--probe-fpl-raw-snapshot-storage')) {
  try {
    const config = getConfig();
    if (
      !config.FPL_RAW_SNAPSHOT_SUPABASE_URL ||
      !config.FPL_RAW_SNAPSHOT_SUPABASE_SECRET_KEY ||
      !config.FPL_RAW_SNAPSHOT_BUCKET
    ) {
      throw new Error('FPL raw snapshot Storage credentials are missing');
    }
    const storage = createFplSourceArtifactStorage({
      supabaseUrl: config.FPL_RAW_SNAPSHOT_SUPABASE_URL,
      secretKey: config.FPL_RAW_SNAPSHOT_SUPABASE_SECRET_KEY,
      bucket: config.FPL_RAW_SNAPSHOT_BUCKET,
    });
    await storage.provisionAndProbe();
    logInfo('[env] FPL raw snapshot storage probe OK', {
      bucket: config.FPL_RAW_SNAPSHOT_BUCKET,
    });
  } catch (error) {
    console.error('[env] FPL raw snapshot storage probe FAILED', {
      error: describeProbeError(error),
    });
    process.exit(1);
  }
}
