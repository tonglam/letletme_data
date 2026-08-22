import { z } from 'zod';

import { canonicalizePublicUrl } from './acquisition-contract';

const handleSchema = z.string().regex(/^[A-Za-z0-9_]{1,15}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const X_SEMANTIC_QUERIES: Readonly<Record<string, string>> = {
  'gw-official-changes-v1':
    'Fantasy Premier League gameweek deadline fixture postponement reschedule blank double gameweek rules chips scoring official change',
  'availability-v1':
    'Premier League player injury illness suspension fitness press conference availability return for the upcoming FPL gameweek',
  'lineup-role-v1':
    'Premier League starting lineup bench rotation formation position set pieces tactical role for the upcoming FPL gameweek',
  'analysis-longform-v1':
    'Fantasy Premier League analysis opinion article podcast video interview for the upcoming gameweek',
};

export const xKeywordToolRequestV1Schema = z
  .object({
    toolName: z.literal('x_keyword_search'),
    query: z.string().min(1).max(2_000),
    mode: z.literal('Latest'),
    limit: z.number().int().min(1).max(100),
  })
  .strict();

export const xSemanticToolRequestV1Schema = z
  .object({
    toolName: z.literal('x_semantic_search'),
    query: z.string().min(1).max(2_000),
    fromDate: isoDate,
    toDate: isoDate,
    limit: z.number().int().min(1).max(100),
  })
  .strict();

export const xUserToolRequestV1Schema = z
  .object({
    toolName: z.literal('x_user_search'),
    handle: handleSchema,
  })
  .strict();

export const xThreadToolRequestV1Schema = z
  .object({
    toolName: z.literal('x_thread_fetch'),
    postId: z.string().regex(/^\d{1,20}$/),
  })
  .strict();

export const xToolRequestV1Schema = z.discriminatedUnion('toolName', [
  xKeywordToolRequestV1Schema,
  xSemanticToolRequestV1Schema,
  xUserToolRequestV1Schema,
  xThreadToolRequestV1Schema,
]);

export type XToolRequestV1 = z.infer<typeof xToolRequestV1Schema>;

export function compileXUserRequest(handleValue: string): z.infer<typeof xUserToolRequestV1Schema> {
  return xUserToolRequestV1Schema.parse({
    toolName: 'x_user_search',
    handle: handleValue,
  });
}

function utcSearchTimestamp(value: Date): string {
  return `${value.toISOString().slice(0, 19).replace('T', '_')}_UTC`;
}

export function compileXKeywordRequest(input: {
  handles: readonly string[];
  windowStart: Date;
  windowEnd: Date;
  limit?: number;
}): z.infer<typeof xKeywordToolRequestV1Schema> {
  const handles = [...new Set(input.handles.map((handle) => handleSchema.parse(handle)))].sort(
    (a, b) => a.toLowerCase().localeCompare(b.toLowerCase()),
  );
  if (handles.length === 0) throw new Error('Keyword X scan requires at least one handle');
  if (input.windowEnd.getTime() < input.windowStart.getTime()) {
    throw new Error('Keyword X scan window is inverted');
  }
  const authorExpression =
    handles.length === 1
      ? `from:${handles[0]}`
      : `(${handles.map((handle) => `from:${handle}`).join(' OR ')})`;
  return xKeywordToolRequestV1Schema.parse({
    toolName: 'x_keyword_search',
    query: `${authorExpression} since:${utcSearchTimestamp(input.windowStart)} until:${utcSearchTimestamp(input.windowEnd)} -is:retweet`,
    mode: 'Latest',
    limit: input.limit ?? 10,
  });
}

export function compileXSemanticRequest(input: {
  semanticProfileKey: string;
  windowStart: Date;
  windowEnd: Date;
  limit?: number;
}): z.infer<typeof xSemanticToolRequestV1Schema> {
  const query = X_SEMANTIC_QUERIES[input.semanticProfileKey];
  if (!query) throw new Error(`Unknown semantic profile ${input.semanticProfileKey}`);
  if (input.windowEnd.getTime() < input.windowStart.getTime()) {
    throw new Error('Semantic X scan window is inverted');
  }
  return xSemanticToolRequestV1Schema.parse({
    toolName: 'x_semantic_search',
    query,
    // Grok Build 1.0.5's semantic tool accepts day bounds only. The formal
    // run still persists the exact timestamp window and deterministically
    // rejects posts outside it after the tool returns.
    fromDate: input.windowStart.toISOString().slice(0, 10),
    toDate: input.windowEnd.toISOString().slice(0, 10),
    limit: input.limit ?? 10,
  });
}

export function canonicalXPostUrl(handle: string, postId: string): string {
  return canonicalizePublicUrl(
    `https://x.com/${handleSchema.parse(handle)}/status/${z
      .string()
      .regex(/^\d{1,20}$/)
      .parse(postId)}`,
  );
}
