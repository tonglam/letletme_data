#!/bin/sh

set -eu

case "${FAKE_GROK_MODE:-normal}" in
  require-skill)
    test -f .grok/skills/monitor-fpl-x-sources/SKILL.md
    test -f .grok/skills/monitor-fpl-x-sources/schemas/input.schema.json
    test -f .grok/skills/monitor-fpl-x-sources/references/taxonomy.md
    printf '%s\n' '{"type":"tool_call_start","tool":"x_search","call_id":"x-1"}' '{"type":"tool_result","tool":"x_search","call_id":"x-1","status":"COMPLETED","result":{}}' '{"status":"COMPLETED","receipts":[]}'
    ;;
  normal)
    printf '%s\n' '{"type":"tool_call_start","tool":"x_search","call_id":"x-1"}' '{"type":"tool_result","tool":"x_search","call_id":"x-1","status":"COMPLETED","result":{}}' '{"status":"COMPLETED","receipts":[]}'
    ;;
  utf8-split)
    printf '%s\n' '{"type":"tool_call_start","tool":"x_search","call_id":"x-1"}' '{"type":"tool_result","tool":"x_search","call_id":"x-1","status":"COMPLETED","result":{}}'
    printf '%s' '{"status":"COMPLETED","receipts":[{"sourceId":"550e8400-e29b-41d4-a716-446655440000","externalId":"post-utf8","canonicalUrl":"https://example.com/post-utf8","capturedAt":"2026-08-20T09:00:00.000Z","canonicalHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","payload":{"headline":"'
    printf '\360'
    sleep 0.01
    printf '\237\230\200'
    printf '%s\n' '"}}]}'
    ;;
  no-trace)
    printf '%s\n' '{"status":"COMPLETED","receipts":[]}'
    ;;
  false-positive)
    printf '%s\n' '{"type":"assistant","content":"completed an x_search call"}' '{"type":"tool_call","tool":"bash"}' '{"status":"COMPLETED","receipts":[]}'
    ;;
  failed-x)
    printf '%s\n' '{"type":"tool_call_start","tool":"x_search","call_id":"x-1"}' '{"type":"tool_result","tool":"x_search","call_id":"x-1","status":"FAILED","error":"upstream unavailable"}' '{"status":"COMPLETED","receipts":[]}'
    ;;
  invalid-receipt)
    printf '%s\n' '{"type":"tool_call_start","tool":"x_search","call_id":"x-1"}' '{"type":"tool_result","tool":"x_search","call_id":"x-1","status":"COMPLETED","result":{}}' '{"status":"COMPLETED","receipts":[{"sourceId":"550e8400-e29b-41d4-a716-446655440000","externalId":"post-1","canonicalUrl":"https://example.com/post-1","capturedAt":"2026-08-20T09:00:00.000Z","canonicalHash":"not-a-sha"}]}'
    ;;
  invalid-json)
    printf '%s\n' 'not-json'
    ;;
  auth-expired)
    printf '%s\n' '{"status":"FAILED","error":"auth expired","receipts":[]}'
    ;;
  timeout)
    sleep 2
    ;;
  oversized)
    dd if=/dev/zero bs=1048576 count=3 2>/dev/null
    ;;
  *)
    printf '%s\n' '{"status":"FAILED","error":"unknown fixture mode","receipts":[]}'
    ;;
esac
