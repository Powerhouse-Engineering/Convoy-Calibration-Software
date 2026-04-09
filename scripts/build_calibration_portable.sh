#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CAL_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
FRONTEND_DIR="${CAL_ROOT}/frontend"
PORTABLE_DIR="${CAL_ROOT}/dist_portable"

OS_NAME="$(uname -s)"
APP_BASENAME="convoy-calibration-gui"
if [ "${OS_NAME}" = "Linux" ]; then
  APP_BINARY="${APP_BASENAME}"
elif [ "${OS_NAME}" = "Darwin" ]; then
  APP_BINARY="${APP_BASENAME}"
else
  APP_BINARY="${APP_BASENAME}.exe"
fi

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
  echo "[portable] installing npm dependencies"
  npm install
fi

echo "[portable] building frontend bundle"
npm run build

echo "[portable] building tauri release executable"
cd "${FRONTEND_DIR}/src-tauri"
cargo build --release --features custom-protocol

BIN_SRC="${FRONTEND_DIR}/src-tauri/target/release/${APP_BINARY}"
if [ ! -f "${BIN_SRC}" ]; then
  echo "[portable] release binary not found: ${BIN_SRC}" >&2
  exit 1
fi

rm -rf "${PORTABLE_DIR}"
mkdir -p "${PORTABLE_DIR}"

cp "${BIN_SRC}" "${PORTABLE_DIR}/${APP_BINARY}"
chmod +x "${PORTABLE_DIR}/${APP_BINARY}" 2>/dev/null || true

if [ -d "${CAL_ROOT}/firmware" ]; then
  cp -r "${CAL_ROOT}/firmware" "${PORTABLE_DIR}/firmware"
fi

cat > "${PORTABLE_DIR}/run_calibration_gui.sh" <<'RUNEOF'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export CAL_SW_FIRMWARE_DIR="${CAL_SW_FIRMWARE_DIR:-${SCRIPT_DIR}/firmware}"
exec "${SCRIPT_DIR}/convoy-calibration-gui" "$@"
RUNEOF
chmod +x "${PORTABLE_DIR}/run_calibration_gui.sh"

cat > "${PORTABLE_DIR}/run_calibration_gui.bat" <<'BATEOF'
@echo off
setlocal
set SCRIPT_DIR=%~dp0
if "%CAL_SW_FIRMWARE_DIR%"=="" set CAL_SW_FIRMWARE_DIR=%SCRIPT_DIR%firmware
"%SCRIPT_DIR%convoy-calibration-gui.exe" %*
BATEOF

cat > "${PORTABLE_DIR}/README_PORTABLE.txt" <<'TXTEOF'
CONVOY Calibration Portable Build

Linux:
  ./run_calibration_gui.sh

Windows:
  run_calibration_gui.bat

You can move this dist_portable folder anywhere. If firmware/ is present next to the executable,
it is used automatically as CAL_SW_FIRMWARE_DIR.
TXTEOF

echo "[portable] ready: ${PORTABLE_DIR}"
echo "[portable] launcher: ${PORTABLE_DIR}/run_calibration_gui.sh"
