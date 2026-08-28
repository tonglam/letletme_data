#!/usr/bin/env bash

# Shared safety and atomic-update primitives for managed environment files.
# The callers remain responsible for parsing their own key/value contracts.

managed_env_file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

managed_env_file_uid() {
  stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1"
}

managed_env_file_gid() {
  stat -c '%g' "$1" 2>/dev/null || stat -f '%g' "$1"
}

managed_env_file_links() {
  stat -c '%h' "$1" 2>/dev/null || stat -f '%l' "$1"
}

managed_env_require_regular_file() {
  local path=${1:-}
  local label=${2:-file}
  if [[ -z "$path" || ! -f "$path" || -L "$path" ]]; then
    printf '%s must be an existing regular file (not a regular file or symlink)\n' "$label" >&2
    return 1
  fi
}

managed_env_assert_secure_file() {
  local path=${1:-}
  local label=${2:-file}
  local expected_mode=${3:-}
  local mode uid gid links mode_value

  managed_env_require_regular_file "$path" "$label" || return 1
  mode=$(managed_env_file_mode "$path")
  uid=$(managed_env_file_uid "$path")
  gid=$(managed_env_file_gid "$path")
  links=$(managed_env_file_links "$path")
  mode_value=$((8#$mode))

  if (( (mode_value & 077) != 0 )); then
    printf '%s must not be group/world accessible\n' "$label" >&2
    return 1
  fi
  if [[ -n "$expected_mode" && "$mode" != "$expected_mode" ]]; then
    printf '%s replacement mode does not match the target\n' "$label" >&2
    return 1
  fi
  if [[ "$links" != 1 ]]; then
    printf '%s must have exactly one hard link\n' "$label" >&2
    return 1
  fi
  if [[ "$uid" != "$(id -u)" || "$gid" != "$(id -g)" ]]; then
    printf '%s must be owned by the current user\n' "$label" >&2
    return 1
  fi
}

managed_env_capture_target() {
  local path=${1:-}
  local label=${2:-file}

  managed_env_assert_secure_file "$path" "$label" || return 1
  MANAGED_ENV_TARGET_PATH=$path
  MANAGED_ENV_TARGET_MODE=$(managed_env_file_mode "$path")
  MANAGED_ENV_TARGET_UID=$(managed_env_file_uid "$path")
  MANAGED_ENV_TARGET_GID=$(managed_env_file_gid "$path")
  MANAGED_ENV_TARGET_LINKS=$(managed_env_file_links "$path")
}

managed_env_assert_target_unchanged() {
  local path=${1:-}
  local label=${2:-file}
  local mode uid gid links

  if [[ "${MANAGED_ENV_TARGET_PATH:-}" != "$path" ]]; then
    printf '%s target metadata was not captured before replacement\n' "$label" >&2
    return 1
  fi
  managed_env_require_regular_file "$path" "$label" || return 1
  mode=$(managed_env_file_mode "$path")
  uid=$(managed_env_file_uid "$path")
  gid=$(managed_env_file_gid "$path")
  links=$(managed_env_file_links "$path")
  if [[ "$mode" != "${MANAGED_ENV_TARGET_MODE:-}" ||
    "$uid" != "${MANAGED_ENV_TARGET_UID:-}" ||
    "$gid" != "${MANAGED_ENV_TARGET_GID:-}" ||
    "$links" != "${MANAGED_ENV_TARGET_LINKS:-}" ]]; then
    printf '%s changed while preparing a replacement\n' "$label" >&2
    return 1
  fi
}

managed_env_assert_temp_metadata() {
  local path=${1:-}
  local label=${2:-replacement file}

  managed_env_assert_secure_file "$path" "$label" "${MANAGED_ENV_TARGET_MODE:-}" || return 1
  if [[ "$(managed_env_file_uid "$path")" != "${MANAGED_ENV_TARGET_UID:-}" ||
    "$(managed_env_file_gid "$path")" != "${MANAGED_ENV_TARGET_GID:-}" ||
    "$(managed_env_file_links "$path")" != "${MANAGED_ENV_TARGET_LINKS:-}" ]]; then
    printf '%s metadata does not match the target\n' "$label" >&2
    return 1
  fi
}

managed_env_atomic_replace() {
  local source=${1:-}
  local target=${2:-}
  local label=${3:-managed env file}

  managed_env_assert_target_unchanged "$target" "$label" || return 1
  managed_env_assert_temp_metadata "$source" "$label replacement" || return 1

  # The temporary file is created beside the target, so rename is atomic.
  # A failed rename leaves the original target untouched.
  if ! mv -f "$source" "$target"; then
    printf '%s replacement failed; original file was retained\n' "$label" >&2
    return 1
  fi
}

managed_env_no_target_mv() {
  if mv --help 2>&1 | grep -q -- '--no-target-directory'; then
    printf '%s\n' mv
    return 0
  fi
  if command -v gmv >/dev/null 2>&1 && gmv --help 2>&1 | grep -q -- '--no-target-directory'; then
    command -v gmv
    return 0
  fi
  return 1
}

managed_env_atomic_create() {
  local source=${1:-}
  local target=${2:-}
  local label=${3:-managed env file}
  local mv_command

  managed_env_assert_secure_file "$source" "$label temporary" || return 1
  if [[ -e "$target" || -L "$target" ]]; then
    printf '%s target already exists or is a symlink\n' "$label" >&2
    return 1
  fi

  # GNU mv -nT gives a no-clobber atomic create. BSD/macOS has no -T; the
  # hard-link fallback has the same no-clobber property on the same filesystem.
  if mv_command=$(managed_env_no_target_mv); then
    if ! "$mv_command" -nT "$source" "$target"; then
      printf '%s create failed; source file was retained\n' "$label" >&2
      return 1
    fi
    if [[ -e "$source" || -L "$source" ]]; then
      printf '%s target appeared concurrently; source file was retained\n' "$label" >&2
      return 1
    fi
  else
    if ! ln "$source" "$target"; then
      printf '%s create failed; source file was retained\n' "$label" >&2
      return 1
    fi
    if ! rm -f "$source"; then
      printf '%s temporary cleanup failed after atomic create\n' "$label" >&2
      return 1
    fi
  fi

  managed_env_require_regular_file "$target" "$label target" || return 1
}
