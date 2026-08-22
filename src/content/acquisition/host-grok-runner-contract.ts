import { z } from 'zod';

import {
  grokBuildXPostV1Schema,
  grokBuildXUserV1Schema,
  type GrokBuildExecutionResult,
} from './grok-build-executor';
import { xToolRequestV1Schema } from './x-query-compiler';

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const boundedHashSchema = z.string().min(1).max(128);
const executionResultSchema = z
  .object({
    toolName: z.enum(['x_keyword_search', 'x_semantic_search', 'x_user_search', 'x_thread_fetch']),
    toolInput: z.record(z.union([z.string(), z.number().finite()])),
    posts: z.array(grokBuildXPostV1Schema).max(100).readonly(),
    users: z.array(grokBuildXUserV1Schema).max(20).readonly(),
    requestMetadataHash: sha256Schema,
    responseMetadataHash: sha256Schema,
    traceHash: sha256Schema,
    toolCallIdHash: sha256Schema,
    eventCount: z.number().int().nonnegative(),
    durationMs: z.number().finite().nonnegative(),
    inputTokens: z.number().finite().nonnegative().nullable(),
    outputTokens: z.number().finite().nonnegative().nullable(),
    totalCostUsd: z.number().finite().nonnegative().nullable(),
    rawPostEvidenceAvailable: z.literal(false),
    executionLocation: z.literal('HOST_RUNNER'),
    runnerReleaseSha: boundedHashSchema,
    grokVersion: z.string().min(1).max(64),
    runnerBinaryHash: sha256Schema,
  })
  .strict();

export const hostGrokExecutionRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().uuid(),
    callerReleaseSha: z.string().min(1).max(128),
    toolRequest: xToolRequestV1Schema,
  })
  .strict();

export type HostGrokExecutionRequestV1 = z.infer<typeof hostGrokExecutionRequestV1Schema>;

export const hostGrokExecutionResponseV1Schema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      runId: z.string().uuid(),
      requestHash: sha256Schema,
      runnerReleaseSha: boundedHashSchema,
      grokVersion: z.string().min(1).max(64),
      providerProcessStarted: z.literal(true),
      result: executionResultSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      runId: z.string().uuid(),
      requestHash: sha256Schema,
      providerProcessStarted: z.boolean(),
      failureClass: z.string().min(1).max(128),
      errorDigest: sha256Schema,
    })
    .strict(),
]);

export type HostGrokExecutionResponseV1 = z.infer<typeof hostGrokExecutionResponseV1Schema>;

export type HostGrokFailureClass = string;

export type HostGrokExecutionResult = GrokBuildExecutionResult &
  Readonly<{
    executionLocation: 'HOST_RUNNER';
    runnerReleaseSha: string;
    grokVersion: string;
    runnerBinaryHash: string;
  }>;
