import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';

import type { WeekLocale } from '../contracts/week-publication';

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
  '59756e06e085c09899315e059977df10d70c62eba388e7dafbda694377b65429';
const ADAPTER_VERSION = 'cli-v2';
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const fixtureHash = createHash('sha256').update('fixture-grok-v1', 'utf8').digest('hex');

const skillPath = (): string =>
  resolve(process.env.GROK_SKILL_PATH ?? '.grok/skills/monitor-fpl-x-sources/SKILL.md');

async function listSkillFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await listSkillFiles(root, absolute)));
    else if (entry.isFile()) files.push(relative(root, absolute).split(sep).join('/'));
  }
  return files;
}

async function skillBundleSha(): Promise<string> {
  const entry = skillPath();
  const root = resolve(entry, '..');
  const files = await listSkillFiles(root);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(await readFile(join(root, file)));
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const RECEIPT_KEYS = new Set([
  'sourceId',
  'externalId',
  'canonicalUrl',
  'capturedAt',
  'publishedAt',
  'canonicalHash',
  'payload',
]);

const isDateTime = (value: unknown): value is string =>
  typeof value === 'string' && DATE_TIME_PATTERN.test(value) && Number.isFinite(Date.parse(value));

export function isValidGrokReceipt(value: unknown): value is Record<string, unknown> {
  const receipt = asRecord(value);
  if (!receipt || Object.keys(receipt).some((key) => !RECEIPT_KEYS.has(key))) return false;
  if (typeof receipt.sourceId !== 'string' || !UUID_PATTERN.test(receipt.sourceId)) return false;
  if (
    typeof receipt.externalId !== 'string' ||
    [...receipt.externalId].length < 1 ||
    [...receipt.externalId].length > 256
  )
    return false;
  if (typeof receipt.canonicalUrl !== 'string' || !receipt.canonicalUrl.startsWith('https://'))
    return false;
  try {
    if (new URL(receipt.canonicalUrl).protocol !== 'https:') return false;
  } catch {
    return false;
  }
  if (!isDateTime(receipt.capturedAt)) return false;
  if (
    receipt.publishedAt !== undefined &&
    receipt.publishedAt !== null &&
    !isDateTime(receipt.publishedAt)
  )
    return false;
  if (typeof receipt.canonicalHash !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.canonicalHash))
    return false;
  if (receipt.payload !== undefined && asRecord(receipt.payload) === null) return false;
  return true;
}

function findJsonResult(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;
  if (
    typeof record.status === 'string' &&
    ['EMPTY', 'PARTIAL', 'COMPLETED', 'FAILED'].includes(record.status)
  )
    return record;
  for (const child of Object.values(record)) {
    const found = findJsonResult(child);
    if (found) return found;
  }
  return null;
}

function isXToolEvent(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  const eventType = record.type;
  if (
    eventType !== 'tool_call' &&
    eventType !== 'tool_use' &&
    eventType !== 'tool_call_start' &&
    eventType !== 'tool_invocation'
  )
    return false;
  const tool = record.tool ?? record.toolName ?? record.tool_name ?? record.name;
  if (typeof tool === 'string') return tool === 'x_search';
  const nestedTool = asRecord(tool);
  return nestedTool?.name === 'x_search';
}

function parseStreamingOutput(output: string): {
  result: Record<string, unknown> | null;
  xCallCount: number;
  eventCount: number;
  text: string;
} {
  let xCallCount = 0;
  let eventCount = 0;
  const textParts: string[] = [];
  let result: Record<string, unknown> | null = null;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    eventCount += 1;
    if (isXToolEvent(event)) xCallCount += 1;
    const eventRecord = asRecord(event);
    if (!eventRecord) continue;
    const candidate = findJsonResult(event);
    if (candidate) result = candidate;
    for (const key of ['text', 'content', 'delta']) {
      const value = eventRecord[key];
      if (typeof value === 'string') textParts.push(value);
      const nested = asRecord(value);
      if (nested && typeof nested.text === 'string') textParts.push(nested.text);
    }
  }
  if (!result) {
    try {
      result = findJsonResult(JSON.parse(output));
    } catch {
      result = null;
    }
  }
  return { result, xCallCount, eventCount, text: textParts.join('') };
}

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
 * Production headless adapter for the official Grok CLI.  It never accepts a
 * shell command string or arbitrary executable from runtime configuration;
 * tests may inject a fixture path through the constructor.
 */
export class CliGrokRunner implements GrokRunner {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly runRoot: string;

  constructor(
    binary = resolve(process.cwd(), 'node_modules/.bin/grok'),
    timeoutMs = 90_000,
    runRoot = join(tmpdir(), 'letletme-content-x'),
  ) {
    this.binary = binary;
    this.timeoutMs = timeoutMs;
    this.runRoot = runRoot;
  }

  async run(input: GrokRunInput): Promise<GrokRunResult> {
    const requestJson = JSON.stringify(input);
    const requestHash = sha256(requestJson);
    let runDir = '';
    let expectedSkillSha = '';
    try {
      expectedSkillSha = await skillBundleSha();
      if (expectedSkillSha !== MONITOR_FPL_X_SOURCES_SKILL_SHA)
        throw new Error('Grok skill SHA mismatch');
      await mkdir(this.runRoot, { recursive: true, mode: 0o700 });
      runDir = await mkdtemp(join(this.runRoot, `${input.runId}-`));
      await writeFile(join(runDir, 'input.json'), requestJson, { mode: 0o600 });
      // Grok resolves slash-prefixed skills from the active cwd. Keep the
      // tracked skill (including schemas and taxonomy references) inside this
      // isolated run directory instead of relying on the image-level copy
      // while the CLI is pointed at a fresh temporary cwd.
      const runSkillDir = join(runDir, '.grok', 'skills', MONITOR_FPL_X_SOURCES_SKILL);
      await mkdir(resolve(runSkillDir, '..'), { recursive: true, mode: 0o700 });
      await cp(resolve(skillPath(), '..'), runSkillDir, { recursive: true });
      const prompt = `/${MONITOR_FPL_X_SOURCES_SKILL} input=input.json format=json`;
      const args = [
        '--disable-web-search',
        '--output-format',
        'streaming-json',
        '--no-auto-update',
        '--no-subagents',
        '--disallowed-tools',
        'Bash,Edit,Write,Agent',
        '--permission-mode',
        'dontAsk',
        '--cwd',
        runDir,
        '-p',
        prompt,
      ];
      const output = await this.spawn(args, runDir);
      const parsed = parseStreamingOutput(output);
      const modelResult =
        parsed.result ??
        (() => {
          try {
            return asRecord(JSON.parse(parsed.text));
          } catch {
            return null;
          }
        })();
      if (!modelResult) throw new Error('Invalid Grok streaming JSON output');
      const status = ['EMPTY', 'PARTIAL', 'COMPLETED', 'FAILED'].includes(
        String(modelResult.status),
      )
        ? (String(modelResult.status) as GrokRunResult['status'])
        : 'FAILED';
      const rawReceipts = modelResult.receipts;
      const receiptsValid =
        Array.isArray(rawReceipts) && rawReceipts.every((item) => isValidGrokReceipt(item));
      const receipts = receiptsValid
        ? (rawReceipts as Record<string, unknown>[])
        : ([] as Record<string, unknown>[]);
      const receiptError = receiptsValid ? undefined : 'Invalid Grok receipt schema';
      const finalStatus = receiptError ? 'FAILED' : status;
      const response = {
        status: finalStatus,
        receipts,
        modelResult,
        xCallCount: parsed.xCallCount,
      };
      return {
        status: finalStatus,
        traceVerified: parsed.xCallCount > 0 && finalStatus !== 'FAILED',
        xCallCount: parsed.xCallCount,
        receipts,
        error:
          receiptError ?? (typeof modelResult.error === 'string' ? modelResult.error : undefined),
        skillSha: expectedSkillSha,
        toolName: 'grok.x',
        adapterVersion: ADAPTER_VERSION,
        requestHash,
        responseHash: sha256(JSON.stringify(response)),
        traceMetadata: {
          eventCount: parsed.eventCount,
          xToolCalls: parsed.xCallCount,
          receiptSchemaValid: receiptsValid,
        },
        costMicros: Number.isSafeInteger(modelResult.costMicros)
          ? Number(modelResult.costMicros)
          : undefined,
        costCurrency:
          typeof modelResult.costCurrency === 'string' ? modelResult.costCurrency : undefined,
        costUnits: Number.isSafeInteger(modelResult.costUnits)
          ? Number(modelResult.costUnits)
          : undefined,
      };
    } catch (error) {
      return {
        status: 'FAILED',
        traceVerified: false,
        xCallCount: 0,
        receipts: [],
        error: error instanceof Error ? error.message : String(error),
        skillSha: expectedSkillSha,
        toolName: 'grok.x',
        adapterVersion: ADAPTER_VERSION,
        requestHash,
      };
    } finally {
      if (runDir) await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private spawn(args: readonly string[], cwd: string): Promise<string> {
    return new Promise((resolveOutput, reject) => {
      const child = spawn(this.binary, [...args], {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GROK_NO_AUTO_UPDATE: '1' },
      });
      let stdout = '';
      let stderr = '';
      const stdoutDecoder = new StringDecoder('utf8');
      let outputBytes = 0;
      let settled = false;
      let termination: 'timeout' | 'oversized' | null = null;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        callback();
      };
      const terminate = () => {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, 1_000);
      };
      const timeout = setTimeout(() => {
        termination = 'timeout';
        terminate();
      }, this.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes <= MAX_OUTPUT_BYTES) stdout += stdoutDecoder.write(chunk);
        else if (termination === null) {
          termination = 'oversized';
          terminate();
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2_000);
      });
      child.on('error', (error) => finish(() => reject(error)));
      child.on('close', (code) =>
        finish(() => {
          if (outputBytes <= MAX_OUTPUT_BYTES) stdout += stdoutDecoder.end();
          if (termination === 'oversized') reject(new Error('Grok output exceeded 2 MiB'));
          else if (termination === 'timeout')
            reject(new Error(`Grok timed out after ${this.timeoutMs}ms`));
          else if (code !== 0) reject(new Error(stderr || `Grok exited with code ${code}`));
          else resolveOutput(stdout);
        }),
      );
    });
  }
}
