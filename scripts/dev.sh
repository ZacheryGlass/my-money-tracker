#!/usr/bin/env bash
# Start backend and frontend dev servers in parallel.
# Ctrl+C stops both.
#
# Usage:
#   ./scripts/dev.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cleanup() {
  echo ""
  echo "Shutting down..."
  kill 0 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

echo "Starting backend (http://localhost:3000)..."
(cd "$ROOT/backend" && npm run dev) &

echo "Starting frontend (http://localhost:5173)..."
(cd "$ROOT/frontend" && npm run dev) &

wait
