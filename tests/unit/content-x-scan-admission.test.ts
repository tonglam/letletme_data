import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  parseContentWorkerAdmissionArguments,
  parseContentConsumerModeArguments,
  parseAllowedPausedQueueNames,
  CONTENT_X_SCAN_QUEUE,
  CONTENT_CONSUMER_QUEUE_NAMES,
  DEPLOY_QUEUE_ADMISSION_CAS_ATTEMPTS,
  DEPLOY_QUEUE_ADMISSION_REASON,
  DEPLOY_QUEUE_ADMISSION_TTL_SECONDS,
} from '../../scripts/assert-queue-quiescence';
import { COMPARE_AND_SET_QUEUE_ADMISSION_LUA } from '../../src/services/queue-governance.service';

describe('content-worker deployment admission command', () => {
  function runQueueProbeShell(
    composeBody: string,
    environment: Record<string, string> = {},
  ): ReturnType<typeof Bun.spawnSync> {
    const script = String.raw`
set -euo pipefail
source scripts/deploy-state-machine.sh
compose() {
  ${composeBody}
}
output_file=$(mktemp)
set +e
run_scoped_queue_quiescence_probe "$output_file" 1
result=$?
set -e
printf 'result=%s\n' "$result"
cat "$output_file"
`;
    return Bun.spawnSync(['bash', '-c', script], {
      env: { ...process.env, ...environment },
      stdout: 'pipe',
      stderr: 'pipe',
    });
  }

  function runConsumerStatusProbeShell(composeBody: string): ReturnType<typeof Bun.spawnSync> {
    const script = String.raw`
set -euo pipefail
export DEPLOY_CONTENT_WORKER_PAUSED_QUEUES=content-x-scan
source scripts/deploy-state-machine.sh
compose() {
  ${composeBody}
}
output_file=$(mktemp)
set +e
run_content_worker_consumer_status_probe "$output_file" 1 content-x-scan
result=$?
set -e
printf 'result=%s\n' "$result"
cat "$output_file"
rm -f "$output_file"
`;
    return Bun.spawnSync(['bash', '-c', script], {
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  }

  function runConsumerControlShell(body: string): ReturnType<typeof Bun.spawnSync> {
    const script = String.raw`
set -euo pipefail
event_file=$(mktemp)
pause_dir=$(mktemp -d)
owner_dir=$(mktemp -d)
status_failure_file=$(mktemp)
FAIL_OPEN=false
CONCURRENT_PAUSE_QUEUE=''
REASSERT_AFTER_PAUSE_QUEUE=''
FAIL_PAUSE_AFTER_MARKER_QUEUE=''
FAIL_RESUME_QUEUE=''
FAIL_STATUS_QUEUE=''
FAIL_DRAIN_QUEUE=''
export event_file pause_dir owner_dir status_failure_file FAIL_OPEN CONCURRENT_PAUSE_QUEUE REASSERT_AFTER_PAUSE_QUEUE FAIL_PAUSE_AFTER_MARKER_QUEUE FAIL_RESUME_QUEUE FAIL_STATUS_QUEUE FAIL_DRAIN_QUEUE
trap 'rm -f "$event_file" "$status_failure_file"; rm -rf "$pause_dir" "$owner_dir"' EXIT
source scripts/deploy-state-machine.sh
compose() {
  local args="$*"
  local queue_name=''
  queue_name=$(awk '{ for (i = 1; i <= NF; i += 1) if ($i == "--consumer-queue") print $(i + 1) }' <<<"$args")
  local pause_file="$pause_dir/$queue_name"
  local owner_file="$owner_dir/$queue_name"
  local owner='NONE'
  [[ -e "$owner_file" ]] && owner=$(<"$owner_file")
  if [[ "$args" == *"--consumer-mode STATUS"* ]]; then
    if [[ "$queue_name" = "$FAIL_STATUS_QUEUE" && -e "$status_failure_file" ]]; then
      printf 'STATUS-FAILED:%s\n' "$queue_name" >>"$event_file"
      return 1
    fi
    local paused=false
    [[ -e "$pause_file" ]] && paused=true
    printf 'STATUS:%s\n' "$queue_name" >>"$event_file"
    local owned=false
    [[ "$owner" = deployment || "$owner" = acquiring ]] && owned=true
    printf '{"contractVersion":"content-worker-consumer-v1","queueName":"%s","paused":%s,"owner":"%s","owned":%s,"released":false}\n' "$queue_name" "$paused" "$owner" "$owned"
    return 0
  fi
  if [[ "$args" == *"--consumer-mode PAUSE"* ]]; then
    local previous_paused=false
    [[ -e "$pause_file" ]] && previous_paused=true
    if [[ "$queue_name" = "$FAIL_PAUSE_AFTER_MARKER_QUEUE" && "$previous_paused" = false ]]; then
      touch "$pause_file"
      printf '%s\n' acquiring >"$owner_file"
      printf 'PAUSE-FAILED-AFTER-MARKER:%s\n' "$queue_name" >>"$event_file"
      return 1
    fi
    if [[ "$queue_name" = "$CONCURRENT_PAUSE_QUEUE" && "$previous_paused" = false ]]; then
      touch "$pause_file"
      printf '%s\n' operator >"$owner_file"
      printf 'PAUSE-RACE:%s\n' "$queue_name" >>"$event_file"
      printf '{"contractVersion":"content-worker-consumer-v1","queueName":"%s","previousPaused":true,"paused":true,"changed":false,"owner":"OPERATOR","owned":false,"released":false}\n' "$queue_name"
      return 0
    fi
    touch "$pause_file"
    if [[ "$owner" = operator ]]; then
      printf '{"contractVersion":"content-worker-consumer-v1","queueName":"%s","previousPaused":%s,"paused":true,"changed":%s,"owner":"OPERATOR","owned":false,"released":false}\n' "$queue_name" "$previous_paused" "$([[ "$previous_paused" = false ]] && echo true || echo false)"
      return 0
    fi
    printf '%s\n' deployment >"$owner_file"
    printf 'PAUSE:%s\n' "$queue_name" >>"$event_file"
    printf '{"contractVersion":"content-worker-consumer-v1","queueName":"%s","previousPaused":%s,"paused":true,"changed":%s,"owner":"DEPLOYMENT","owned":true,"released":false}\n' "$queue_name" "$previous_paused" "$([[ "$previous_paused" = false ]] && echo true || echo false)"
    if [[ "$queue_name" = "$REASSERT_AFTER_PAUSE_QUEUE" ]]; then
      printf '%s\n' operator >"$owner_file"
    fi
    return 0
  fi
  if [[ "$args" == *"--consumer-mode RESUME"* ]]; then
    if [[ "$queue_name" = "$FAIL_RESUME_QUEUE" ]]; then
      printf 'RESUME-FAILED:%s\n' "$queue_name" >>"$event_file"
      return 1
    fi
    if [[ "$owner" = operator ]]; then
      printf 'RESUME-PRESERVED:%s\n' "$queue_name" >>"$event_file"
      printf '{"contractVersion":"content-worker-consumer-v1","queueName":"%s","previousPaused":true,"paused":true,"changed":false,"owner":"OPERATOR","owned":false,"released":false}\n' "$queue_name"
      return 0
    fi
    rm -f "$pause_file"
    rm -f "$owner_file"
    printf 'RESUME:%s\n' "$queue_name" >>"$event_file"
    printf '{"contractVersion":"content-worker-consumer-v1","queueName":"%s","previousPaused":true,"paused":false,"changed":true,"owner":"NONE","owned":true,"released":true}\n' "$queue_name"
    return 0
  fi
  if [[ "$args" == *"--admission-mode DRAIN_ONLY"* || "$args" == *"--admission-mode OPEN"* ]]; then
    [[ "$FAIL_OPEN" = true ]] && return 1
    local admission_mode='DRAIN_ONLY'
    [[ "$args" == *"--admission-mode OPEN"* ]] && admission_mode=OPEN
    local admission_queue=''
    admission_queue=$(awk '{ for (i = 1; i <= NF; i += 1) if ($i == "--admission-queue") print $(i + 1) }' <<<"$args")
    if [[ -z "$admission_queue" ]]; then
      admission_queue=content-x-scan
    fi
    if [[ "$admission_mode" = DRAIN_ONLY && "$admission_queue" = "$FAIL_DRAIN_QUEUE" ]]; then
      printf 'DRAIN-FAILED:%s\n' "$admission_queue" >>"$event_file"
      return 1
    fi
    printf '%s:%s\n' "$admission_mode" "$admission_queue" >>"$event_file"
    printf '%s\n' "{\"contractVersion\":\"queue-admission-v2\",\"queueName\":\"$admission_queue\",\"mode\":\"$admission_mode\",\"changed\":true}"
    return 0
  fi
  return 1
}
${body}
cat "$event_file"
`;
    return Bun.spawnSync(['bash', '-c', script], {
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  }

  test('pins the queue and bounded deployment TTL', () => {
    expect(CONTENT_X_SCAN_QUEUE).toBe('content-x-scan');
    expect(DEPLOY_QUEUE_ADMISSION_TTL_SECONDS).toBe(900);
    expect(DEPLOY_QUEUE_ADMISSION_REASON).toBe('DEPLOY_QUEUE_QUIESCENCE');
    expect(DEPLOY_QUEUE_ADMISSION_CAS_ATTEMPTS).toBe(3);
  });

  test('uses an exact Redis CAS for deployment ownership and restoration', () => {
    const command = readFileSync('scripts/assert-queue-quiescence.ts', 'utf8');
    expect(command).toContain('compareAndSetQueueAdmission');
    expect(command).not.toContain('setQueueAdmission');
    expect(COMPARE_AND_SET_QUEUE_ADMISSION_LUA).toContain('current ~= expected');
    expect(COMPARE_AND_SET_QUEUE_ADMISSION_LUA).toContain('expected ==');
    expect(COMPARE_AND_SET_QUEUE_ADMISSION_LUA).toContain('EX');
  });

  test('parses both supported admission modes', () => {
    expect(parseContentWorkerAdmissionArguments(['--admission-mode', 'DRAIN_ONLY'])).toEqual({
      mode: 'DRAIN_ONLY',
      queueName: 'content-x-scan',
    });
    expect(parseContentWorkerAdmissionArguments(['--admission-mode=OPEN'])).toEqual({
      mode: 'OPEN',
      queueName: 'content-x-scan',
    });
  });

  test('parses a specific content-worker admission queue', () => {
    expect(
      parseContentWorkerAdmissionArguments([
        '--admission-mode',
        'DRAIN_ONLY',
        '--admission-queue',
        'content-media-transcript',
      ]),
    ).toEqual({ mode: 'DRAIN_ONLY', queueName: 'content-media-transcript' });
    expect(() =>
      parseContentWorkerAdmissionArguments([
        '--admission-mode',
        'OPEN',
        '--admission-queue',
        'unknown',
      ]),
    ).toThrow();
  });

  test('parses the explicit consumer pause protocol', () => {
    expect(
      parseContentConsumerModeArguments([
        '--consumer-mode',
        'STATUS',
        '--consumer-queue',
        'content-x-scan',
      ]),
    ).toEqual({
      mode: 'STATUS',
      queueName: 'content-x-scan',
    });
    expect(
      parseContentConsumerModeArguments([
        '--consumer-mode=PAUSE',
        '--consumer-queue=content-http-acquisition',
      ]),
    ).toEqual({
      mode: 'PAUSE',
      queueName: 'content-http-acquisition',
    });
    expect(
      parseContentConsumerModeArguments([
        '--consumer-mode',
        'RESUME',
        '--consumer-queue',
        'content-media-transcript',
      ]),
    ).toEqual({
      mode: 'RESUME',
      queueName: 'content-media-transcript',
    });
    expect(CONTENT_CONSUMER_QUEUE_NAMES).toEqual([
      'content-http-acquisition',
      'content-media-transcript',
      'content-x-scan',
    ]);
  });

  test('parses and bounds the deployment paused-queue allowlist', () => {
    expect(parseAllowedPausedQueueNames(' content-x-scan, content-http-acquisition ')).toEqual([
      'content-x-scan',
      'content-http-acquisition',
    ]);
    expect(() => parseAllowedPausedQueueNames('content-x-scan,content-x-scan')).toThrow(
      'Duplicate deployment paused queue name',
    );
    expect(() => parseAllowedPausedQueueNames('content-x-scan,unknown')).toThrow(
      'Invalid deployment paused queue name',
    );
  });

  test('restores owned consumer pauses before opening admission', () => {
    const result = runConsumerControlShell(String.raw`
pause_content_worker_consumers_for_deploy
drain_content_worker_queues_for_deploy
    restore_content_deploy_controls
[[ ! -e "$pause_dir/content-x-scan" ]]
[[ ! -e "$pause_dir/content-http-acquisition" ]]
[[ ! -e "$pause_dir/content-media-transcript" ]]
[[ -z "$DEPLOY_CONTENT_WORKER_OWNED_PAUSED_QUEUES" ]]
`);
    expect(
      result.exitCode,
      `${result.stderr?.toString() ?? ''}\n${result.stdout?.toString() ?? ''}`,
    ).toBe(0);
    const stdout = result.stdout?.toString() ?? '';
    expect(stdout).toContain('STATUS:content-x-scan');
    expect(stdout).toContain('PAUSE:content-x-scan');
    expect(stdout).toContain('STATUS:content-http-acquisition');
    expect(stdout).toContain('PAUSE:content-http-acquisition');
    expect(stdout).toContain('STATUS:content-media-transcript');
    expect(stdout).toContain('PAUSE:content-media-transcript');
    expect(stdout).toContain('OPEN:content-x-scan');
    expect(stdout).toContain('RESUME:content-x-scan');
    expect(stdout).toContain('RESUME:content-http-acquisition');
    expect(stdout).toContain('RESUME:content-media-transcript');
    expect(stdout.lastIndexOf('RESUME:content-media-transcript')).toBeLessThan(
      stdout.indexOf('OPEN:content-x-scan'),
    );
  });

  test('renews each deployment-owned control before long stages', () => {
    const result = runConsumerControlShell(String.raw`
DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_INTERVAL_SECONDS=1
pause_content_worker_consumers_for_deploy
drain_content_worker_queues_for_deploy
start_content_worker_pause_renewal
sleep 2
restore_content_deploy_controls
[[ -z "$DEPLOY_CONTENT_WORKER_OWNED_PAUSED_QUEUES" ]]
`);
    expect(result.exitCode).toBe(0);
    const stdout = result.stdout?.toString() ?? '';
    for (const queueName of CONTENT_CONSUMER_QUEUE_NAMES) {
      expect(stdout.match(new RegExp(`STATUS:${queueName}`, 'g'))?.length).toBeGreaterThanOrEqual(
        2,
      );
      expect(
        stdout.match(new RegExp(`DRAIN_ONLY:${queueName}`, 'g'))?.length,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  test('restores partial control mutations before services stop', () => {
    const result = runConsumerControlShell(String.raw`
FAIL_DRAIN_QUEUE=content-http-acquisition
export FAIL_DRAIN_QUEUE
pause_content_worker_consumers_for_deploy
if drain_content_worker_queues_for_deploy; then exit 1; fi
restore_content_deploy_controls
[[ ! -e "$pause_dir/content-x-scan" ]]
[[ ! -e "$pause_dir/content-http-acquisition" ]]
[[ ! -e "$pause_dir/content-media-transcript" ]]
[[ -z "$DEPLOY_CONTENT_WORKER_ADMISSION_ATTEMPTED_QUEUES" ]]
`);
    expect(result.exitCode).toBe(0);
    const stdout = result.stdout?.toString() ?? '';
    expect(stdout).toContain('DRAIN-FAILED:content-http-acquisition');
    expect(stdout).toContain('OPEN:content-x-scan');
    expect(stdout).not.toContain('OPEN:content-media-transcript');
  });

  test('fails closed when pause ownership renewal fails', () => {
    const result = runConsumerControlShell(String.raw`
DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_INTERVAL_SECONDS=1
FAIL_STATUS_QUEUE=content-x-scan
export FAIL_STATUS_QUEUE
pause_content_worker_consumers_for_deploy
start_content_worker_pause_renewal
touch "$status_failure_file"
sleep 3
`);
    expect(
      result.exitCode,
      `${result.stderr?.toString() ?? ''}\n${result.stdout?.toString() ?? ''}`,
    ).toBe(1);
  });

  test('interrupts a long deployment stage when renewal fails', () => {
    const startedAt = Date.now();
    const script = String.raw`
set -euo pipefail
source scripts/deploy-state-machine.sh
DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_INTERVAL_SECONDS=1
DEPLOY_CONTENT_WORKER_OWNED_PAUSED_QUEUES=content-x-scan
renew_content_worker_pause_ownership() { return 1; }
compose_direct() {
  trap ':' TERM
  while :; do sleep 1; done
}
start_content_worker_pause_renewal
DEPLOY_CONTENT_WORKER_PAUSE_RENEWAL_GUARD_ACTIVE=true
run_deploy_command_with_pause_renewal compose_direct
`;
    const result = Bun.spawnSync(['bash', '-c', script], {
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const elapsedMs = Date.now() - startedAt;
    expect(result.exitCode, result.stderr?.toString() ?? '').toBe(1);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  test('preserves an externally paused consumer', () => {
    const result = runConsumerControlShell(String.raw`
touch "$pause_dir/content-x-scan"
pause_content_worker_consumers_for_deploy
restore_content_deploy_controls
[[ -e "$pause_dir/content-x-scan" ]]
`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.toString() ?? '').toContain('STATUS');
    expect(result.stdout?.toString() ?? '').not.toContain('RESUME:content-x-scan');
  });

  test('does not claim ownership when an operator pauses after STATUS', () => {
    const result = runConsumerControlShell(String.raw`
CONCURRENT_PAUSE_QUEUE=content-http-acquisition
pause_content_worker_consumers_for_deploy
restore_content_deploy_controls
[[ -e "$pause_dir/content-http-acquisition" ]]
[[ "$DEPLOY_CONTENT_WORKER_OWNED_PAUSED_QUEUES" != *content-http-acquisition* ]]
`);
    expect(result.exitCode).toBe(0);
    const stdout = result.stdout?.toString() ?? '';
    expect(stdout).toContain('PAUSE-RACE:content-http-acquisition');
    expect(stdout).not.toContain('RESUME:content-http-acquisition');
  });

  test('does not resume a deployment pause reasserted by an operator', () => {
    const result = runConsumerControlShell(String.raw`
REASSERT_AFTER_PAUSE_QUEUE=content-http-acquisition
pause_content_worker_consumers_for_deploy
restore_content_deploy_controls
[[ -e "$pause_dir/content-http-acquisition" ]]
[[ "$DEPLOY_CONTENT_WORKER_OWNED_PAUSED_QUEUES" != *content-http-acquisition* ]]
`);
    expect(result.exitCode).toBe(0);
    const stdout = result.stdout?.toString() ?? '';
    expect(stdout).toContain('RESUME-PRESERVED:content-http-acquisition');
    expect(stdout).not.toContain('RESUME:content-http-acquisition');
  });

  test('reconciles a pause marker when the control probe fails after BullMQ pause', () => {
    const result = runConsumerControlShell(String.raw`
FAIL_PAUSE_AFTER_MARKER_QUEUE=content-x-scan
if pause_content_worker_consumers_for_deploy; then exit 1; fi
restore_content_deploy_controls
[[ ! -e "$pause_dir/content-x-scan" ]]
[[ "$DEPLOY_CONTENT_WORKER_OWNED_PAUSED_QUEUES" != *content-x-scan* ]]
`);
    expect(result.exitCode).toBe(0);
    const stdout = result.stdout?.toString() ?? '';
    expect(stdout).toContain('PAUSE-FAILED-AFTER-MARKER:content-x-scan');
    expect(stdout).toContain('reconciled content-x-scan consumer pause');
    expect(stdout).toContain('RESUME:content-x-scan');
  });

  test('keeps producer admission closed when admission restoration fails', () => {
    const result = runConsumerControlShell(String.raw`
pause_content_worker_consumers_for_deploy
drain_content_worker_queues_for_deploy
export FAIL_OPEN=true
if restore_content_deploy_controls; then exit 1; fi
[[ ! -e "$pause_dir/content-x-scan" ]]
[[ ! -e "$pause_dir/content-http-acquisition" ]]
[[ ! -e "$pause_dir/content-media-transcript" ]]
`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.toString() ?? '').toContain('RESUME');
    expect(result.stdout?.toString() ?? '').not.toContain('OPEN');
  });

  test('keeps producer admission closed when consumer restoration fails', () => {
    const result = runConsumerControlShell(String.raw`
pause_content_worker_consumers_for_deploy
drain_content_worker_queues_for_deploy
FAIL_RESUME_QUEUE=content-x-scan
export FAIL_RESUME_QUEUE
if restore_content_deploy_controls; then exit 1; fi
[[ -e "$pause_dir/content-x-scan" ]]
[[ -e "$pause_dir/content-http-acquisition" ]]
[[ -e "$pause_dir/content-media-transcript" ]]
! grep -F 'OPEN' "$event_file"
`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.toString() ?? '').toContain('RESUME-FAILED:content-x-scan');
    expect(result.stdout?.toString() ?? '').not.toContain('OPEN');
  });

  test('rejects unknown, missing, repeated and invalid arguments', () => {
    for (const argv of [
      [],
      ['--unknown', 'OPEN'],
      ['--admission-mode'],
      ['--admission-mode', 'DRAIN_ONLY', '--admission-mode', 'OPEN'],
      ['--admission-mode', 'drain-only'],
      ['--admission-mode=DRAIN_ONLY', 'extra'],
    ]) {
      expect(() => parseContentWorkerAdmissionArguments(argv)).toThrow();
    }
  });

  test('bounds TERM-ignoring probes with a KILL cleanup', () => {
    const startedAt = Date.now();
    const result = runQueueProbeShell(String.raw`trap ':' TERM; sleep 30`);
    const elapsedMs = Date.now() - startedAt;
    const stdout = result.stdout?.toString() ?? '';
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('result=124');
    expect(stdout).toContain('queue probe timed out after 1s');
    expect(elapsedMs).toBeLessThan(5_000);
  });

  test('kills a TERM-ignoring descendant after the probe leader exits', () => {
    const startedAt = Date.now();
    const script = String.raw`
set -euo pipefail
probe_child_pid_file=$(mktemp)
trap 'rm -f "$probe_child_pid_file"' EXIT
source scripts/deploy-state-machine.sh
compose() {
  (trap ':' TERM; while :; do sleep 1; done) &
  child_pid=$!
  printf '%s\n' "$child_pid" >"$probe_child_pid_file"
  trap 'exit 0' TERM
  wait "$child_pid"
}
output_file=$(mktemp)
set +e
run_scoped_queue_quiescence_probe "$output_file" 1
result=$?
set -e
child_pid=$(<"$probe_child_pid_file")
if kill -0 "$child_pid" 2>/dev/null; then
  echo child-alive
  kill -KILL "$child_pid" 2>/dev/null || true
else
  echo child-dead
fi
printf 'result=%s\n' "$result"
cat "$output_file"
rm -f "$output_file"
`;
    const result = Bun.spawnSync(['bash', '-c', script], {
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const elapsedMs = Date.now() - startedAt;
    expect(result.exitCode).toBe(0);
    const stdout = result.stdout?.toString() ?? '';
    expect(stdout).toContain('result=124');
    expect(stdout).toContain('child-dead');
    expect(elapsedMs).toBeLessThan(7_000);
  });

  test('bounds content-x-scan admission control calls', () => {
    const startedAt = Date.now();
    const script = String.raw`
set -euo pipefail
source scripts/deploy-state-machine.sh
compose() {
  trap ':' TERM
  sleep 30
}
set +e
set_content_worker_queue_admission content-x-scan DRAIN_ONLY
result=$?
set -e
printf 'result=%s\n' "$result"
`;
    const result = Bun.spawnSync(['bash', '-c', script], {
      env: {
        ...process.env,
        DEPLOY_CONTENT_WORKER_ADMISSION_CONTROL_TIMEOUT_SECONDS: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const elapsedMs = Date.now() - startedAt;
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.toString() ?? '').toContain('result=1');
    expect(result.stderr?.toString() ?? '').toContain('admission probe timed out after 1s');
    expect(elapsedMs).toBeLessThan(7_000);
  });

  test('keeps a successful scoped probe successful', () => {
    const result = runQueueProbeShell('return 0');
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.toString() ?? '').toContain('result=0');
  });

  test('passes only the deployment-paused queue allowlist to the bounded probe', () => {
    const result = runQueueProbeShell(
      String.raw`
[[ "$DEPLOY_QUIESCENCE_ALLOW_PAUSED_QUEUES" = content-x-scan,content-http-acquisition ]]
return 0`,
      { DEPLOY_CONTENT_WORKER_PAUSED_QUEUES: 'content-x-scan content-http-acquisition' },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.toString() ?? '').toContain('result=0');
  });

  test('bounds consumer status checks with the same process-group deadline', () => {
    const startedAt = Date.now();
    const result = runConsumerStatusProbeShell(String.raw`trap ':' TERM; sleep 30`);
    const elapsedMs = Date.now() - startedAt;
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.toString() ?? '').toContain('result=124');
    expect(elapsedMs).toBeLessThan(5_000);
  });

  test('preserves the local Compose context in a setsid probe', () => {
    const script = String.raw`
set -euo pipefail
PROJECT_DIR=/tmp/letletme-data-compose-context
COMPOSE_FILE=compose.production.yml
COMPOSE_BIN='compose-wrapper --project-name letletme-data'
IFS=' ' read -r -a COMPOSE_CMD <<<"$COMPOSE_BIN"
export APP_IMAGE=letletme-data:test
source scripts/deploy-state-machine.sh
compose() {
  [[ "$PROJECT_DIR" == /tmp/letletme-data-compose-context ]]
  [[ "$COMPOSE_FILE" == compose.production.yml ]]
  [[ "$COMPOSE_BIN" == 'compose-wrapper --project-name letletme-data' ]]
  [[ "\${COMPOSE_CMD[*]}" == 'compose-wrapper --project-name letletme-data' ]]
  [[ "$APP_IMAGE" == letletme-data:test ]]
  return 0
}
output_file=$(mktemp)
set +e
run_scoped_queue_quiescence_probe "$output_file" 1
result=$?
set -e
printf 'result=%s\n' "$result"
cat "$output_file"
`;
    const result = Bun.spawnSync(['bash', '-c', script], {
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.toString() ?? '').toContain('result=0');
  });
});
