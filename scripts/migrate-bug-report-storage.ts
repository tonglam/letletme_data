import { runBugReportStorageMigration } from '../src/services/bug-report-storage-migration.service';

const dryRun = !process.argv.includes('--apply');

try {
  const result = await runBugReportStorageMigration({ dryRun });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!dryRun && result.failed > 0) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
