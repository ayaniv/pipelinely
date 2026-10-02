#!/bin/bash
# Runs the Vite build in watch mode alongside the Express dev server, and
# stops both when this script exits. A full one-shot build must succeed
# first: server.ts's sendDashboardShell 500s on a missing bundle, and
# starting Express before public/dist exists would make that look like a
# boot race instead of a real build error.
set -e

cd "$(dirname "$0")/.."

echo "[dev] building web bundle..."
npm run build:web

echo "[dev] starting vite build --watch and the Express server..."
npm run dev --workspace=web &
WEB_PID=$!
npx tsx --watch src/server.ts &
SERVER_PID=$!

cleanup() {
  kill "$WEB_PID" "$SERVER_PID" 2>/dev/null
  wait "$WEB_PID" "$SERVER_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

# Either child exiting (a crashed build watcher, a crashed server) ends the
# whole dev session rather than silently running half of it. Polls instead
# of `wait -n` — macOS ships bash 3.2, which doesn't support it.
while kill -0 "$WEB_PID" 2>/dev/null && kill -0 "$SERVER_PID" 2>/dev/null; do
  sleep 1
done
