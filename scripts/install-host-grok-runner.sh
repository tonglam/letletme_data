#!/usr/bin/env bash

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo 'must run as root' >&2
  exit 1
fi

group_name=letletme-grok-bridge
group_gid=1555
if getent group "$group_name" >/dev/null; then
  test "$(getent group "$group_name" | cut -d: -f3)" = "$group_gid"
else
  groupadd --system --gid "$group_gid" "$group_name"
fi

test -d /home/deploy
if ! test -x /usr/bin/bwrap && ! test -x /bin/bwrap; then
  echo 'bubblewrap is required before installing the host Grok runner' >&2
  exit 1
fi
test -x /home/deploy/.grok/bin/grok
install -d -o deploy -g "$group_name" -m 0750 /home/workspace/letletme-grok-runner
install -d -o deploy -g "$group_name" -m 0750 /home/deploy/.grok
install -o root -g root -m 0644 \
  "$(dirname "$0")/../deploy/letletme-grok-runner.service" \
  /etc/systemd/system/letletme-grok-runner.service
systemctl daemon-reload
systemctl enable letletme-grok-runner.service
if test -x /home/workspace/letletme-grok-runner/current; then
  systemctl restart letletme-grok-runner.service
  systemctl --no-pager --full status letletme-grok-runner.service
else
  echo 'host Grok runner unit installed and enabled; deploy a compiled release before starting it'
fi
