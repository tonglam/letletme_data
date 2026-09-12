import { readFileSync } from 'node:fs';

import { databaseSingleton } from '../src/db/singleton';
import {
  inspectQuarantinedProviderPlayers,
  restoreQuarantinedProviderPlayers,
  type UnderstatPlayerMappingRecoveryApproval,
} from '../src/services/provider-matcher.service';
import { repairPlayerStateSeasons } from '../src/services/player-season-summaries.service';

export type RecoveryArguments = Readonly<{
  season: string;
  apply: boolean;
  approvedFile: string | null;
}>;

function usage(): never {
  throw new Error(
    'usage: bun scripts/recover-understat-player-mappings.ts --season YYYY [--apply --approved-file path]',
  );
}

export function parseRecoveryArguments(argv: readonly string[]): RecoveryArguments {
  if (argv.length === 0) usage();
  let season: string | null = null;
  let apply = false;
  let approvedFile: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--apply') {
      if (apply) throw new Error('--apply may be provided only once');
      apply = true;
      continue;
    }
    if (token === '--season') {
      if (season !== null) throw new Error('--season may be provided only once');
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--season requires YYYY');
      season = value;
      index += 1;
      continue;
    }
    if (token === '--approved-file') {
      if (approvedFile !== null) throw new Error('--approved-file may be provided only once');
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--approved-file requires a path');
      approvedFile = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${token ?? ''}`);
  }
  if (!season || !/^\d{4}$/.test(season))
    throw new Error('--season must be a four-digit season code');
  if (!apply && approvedFile !== null) {
    throw new Error('--approved-file requires --apply');
  }
  if (apply && approvedFile === null) {
    throw new Error('--apply requires --approved-file with an explicit approval list');
  }
  return { season, apply, approvedFile };
}

function parseApproval(value: unknown, index: number): UnderstatPlayerMappingRecoveryApproval {
  if (value === null || typeof value !== 'object') {
    throw new Error(`approval ${index + 1} must be an object`);
  }
  const row = value as Record<string, unknown>;
  const understatPlayerId = row.understatPlayerId;
  const fplPlayerCode = row.fplPlayerCode;
  if (
    typeof row.linkId !== 'string' ||
    !Number.isSafeInteger(understatPlayerId) ||
    !Number.isSafeInteger(fplPlayerCode) ||
    typeof row.evidenceHash !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(row.evidenceHash)
  ) {
    throw new Error(
      `approval ${index + 1} requires linkId, understatPlayerId, fplPlayerCode, and a 64-character evidenceHash`,
    );
  }
  return {
    linkId: row.linkId,
    understatPlayerId: understatPlayerId as number,
    fplPlayerCode: fplPlayerCode as number,
    evidenceHash: row.evidenceHash,
  };
}

export function readRecoveryApprovals(path: string): UnderstatPlayerMappingRecoveryApproval[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed !== null &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { approved?: unknown }).approved)
      ? (parsed as { approved: unknown[] }).approved
      : null;
  if (!rows) throw new Error('approved file must be a JSON array or {"approved": [...]}');
  const approvals = rows.map(parseApproval);
  const linkIds = new Set<string>();
  for (const approval of approvals) {
    if (linkIds.has(approval.linkId)) throw new Error(`duplicate approval ${approval.linkId}`);
    linkIds.add(approval.linkId);
  }
  return approvals;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const args = parseRecoveryArguments(process.argv.slice(2));
  const report = await inspectQuarantinedProviderPlayers(args.season);
  if (!args.apply) {
    process.stdout.write(`${JSON.stringify({ mode: 'report', report }, null, 2)}\n`);
    return;
  }

  const approvals = readRecoveryApprovals(args.approvedFile!);
  const result = await restoreQuarantinedProviderPlayers(args.season, approvals);
  let projection: { checked: number; refreshed: number } | null = null;
  let projectionError: string | null = null;
  // Run the stale-selector repair on every apply invocation. This makes a
  // projection-only retry idempotent after a prior bridge commit succeeded
  // but its post-commit repair failed.
  try {
    projection = await repairPlayerStateSeasons();
  } catch (error) {
    projectionError = errorMessage(error);
    process.exitCode = 1;
  }
  process.stdout.write(
    `${JSON.stringify(
      { mode: 'apply', report, approvals: approvals.length, result, projection, projectionError },
      null,
      2,
    )}\n`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } finally {
    await databaseSingleton.disconnect();
  }
}
