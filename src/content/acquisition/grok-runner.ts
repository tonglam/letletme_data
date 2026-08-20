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
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const RECEIPT_KEYS = new Set([
  'sourceId',
  'externalId',
  'canonicalUrl',
  'capturedAt',
  'publishedAt',
  'canonicalHash',
  'payload',
]);

const isDateTime = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const match = DATE_TIME_PATTERN.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, timezone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return false;
  if (timezone !== 'Z') {
    const offsetMatch = /^[+-](\d{2}):(\d{2})$/.exec(timezone);
    if (!offsetMatch || Number(offsetMatch[1]) > 23 || Number(offsetMatch[2]) > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
};

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

const TOOL_INVOCATION_EVENT_TYPES = new Set([
  'tool_call',
  'tool_use',
  'tool_call_start',
  'tool_invocation',
  'tool_invocation_start',
]);

const TOOL_COMPLETION_EVENT_TYPES = new Set([
  'tool_result',
  'tool_call_end',
  'tool_call_result',
  'tool_invocation_end',
  'tool_invocation_result',
  'tool_use_result',
  'tool_output',
  'tool_return',
]);

function getToolName(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ['tool', 'toolName', 'tool_name', 'name']) {
    const tool = record[key];
    if (typeof tool === 'string') return tool;
    const nestedTool = asRecord(tool);
    if (typeof nestedTool?.name === 'string') return nestedTool.name;
  }
  for (const key of ['tool_call', 'toolCall', 'invocation', 'call']) {
    const nestedName = getToolName(record[key]);
    if (nestedName) return nestedName;
  }
  return undefined;
}

function getToolCallId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ['tool_call_id', 'toolCallId', 'call_id', 'callId', 'id']) {
    const id = record[key];
    if (typeof id === 'string' && id.length > 0) return id;
    if (typeof id === 'number' && Number.isSafeInteger(id)) return String(id);
  }
  for (const key of ['tool_call', 'toolCall', 'invocation', 'call']) {
    const nestedId = getToolCallId(record[key]);
    if (nestedId) return nestedId;
  }
  return undefined;
}

function isToolFailure(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  if (record.success === false || record.ok === false) return true;
  for (const key of ['status', 'state']) {
    const status = record[key];
    if (
      typeof status === 'string' &&
      /^(?:failed|failure|error|errored|cancelled|canceled|rejected|timeout|timed_out)$/i.test(
        status.trim(),
      )
    )
      return true;
  }
  if (record.error !== undefined && record.error !== null) return true;
  for (const key of ['result', 'output', 'data']) {
    const nested = asRecord(record[key]);
    if (nested && isToolFailure(nested)) return true;
  }
  return false;
}

function isXToolInvocation(value: unknown): boolean {
  const record = asRecord(value);
  return (
    !!record &&
    TOOL_INVOCATION_EVENT_TYPES.has(String(record.type)) &&
    getToolName(record) === 'x_search'
  );
}

function isXToolCompletion(value: unknown): boolean {
  const record = asRecord(value);
  return !!record && TOOL_COMPLETION_EVENT_TYPES.has(String(record.type));
}

function parseStreamingOutput(output: string): {
  result: Record<string, unknown> | null;
  xCallCount: number;
  eventCount: number;
  text: string;
} {
  let xCallCount = 0;
  let anonymousPendingXCalls = 0;
  const pendingXCalls = new Map<string, number>();
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
    if (isXToolInvocation(event)) {
      const callId = getToolCallId(event);
      if (callId) pendingXCalls.set(callId, (pendingXCalls.get(callId) ?? 0) + 1);
      else anonymousPendingXCalls += 1;
    } else if (isXToolCompletion(event) && !isToolFailure(event)) {
      const eventTool = getToolName(event);
      const callId = getToolCallId(event);
      const matchesXCall = eventTool === 'x_search' || (eventTool === undefined && !!callId);
      if (matchesXCall) {
        if (callId) {
          const pending = pendingXCalls.get(callId) ?? 0;
          if (pending > 0) {
            xCallCount += 1;
            if (pending === 1) pendingXCalls.delete(callId);
            else pendingXCalls.set(callId, pending - 1);
          }
        } else if (anonymousPendingXCalls > 0) {
          xCallCount += 1;
          anonymousPendingXCalls -= 1;
        }
      }
    } else if (isXToolCompletion(event)) {
      // Consume failed completions so a later duplicate result cannot be
      // mistaken for a successful X call.
      const callId = getToolCallId(event);
      if (callId) {
        const pending = pendingXCalls.get(callId) ?? 0;
        if (pending <= 1) pendingXCalls.delete(callId);
        else pendingXCalls.set(callId, pending - 1);
      } else if (anonymousPendingXCalls > 0) {
        anonymousPendingXCalls -= 1;
      }
    }
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
