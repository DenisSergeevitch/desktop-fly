#!/usr/bin/env bash
# scripts/lint-mirror.sh — fail if linux/src/* and windows/src/* drifted.
#
# Phase 1 acceptance: linux/ reuses windows/ sim/body via symlinks, so by
# construction this diff is empty. If a future Windows checkout falls back
# from symlinks to vendor copies, this becomes the safety net.
set -euo pipefail
cd "$(dirname "$0")/.."

diff_output=$(git diff --stat linux/src/ windows/src/ 2>&1 || true)
if [[ -n "$diff_output" ]]; then
  echo "linux/ and windows/ have drifted:"
  echo "$diff_output"
  exit 1
fi
echo "linux/ and windows/ are in sync (no drift)"
