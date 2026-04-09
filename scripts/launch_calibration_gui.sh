#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CAL_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
FRONTEND_DIR="${CAL_ROOT}/frontend"
PORTABLE_LAUNCHER="${SCRIPT_DIR}/launch_calibration_portable.sh"
GUI_MODE="${CAL_SW_GUI_MODE:-portable}"

append_pkg_config_path() {
  local dir="$1"
  if [ ! -d "${dir}" ]; then
    return
  fi

  case ":${PKG_CONFIG_PATH:-}:" in
    *":${dir}:"*) ;;
    *)
      if [ -n "${PKG_CONFIG_PATH:-}" ]; then
        PKG_CONFIG_PATH="${PKG_CONFIG_PATH}:${dir}"
      else
        PKG_CONFIG_PATH="${dir}"
      fi
      ;;
  esac
}

prepare_pkg_config_path() {
  append_pkg_config_path "/usr/lib/$(uname -m)-linux-gnu/pkgconfig"
  append_pkg_config_path "/usr/lib/x86_64-linux-gnu/pkgconfig"
  append_pkg_config_path "/usr/lib/aarch64-linux-gnu/pkgconfig"
  append_pkg_config_path "/usr/share/pkgconfig"
  export PKG_CONFIG_PATH
}

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

if [ "$(uname -s)" = "Linux" ]; then
  if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    echo "[gui] no DISPLAY/WAYLAND display detected." >&2
    echo "[gui] run this from a desktop terminal session (or configure X/Wayland forwarding)." >&2
    exit 1
  fi

  if ! is_display_accessible; then
    echo "[gui] DISPLAY/WAYLAND is set but not reachable from this shell." >&2
    echo "[gui] GTK apps cannot start in this session. Run from a local desktop terminal or configure display forwarding/Xauthority." >&2
    exit 1
  fi
fi

if [ "${GUI_MODE}" = "dev" ] && [ "$(uname -s)" = "Linux" ]; then
  if ! command -v pkg-config >/dev/null 2>&1; then
    echo "[gui] pkg-config is required for dev mode on Linux." >&2
    exit 1
  fi

  prepare_pkg_config_path
  missing_pkgs=()

  if ! pkg-config --exists gtk+-3.0; then
    missing_pkgs+=("gtk+-3.0")
  fi

  if ! pkg-config --exists gdk-3.0; then
    missing_pkgs+=("gdk-3.0")
  fi

  if ! pkg-config --exists pango; then
    missing_pkgs+=("pango")
  fi

  if ! pkg-config --exists webkit2gtk-4.1 && ! pkg-config --exists webkit2gtk-4.0; then
    missing_pkgs+=("webkit2gtk-4.1 (or webkit2gtk-4.0)")
  fi

  if [ "${#missing_pkgs[@]}" -gt 0 ]; then
    echo "[gui] missing required Linux native packages: ${missing_pkgs[*]}" >&2
    echo "[gui] install GTK/WebKit development packages, then run this script again." >&2
    exit 1
  fi
fi

if [ "${GUI_MODE}" = "portable" ]; then
  echo "[gui] launching portable executable mode"
  exec "${PORTABLE_LAUNCHER}" "$@"
fi

if [ "${GUI_MODE}" = "dev" ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is required but not found in PATH." >&2
    exit 1
  fi

  if ! command -v cargo >/dev/null 2>&1; then
    echo "cargo is required but not found in PATH." >&2
    exit 1
  fi

  cd "${FRONTEND_DIR}"

  if [ ! -d node_modules ]; then
    echo "[gui] installing npm dependencies"
    npm install
  fi

  echo "[gui] starting Tauri desktop app (dev mode)"
  exec npm run tauri:dev -- "$@"
fi

echo "[gui] unsupported mode: ${GUI_MODE}" >&2
echo "[gui] set CAL_SW_GUI_MODE=portable (default) or CAL_SW_GUI_MODE=dev" >&2
exit 1
