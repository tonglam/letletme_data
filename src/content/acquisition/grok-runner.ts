import { createHash } from 'node:crypto';
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
  toolName?: string;
  adapterVersion?: string;
  requestHash?: string;
  responseHash?: string;
  traceMetadata?: Record<string, unknown>;
  costMicros?: number;
  costCurrency?: string;
  costUnits?: number;
}>;

export interface GrokRunner {
  run(input: GrokRunInput): Promise<GrokRunResult>;
}

export const MONITOR_FPL_X_SOURCES_SKILL = 'monitor-fpl-x-sources';
export const MONITOR_FPL_X_SOURCES_SKILL_SHA =
  'b23dc3dcf7ab79c7d13fd40a2a08d298ad4740940f71aa44988954b5690d3519';
const fixtureHash = createHash('sha256').update('fixture-grok-v1', 'utf8').digest('hex');

export class FixtureGrokRunner implements GrokRunner {
  async run(_input: GrokRunInput): Promise<GrokRunResult> {
    return {
      status: 'EMPTY',
      traceVerified: true,
      xCallCount: 0,
      receipts: [],
      skillSha: MONITOR_FPL_X_SOURCES_SKILL_SHA,
      toolName: 'fixture',
      adapterVersion: 'fixture-v1',
      requestHash: fixtureHash,
      responseHash: fixtureHash,
      traceMetadata: { trace: 'fixture', calls: [] },
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
      let settled = false;
      const fail = (error: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({
          status: 'FAILED',
          traceVerified: false,
          xCallCount: 0,
          receipts: [],
          error,
          skillSha: '',
          toolName: 'grok',
          adapterVersion: 'cli-v1',
        });
      };
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        fail(`Grok timed out after ${this.timeoutMs}ms`);
      }, this.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => fail(error.message));
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code !== 0) {
          resolve({
            status: 'FAILED',
            traceVerified: false,
            xCallCount: 0,
            receipts: [],
            error: stderr.slice(-500),
            skillSha: '',
            toolName: 'grok',
            adapterVersion: 'cli-v1',
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
            toolName: 'grok',
            adapterVersion: 'cli-v1',
            requestHash: typeof parsed.requestHash === 'string' ? parsed.requestHash : undefined,
            responseHash: typeof parsed.responseHash === 'string' ? parsed.responseHash : undefined,
            traceMetadata:
              parsed.traceMetadata && typeof parsed.traceMetadata === 'object'
                ? parsed.traceMetadata
                : undefined,
            costMicros: Number.isSafeInteger(parsed.costMicros) ? parsed.costMicros : undefined,
            costCurrency: typeof parsed.costCurrency === 'string' ? parsed.costCurrency : undefined,
            costUnits: Number.isSafeInteger(parsed.costUnits) ? parsed.costUnits : undefined,
          });
        } catch {
          resolve({
            status: 'FAILED',
            traceVerified: false,
            xCallCount: 0,
            receipts: [],
            error: 'Invalid Grok JSON output',
            skillSha: '',
            toolName: 'grok',
            adapterVersion: 'cli-v1',
          });
        }
      });
      child.stdin.end(JSON.stringify(input));
    });
  }
}
