#!/usr/bin/env bash

set -euo pipefail

image_ref=${1:-}
release_sha=${2:-}
release_root=${3:-/home/workspace/letletme-grok-runner}

if [[ -z "$image_ref" || ! "$release_sha" =~ ^[0-9a-f]{7,128}$ ]]; then
  echo 'usage: deploy-host-grok-runner.sh IMAGE_REF RELEASE_SHA [RELEASE_ROOT]' >&2
  exit 2
fi

test -n "$(docker image inspect "$image_ref" --format '{{.Id}}')"
mkdir -p "$release_root/releases"
release_path="$release_root/releases/$release_sha"
temporary_path="$release_root/.runner.$$.tmp"
previous_target=$(readlink -f "$release_root/current" 2>/dev/null || true)
previous_release=$(cat "$release_root/current.release" 2>/dev/null || printf unknown)
previous_release=${previous_release:-unknown}
if [[ -n "$previous_target" && "$previous_target" != "$release_root/releases/"* ]]; then
  echo 'refusing to restore a runner target outside the release root' >&2
  exit 1
fi
if [[ "$previous_release" != unknown && ! "$previous_release" =~ ^[0-9a-f]{7,128}$ ]]; then
  echo 'refusing to restore an invalid runner release SHA' >&2
  exit 1
fi
cleanup() { rm -f -- "$temporary_path"; }
rollback_on_failure() {
  original_status=$?
  trap - EXIT
  set +e
  cleanup
  if [ "$original_status" -ne 0 ]; then
    if [ -n "$previous_target" ] && test -x "$previous_target"; then
      ln -sfn "$previous_target" "$release_root/current"
      printf '%s\n' "$previous_release" >"$release_root/current.release"
      chmod 0640 "$release_root/current.release"
      sudo systemctl restart letletme-grok-runner.service || true
    else
      rm -f -- "$release_root/current" "$release_root/current.release"
      sudo systemctl stop letletme-grok-runner.service || true
    fi
  fi
  exit "$original_status"
}
trap rollback_on_failure EXIT

docker run --rm --entrypoint cat "$image_ref" /app/letletme-grok-runner >"$temporary_path"
chmod 0750 "$temporary_path"
test -s "$temporary_path"
artifact_sha=$(sha256sum "$temporary_path" | awk '{print $1}')
[[ "$artifact_sha" =~ ^[0-9a-f]{64}$ ]]
run_as_deploy() {
  if [[ "$(id -un)" == deploy ]]; then
    env "$@"
  else
    sudo -u deploy -H env "$@"
  fi
}
run_as_deploy \
  HOME=/home/deploy \
  GROK_HOME=/home/deploy/.grok \
  GROK_NO_AUTO_UPDATE=1 \
  CONTENT_GROK_EXPECTED_VERSION=${CONTENT_GROK_EXPECTED_VERSION:-1.0.5} \
  "$temporary_path" --self-test >/dev/null
mv "$temporary_path" "$release_path"
printf '%s  %s\n' "$artifact_sha" "$release_path" >"$release_path.sha256"
sha256sum --check "$release_path.sha256" --status
ln -sfn "$release_path" "$release_root/current"
printf '%s\n' "$release_sha" >"$release_root/current.release"
chmod 0640 "$release_root/current.release"
sudo systemctl restart letletme-grok-runner.service
sudo systemctl is-active --quiet letletme-grok-runner.service

health=$(curl --silent --show-error \
  --unix-socket /run/letletme-grok-runner/runner.sock \
  http://localhost/v1/health)
printf '%s\n' "$health"
printf '%s' "$health" | jq -e \
  --arg sha "$release_sha" \
  '.ok == true and .runnerReleaseSha == $sha and .grokVersion == "1.0.5" and .sandbox == "strict"' \
  >/dev/null
trap - EXIT
cleanup
