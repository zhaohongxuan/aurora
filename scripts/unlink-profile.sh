#!/usr/bin/env bash
# Remove Aurora packages from a dsh profile and delete their local state.
#
# Usage: scripts/unlink-profile.sh [profile] [package...]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${1:-${DSH_PROFILE:-web}}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
DSH_BIN="${DSH_BIN:-$(command -v dsh || true)}"

[ -d "$PROFILE_DIR" ] || { echo "no profile at $PROFILE_DIR" >&2; exit 1; }
[ -n "$DSH_BIN" ] || { echo "dsh is not on PATH (set DSH_BIN=/path/to/dsh)" >&2; exit 1; }

shift || true
if [ "$#" -gt 0 ]; then
  NAMES=("$@")
else
  NAMES=()
  for dir in "$REPO"/packages/*/; do
    NAMES+=("$(basename "$dir")")
  done
fi

for name in "${NAMES[@]}"; do
  echo "==> removing $name from profile '$PROFILE'"
  "$DSH_BIN" plugin --profile "$PROFILE" remove "$name" || true
done

echo "done — switch the bundle off in Settings → Plugins if its row is still listed."
