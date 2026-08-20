#!/bin/sh

set -eu

case "${FAKE_GROK_MODE:-normal}" in
  normal)
    printf '%s\n' '{"type":"tool_call","tool":"x_search"}' '{"status":"COMPLETED","receipts":[]}'
    ;;
  no-trace)
    printf '%s\n' '{"status":"COMPLETED","receipts":[]}'
    ;;
  false-positive)
    printf '%s\n' '{"type":"assistant","content":"completed an x_search call"}' '{"type":"tool_call","tool":"bash"}' '{"status":"COMPLETED","receipts":[]}'
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
