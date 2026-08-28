/* eslint-disable no-console */

type CoverageRecord = Readonly<{
  file: string;
  executableLines: number;
  coveredExecutableLines: number;
  functionsFound: number;
  functionsHit: number;
}>;

type CoverageGate = Readonly<{
  name: string;
  file: string;
  minimumLines: number;
  minimumFunctions: number;
}>;

/**
 * These are deliberately small, dependency-free decision modules.  The
 * repository-wide report remains informational; only the business safety
 * gates below block CI.  Database/Redis adapters are covered by integration
 * tests and are not treated as a mechanical whole-repository percentage.
 */
export const CRITICAL_COVERAGE_GATES: readonly CoverageGate[] = [
  {
    name: 'Manager Live refresh projection',
    file: 'src/services/manager-live/final-projection.ts',
    minimumLines: 80,
    minimumFunctions: 75,
  },
  {
    name: 'Manager Live coverage state',
    file: 'src/services/manager-live/coverage.ts',
    minimumLines: 80,
    minimumFunctions: 75,
  },
  {
    name: 'My FPL invalidation state',
    file: 'src/domain/my-fpl-invalidation.ts',
    minimumLines: 80,
    minimumFunctions: 75,
  },
  {
    name: 'Data publication delivery state',
    file: 'src/domain/data-publication-delivery.ts',
    minimumLines: 80,
    minimumFunctions: 75,
  },
  {
    name: 'Scheduler obligation fence',
    file: 'src/utils/scheduler-obligation-fence.ts',
    minimumLines: 80,
    minimumFunctions: 75,
  },
  {
    name: 'Tournament management policy',
    file: 'src/domain/tournament-management.ts',
    minimumLines: 75,
    minimumFunctions: 70,
  },
  {
    name: 'Runtime lifecycle',
    file: 'src/utils/shutdown-controller.ts',
    minimumLines: 75,
    minimumFunctions: 70,
  },
];

function parseNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label} value in LCOV: ${value}`);
  }
  return parsed;
}

export function parseLcov(text: string): Map<string, CoverageRecord> {
  const records = new Map<string, CoverageRecord>();
  let file: string | undefined;
  let executableLines = 0;
  let coveredExecutableLines = 0;
  let functionsFound = 0;
  let functionsHit = 0;

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      file = line.slice(3);
      executableLines = 0;
      coveredExecutableLines = 0;
      functionsFound = 0;
      functionsHit = 0;
      continue;
    }
    if (!file) continue;
    if (line.startsWith('DA:')) {
      const [lineNumber, hitCount] = line.slice(3).split(',', 2);
      parseNumber(lineNumber ?? '', 'DA line');
      const hits = parseNumber(hitCount ?? '', 'DA hit count');
      executableLines += 1;
      if (hits > 0) coveredExecutableLines += 1;
    } else if (line.startsWith('FNF:')) functionsFound = parseNumber(line.slice(4), 'FNF');
    else if (line.startsWith('FNH:')) functionsHit = parseNumber(line.slice(4), 'FNH');
    else if (line === 'end_of_record') {
      records.set(file, {
        file,
        executableLines,
        coveredExecutableLines,
        functionsFound,
        functionsHit,
      });
      file = undefined;
    }
  }
  if (file) throw new Error(`Incomplete LCOV record for ${file}`);
  return records;
}

function percentage(hit: number, found: number): number {
  return found === 0 ? 100 : (hit / found) * 100;
}

export function assertCriticalCoverage(
  records: ReadonlyMap<string, CoverageRecord>,
  gates: readonly CoverageGate[] = CRITICAL_COVERAGE_GATES,
): void {
  const failures: string[] = [];
  for (const gate of gates) {
    const record = records.get(gate.file);
    if (!record) {
      failures.push(`${gate.name}: missing ${gate.file} from LCOV`);
      continue;
    }
    const lineCoverage = percentage(record.coveredExecutableLines, record.executableLines);
    const functionCoverage = percentage(record.functionsHit, record.functionsFound);
    const summary =
      `${gate.name}: lines ${lineCoverage.toFixed(1)}% (min ${gate.minimumLines}%), ` +
      `functions ${functionCoverage.toFixed(1)}% (min ${gate.minimumFunctions}%)`;
    console.log(summary);
    if (lineCoverage < gate.minimumLines || functionCoverage < gate.minimumFunctions) {
      failures.push(summary);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Critical coverage gate failed:\n${failures.join('\n')}`);
  }
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? 'coverage/lcov.info';
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`Coverage file does not exist: ${path}`);
  assertCriticalCoverage(parseLcov(await file.text()));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
