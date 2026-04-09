#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "Usage: $0 <watcher_pid> <label> <command_string>" >&2
  exit 2
fi

WATCHER_PID="$1"
LABEL="$2"
shift 2
COMMAND_STRING="$*"

if ! kill -0 "$WATCHER_PID" 2>/dev/null; then
  exit 0
fi

CHILD_PID=""

cleanup() {
  if [ -n "${CHILD_PID}" ] && kill -0 "${CHILD_PID}" 2>/dev/null; then
    kill -TERM "${CHILD_PID}" 2>/dev/null || true
    sleep 1
    kill -KILL "${CHILD_PID}" 2>/dev/null || true
    wait "${CHILD_PID}" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM HUP

echo "[${LABEL}] starting"
bash -lc "${COMMAND_STRING}" &
CHILD_PID="$!"

while kill -0 "${CHILD_PID}" 2>/dev/null; do
  if ! kill -0 "${WATCHER_PID}" 2>/dev/null; then
    echo "[${LABEL}] watcher closed, stopping"
    cleanup
    exit 0
  fi
  sleep 1
done

wait "${CHILD_PID}"
exit $?
