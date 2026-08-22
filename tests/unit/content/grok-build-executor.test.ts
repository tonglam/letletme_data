import { describe, expect, test } from 'bun:test';

import {
  grokBuildPrompt,
  parseGrokBuildStreamingMessages,
} from '../../../src/content/acquisition/grok-build-executor';
import { compileXKeywordRequest } from '../../../src/content/acquisition/x-query-compiler';

const request = compileXKeywordRequest({
  handles: ['OfficialFPL'],
  windowStart: new Date('2026-08-21T21:00:00.000Z'),
  windowEnd: new Date('2026-08-21T21:15:00.000Z'),
  limit: 2,
});

const finalJson = JSON.stringify({
  posts: [
    {
      postId: '2090909465801371803',
      authorHandle: 'OfficialFPL',
      createdAt: '2026-08-21T21:10:38Z',
      text: 'I prefer not to speak',
      url: 'https://x.com/OfficialFPL/status/2090909465801371803',
    },
  ],
});

function trace(inputOverride?: Record<string, unknown>, duplicateTool = false): string {
  const toolUse = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tool-use-1',
          name: 'X search:',
          input: { variant: 'XSearch', backend: true },
        },
        ...(duplicateTool
          ? [
              {
                type: 'tool_use',
                id: 'tool-use-2',
                name: 'X search:',
                input: { variant: 'XSearch', backend: true },
              },
            ]
          : []),
      ],
      stop_reason: 'tool_use',
    },
  };
  const completion = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-use-1',
          content: JSON.stringify({
            call_id: 'xs_call-1',
            input: JSON.stringify({
              query: request.query,
              limit: String(request.limit),
              mode: request.mode,
              ...inputOverride,
            }),
            name: 'x_keyword_search',
          }),
          is_error: false,
        },
      ],
    },
  };
  const final = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: finalJson }],
      stop_reason: 'end_turn',
    },
  };
  const result = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: finalJson,
    total_cost_usd: 0.01,
    usage: { input_tokens: 100, output_tokens: 20 },
  };
  return [toolUse, completion, final, result].map((event) => JSON.stringify(event)).join('\n');
}

describe('Grok Build single-X-tool executor', () => {
  test('binds one exact tool completion to strict final JSON without claiming raw post evidence', () => {
    const parsed = parseGrokBuildStreamingMessages({ output: trace(), request, durationMs: 123 });
    expect(parsed.toolName).toBe('x_keyword_search');
    expect(parsed.posts).toHaveLength(1);
    expect(parsed.eventCount).toBe(4);
    expect(parsed.rawPostEvidenceAvailable).toBe(false);
    expect(parsed.inputTokens).toBe(100);
    expect(parsed.totalCostUsd).toBe(0.01);
  });

  test('rejects query drift even when the final JSON is valid', () => {
    expect(() =>
      parseGrokBuildStreamingMessages({
        output: trace({ query: 'from:someone-else' }),
        request,
        durationMs: 123,
      }),
    ).toThrow('does not match the persisted request');
  });

  test('rejects a second tool invocation', () => {
    expect(() =>
      parseGrokBuildStreamingMessages({ output: trace(undefined, true), request, durationMs: 123 }),
    ).toThrow('Expected one tool call');
  });

  test('prompts for one exact Build tool and JSON-only output', () => {
    const prompt = grokBuildPrompt(request);
    expect(prompt).toContain('x_keyword_search exactly once');
    expect(prompt).toContain(request.query);
    expect(prompt).toContain('Do not call any other tool');
    expect(prompt).toContain('do not wrap the JSON in markdown');
  });
});
