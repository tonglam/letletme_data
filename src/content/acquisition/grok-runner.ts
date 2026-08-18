import { spawn } from 'node:child_process';
import { assertWeekPublication, type WeekLocale } from '../contracts/week-publication';

export type GrokRunMode = 'poll' | 'enrich' | 'compose';

export type GrokRunInput = Readonly<{
  mode: GrokRunMode;
  profile: 'week';
  runId: string;
  sourceSnapshotRevision: string;
  sources: readonly Record<string, unknown>[];
  windowStart: string;
  windowEnd: string;
  maxXCalls: number;
  locale?: WeekLocale;
}>;

export type GrokRunResult = Readonly<{
  status: 'EMPTY' | 'PARTIAL' | 'COMPLETED' | 'FAILED';
  traceVerified: boolean;
  xCallCount: number;
  receipts: readonly Record<string, unknown>[];
  error?: string;
  skillSha: string;
}>;

export interface GrokRunner {
  run(input: GrokRunInput): Promise<GrokRunResult>;
}

export const MONITOR_FPL_X_SOURCES_SKILL = 'monitor-fpl-x-sources';
export const MONITOR_FPL_X_SOURCES_SKILL_SHA =
  'b23dc3dcf7ab79c7d13fd40a2a08d298ad4740940f71aa44988954b5690d3519';

export class FixtureGrokRunner implements GrokRunner {
  async run(_input: GrokRunInput): Promise<GrokRunResult> {
    return {
      status: 'EMPTY',
      traceVerified: true,
      xCallCount: 0,
      receipts: [],
      skillSha: MONITOR_FPL_X_SOURCES_SKILL_SHA,
    };
  }
}

/**
 * The production adapter deliberately accepts an argv array and shell:false.
 * The Grok skill owns X search semantics; this adapter only transports a JSON
 * request and validates that the final response is a real Week contract.
 */
export class CliGrokRunner implements GrokRunner {
  constructor(
    private readonly binary: string,
    private readonly timeoutMs = 90_000,
  ) {}

  async run(input: GrokRunInput): Promise<GrokRunResult> {
    const args = ['run', '--skill', MONITOR_FPL_X_SOURCES_SKILL, '--format', 'json'];
    return new Promise((resolve) => {
      const child = spawn(this.binary, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => child.kill('SIGTERM'), this.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          resolve({
            status: 'FAILED',
            traceVerified: false,
            xCallCount: 0,
            receipts: [],
            error: stderr.slice(-500),
            skillSha: '',
          });
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as GrokRunResult & { publication?: unknown };
          if (parsed.publication) assertWeekPublication(parsed.publication);
          resolve({
            status: parsed.status,
            traceVerified: parsed.traceVerified === true,
            xCallCount: Number.isSafeInteger(parsed.xCallCount) ? parsed.xCallCount : 0,
            receipts: Array.isArray(parsed.receipts) ? parsed.receipts : [],
            skillSha: typeof parsed.skillSha === 'string' ? parsed.skillSha : '',
          });
        } catch {
          resolve({
            status: 'FAILED',
            traceVerified: false,
            xCallCount: 0,
            receipts: [],
            error: 'Invalid Grok JSON output',
            skillSha: '',
          });
        }
      });
      child.stdin.end(JSON.stringify(input));
    });
  }
}
