#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CAL_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
PORTABLE_DIR="${CAL_ROOT}/dist_portable"
BUILD_SCRIPT="${SCRIPT_DIR}/build_calibration_portable.sh"

OS_NAME="$(uname -s)"
if [ "${OS_NAME}" = "Linux" ]; then
  APP_BINARY="convoy-calibration-gui"
else
  APP_BINARY="convoy-calibration-gui.exe"
fi

is_display_accessible() {
  if [ "${CAL_SW_SKIP_DISPLAY_CHECK:-0}" = "1" ]; then
    return 0
  fi

  if [ -n "${WAYLAND_DISPLAY:-}" ] && [ -n "${XDG_RUNTIME_DIR:-}" ]; then
    if [ -S "${XDG_RUNTIME_DIR}/${WAYLAND_DISPLAY}" ]; then
      return 0
    fi
  fi

  if [ -n "${DISPLAY:-}" ]; then
    # Container-friendly fallback for local X11 forwarding without xset/xdpyinfo.
    local display_id="${DISPLAY#*:}"
    display_id="${display_id%%.*}"
    if [ -n "${display_id}" ] && [ -S "/tmp/.X11-unix/X${display_id}" ]; then
      return 0
    fi

    if command -v xdpyinfo >/dev/null 2>&1; then
      xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 && return 0
    elif command -v xset >/dev/null 2>&1; then
      xset q >/dev/null 2>&1 && return 0
    fi
  fi

  return 1
}

if [ "${OS_NAME}" = "Linux" ]; then
  if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    echo "[portable] no DISPLAY/WAYLAND display detected." >&2
    echo "[portable] run from a desktop terminal session." >&2
    exit 1
  fi

  if ! is_display_accessible; then
    echo "[portable] DISPLAY/WAYLAND is set but not reachable from this shell." >&2
    echo "[portable] run from a local desktop terminal or configure display forwarding/Xauthority." >&2
    exit 1
  fi
fi

needs_rebuild=0
if [ ! -x "${PORTABLE_DIR}/${APP_BINARY}" ]; then
  needs_rebuild=1
fi

if [ "${needs_rebuild}" -eq 0 ]; then
  BIN_PATH="${PORTABLE_DIR}/${APP_BINARY}"
  if [ "${CAL_ROOT}/frontend/src-tauri/tauri.conf.json" -nt "${BIN_PATH}" ] || \
     [ "${CAL_ROOT}/frontend/src-tauri/Cargo.toml" -nt "${BIN_PATH}" ] || \
     [ "${CAL_ROOT}/frontend/src-tauri/icons/icon.png" -nt "${BIN_PATH}" ]; then
    needs_rebuild=1
  fi

  if [ "${needs_rebuild}" -eq 0 ]; then
    if find \
      "${CAL_ROOT}/frontend/src" \
      "${CAL_ROOT}/frontend/src-tauri/src" \
      "${CAL_ROOT}/backend/src" \
      -type f -newer "${BIN_PATH}" -print -quit | grep -q .; then
      needs_rebuild=1
    fi
  fi
fi

if [ "${needs_rebuild}" -eq 1 ]; then
  echo "[portable] building/updating portable package"
  "${BUILD_SCRIPT}"
fi

if [ -x "${PORTABLE_DIR}/run_calibration_gui.sh" ]; then
  exec "${PORTABLE_DIR}/run_calibration_gui.sh" "$@"
fi

exec "${PORTABLE_DIR}/${APP_BINARY}" "$@"
