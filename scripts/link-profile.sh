#!/usr/bin/env bash
# Link the built Aurora packages into a running dsh profile.
#
# DSH loads a plugin from the profile's own node_modules, so local development
# installs the package by path: pnpm records a `link:` dependency and the profile
# keeps reading this checkout's `lib/` as it is rebuilt. Nothing is published.
#
# Usage: scripts/link-profile.sh [profile] [package...]
#   profile   defaults to $DSH_PROFILE, then `web`
#   packages  defaults to every package under packages/
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${1:-${DSH_PROFILE:-web}}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
DSH_BIN="${DSH_BIN:-$(command -v dsh || true)}"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "no profile at $PROFILE_DIR — start dsh once, or pass the right profile name" >&2
  exit 1
fi
if [ -z "$DSH_BIN" ]; then
  echo "dsh is not on PATH (set DSH_BIN=/path/to/dsh)" >&2
  exit 1
fi

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
  pkg="$REPO/packages/$name"
  if [ ! -f "$pkg/package.json" ]; then
    echo "package '$name' not found under packages/" >&2
    exit 1
  fi
  if [ ! -f "$pkg/lib/index.js" ]; then
    echo "package '$name' has no build — run: pnpm --filter $name build" >&2
    exit 1
  fi
  echo "==> $name"
  # --save-prod keeps the dependency in the profile's package.json, which is where
  # the profile's bundle list is read from on the next boot.
  "$DSH_BIN" plugin --profile "$PROFILE" add --save-prod "file:$pkg"
done

cat <<EOF

Linked into profile '$PROFILE' ($PROFILE_DIR).

The profile's package.json now lists the package under dependencies, but it still
has to be turned on as a bundle:

  1. Open the dsh web GUI → Settings → Plugins.
  2. Find the bundle, switch it on.
  3. Reload the page if the plugin was just installed for the first time.

(Profile: $PROFILE_DIR/package.json — bundles are the dsh.profile.bundles list.)
EOF
