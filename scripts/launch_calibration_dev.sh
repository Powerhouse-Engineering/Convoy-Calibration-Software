#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CAL_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd -- "${CAL_ROOT}/.." && pwd)"
BACKEND_DIR="${CAL_ROOT}/backend"
FRONTEND_DIR="${CAL_ROOT}/frontend"
WATCHER_HELPER="${SCRIPT_DIR}/run_with_watcher.sh"
WATCHER_PID="$$"
RUNTIME_DIR="${CAL_ROOT}/.runtime"
BACKEND_LOG="${RUNTIME_DIR}/backend.log"
FRONTEND_LOG="${RUNTIME_DIR}/frontend.log"
LAUNCH_MODE="${CAL_SW_LAUNCH_MODE:-auto}"

if [ ! -x "${WATCHER_HELPER}" ]; then
  chmod +x "${WATCHER_HELPER}"
fi

has_graphical_display() {
  if [ -n "${DISPLAY:-}" ]; then
    if command -v xdpyinfo >/dev/null 2>&1; then
      xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 && return 0
    elif command -v xset >/dev/null 2>&1; then
      xset q >/dev/null 2>&1 && return 0
    else
      return 1
    fi
  fi

  if [ -n "${WAYLAND_DISPLAY:-}" ]; then
    if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -S "${XDG_RUNTIME_DIR}/${WAYLAND_DISPLAY}" ]; then
      return 0
    fi
  fi

  return 1
}

detect_terminal() {
  local candidate=""
  for candidate in "${CAL_SW_TERMINAL:-}" gnome-terminal x-terminal-emulator konsole xfce4-terminal xterm; do
    if [ -n "${candidate}" ] && command -v "${candidate}" >/dev/null 2>&1; then
      echo "${candidate}"
      return 0
    fi
  done
  return 1
}

TERMINAL_BIN=""
if [ "${LAUNCH_MODE}" = "gui" ] && ! has_graphical_display; then
  echo "CAL_SW_LAUNCH_MODE=gui requested but no DISPLAY/WAYLAND_DISPLAY is available." >&2
  echo "Use CAL_SW_LAUNCH_MODE=inline, or run from a desktop terminal session." >&2
  exit 1
fi

if [ "${LAUNCH_MODE}" = "gui" ] || { [ "${LAUNCH_MODE}" = "auto" ] && has_graphical_display; }; then
  TERMINAL_BIN="$(detect_terminal || true)"
  if [ -z "${TERMINAL_BIN}" ]; then
    echo "No supported terminal emulator found." >&2
    echo "Set CAL_SW_TERMINAL to one of: gnome-terminal, x-terminal-emulator, konsole, xfce4-terminal, xterm" >&2
    exit 1
  fi
fi

launch_in_terminal() {
  local title="$1"
  local label="$2"
  local command_string="$3"
  local wrapped

  wrapped="$(printf '%q ' "${WATCHER_HELPER}" "${WATCHER_PID}" "${label}" "${command_string}")"

  case "${TERMINAL_BIN}" in
    gnome-terminal)
      gnome-terminal --title="${title}" -- bash -lc "${wrapped}" &
      ;;
    x-terminal-emulator)
      x-terminal-emulator -T "${title}" -e bash -lc "${wrapped}" &
      ;;
    konsole)
      konsole --new-window -p "tabtitle=${title}" -e bash -lc "${wrapped}" &
      ;;
    xfce4-terminal)
      xfce4-terminal --title="${title}" --command="bash -lc $(printf '%q' "${wrapped}")" &
      ;;
    xterm)
      xterm -T "${title}" -e bash -lc "${wrapped}" &
      ;;
    *)
      echo "Unsupported terminal emulator: ${TERMINAL_BIN}" >&2
      exit 1
      ;;
  esac
}

launch_inline() {
  mkdir -p "${RUNTIME_DIR}"
  : > "${BACKEND_LOG}"
  : > "${FRONTEND_LOG}"

  bash -lc "$(printf '%q ' "${WATCHER_HELPER}" "${WATCHER_PID}" "backend" "${BACKEND_COMMAND}")" \
    >"${BACKEND_LOG}" 2>&1 &
  BACKEND_WRAPPER_PID="$!"

  bash -lc "$(printf '%q ' "${WATCHER_HELPER}" "${WATCHER_PID}" "frontend" "${FRONTEND_COMMAND}")" \
    >"${FRONTEND_LOG}" 2>&1 &
  FRONTEND_WRAPPER_PID="$!"

  echo "No GUI display detected. Started in inline/headless mode."
  echo "Backend log:  ${BACKEND_LOG}"
  echo "Frontend log: ${FRONTEND_LOG}"
  echo "To follow logs:"
  echo "  tail -f '${BACKEND_LOG}'"
  echo "  tail -f '${FRONTEND_LOG}'"
  echo
}

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required but not found in PATH." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but not found in PATH." >&2
  exit 1
fi

BACKEND_COMMAND="$(cat <<EOF
cd '${BACKEND_DIR}'
echo '[backend] ready in ${BACKEND_DIR}'
echo '[backend] examples:'
echo '  cargo run -- tools'
echo '  cargo run -- probes'
echo '  cargo run -- --repo-root ${REPO_ROOT} build --board ass'
exec bash
EOF
)"

FRONTEND_COMMAND="$(cat <<EOF
cd '${FRONTEND_DIR}'
if [ ! -d node_modules ]; then
  echo '[frontend] installing npm dependencies'
  npm install
fi
FRONTEND_SCRIPT='${CAL_SW_FRONTEND_SCRIPT:-}'
if [ -z "\${FRONTEND_SCRIPT}" ]; then
  if [ -n '${TERMINAL_BIN}' ]; then
    FRONTEND_SCRIPT='tauri:dev'
  else
    FRONTEND_SCRIPT='dev'
  fi
fi
echo "[frontend] starting npm run \${FRONTEND_SCRIPT}"
npm run "\${FRONTEND_SCRIPT}"
EOF
)"

if [ -n "${TERMINAL_BIN}" ]; then
  echo "Launching calibration terminals with ${TERMINAL_BIN}..."
  launch_in_terminal "CONVOY Calibration Backend" "backend" "${BACKEND_COMMAND}"
  launch_in_terminal "CONVOY Calibration Frontend" "frontend" "${FRONTEND_COMMAND}"
else
  launch_inline
fi

echo
echo "Main launcher is active (PID: ${WATCHER_PID})."
echo "Keep this terminal open."
echo "If this terminal closes, backend/frontend terminals will exit automatically."
echo "Press Ctrl+C to close everything."

trap 'exit 0' INT TERM HUP
while true; do
  sleep 1
done
