# CONVOY Calibration Software

Standalone desktop calibration software workspace for factory flow:

- board + IMU configuration over SWD/RTT
- firmware build (`west`) and flash (`nrfjprog`)
- realtime IMU sampling over RTT
- host-side ICM45686 calibration compute (gyro bias averaging + accel ellipsoid fit)
- write calibration parameters back to board over RTT
- BNO086 internal calibration control and save commands

## Layout

- `backend/`: Rust backend (CLI + library) with build/flash + RTT/calibration operations.
- `frontend/`: React + Tauri desktop GUI.
- `firmware/`: Optional firmware bundle manifest and hex files for flash-without-build.
- `scripts/`: launch helpers.

## GUI Start

```bash
cd calibration_software
./scripts/launch_calibration_gui.sh
```

`launch_calibration_gui.sh` now defaults to portable mode (`CAL_SW_GUI_MODE=portable`), so it launches/builds a release executable instead of `tauri dev`.

If you are already in `calibration_software/scripts`, run:

```bash
./launch_calibration_gui.sh
```

or

```bash
bash launch_calibration_gui.sh
```

If you run `launch_calibration_gui.sh` without `./` and it is not in `PATH`, shell returns `command not found`.

## Portable Executable (No Install)

Build portable output folder:

```bash
cd calibration_software
./scripts/build_calibration_portable.sh
```

Run portable executable:

```bash
cd calibration_software
./scripts/launch_calibration_portable.sh
```

The launcher auto-rebuilds portable output if key GUI/backend files changed (including icon/config).

If the app window shows `Could not connect to localhost: Connection refused`, remove stale portable output and rebuild:

```bash
cd calibration_software
rm -rf dist_portable
./scripts/launch_calibration_gui.sh
```

Portable files are generated in:

- `calibration_software/dist_portable/`
- launcher: `dist_portable/run_calibration_gui.sh`
- binary: `dist_portable/convoy-calibration-gui`

You can copy `dist_portable/` anywhere and run it directly.

## Build Installer (Run Anywhere)

Create a desktop bundle/installer:

```bash
cd calibration_software/frontend
npm run tauri:build
```

Generated artifacts are placed under `frontend/src-tauri/target/release/bundle/`.

## Dev Mode (If Needed) and ENOSPC Fix

If you still want hot-reload dev mode:

```bash
cd calibration_software
CAL_SW_GUI_MODE=dev ./scripts/launch_calibration_gui.sh
```

If Linux shows `ENOSPC: System limit for number of file watchers reached`, raise inotify limits:

```bash
echo fs.inotify.max_user_watches=524288 | sudo tee /etc/sysctl.d/99-inotify.conf
echo fs.inotify.max_user_instances=1024 | sudo tee -a /etc/sysctl.d/99-inotify.conf
sudo sysctl --system
```

## Linux Prerequisites

Install GTK/WebKit development libraries and run from a real desktop session (X11/Wayland reachable):

```bash
sudo apt update
sudo apt install -y \
  pkg-config \
  libgtk-3-dev \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf
```

If unavailable, use `libwebkit2gtk-4.0-dev`.

## Backend CLI Examples

```bash
cd calibration_software/backend
cargo run -- tools
cargo run -- probes
```

Build calibration firmware:

```bash
cargo run -- \
  --repo-root /absolute/path/to/CONVOY-ASS-Firmware \
  build --board ass
```

Flash calibration firmware from manifest bundle:

```bash
cargo run -- flash --board ass --imu icm45686
```

Send RTT commands:

```bash
cargo run -- rtt-command \
  --serial-number 1050123456 \
  --cmd "IMU ICM45686" \
  --cmd "ODR 200" \
  --cmd "APPLY" \
  --cmd "STATUS"
```

Capture + compute ICM calibration:

```bash
cargo run -- icm-capture-cal \
  --serial-number 1050123456 \
  --capture-seconds 30 \
  --gyro-bias-seconds 5
```

Write computed ICM calibration:

```bash
cargo run -- icm-write-cal \
  --serial-number 1050123456 \
  --estimate-json '{"sample_count":100,"gyro_sample_count":20,"gyro_bias_dps":[0,0,0],"accel_offset_mps2":[0,0,0],"accel_xform":[[1,0,0],[0,1,0],[0,0,1]],"residual_rms_mps2":0,"residual_max_mps2":0}'
```

## Environment Variables

- `CAL_SW_FIRMWARE_DIR`: firmware bundle dir.
- `CAL_SW_REPO_ROOT`: default repo root for build operations.
- `CAL_SW_NRFJPROG`: `nrfjprog` executable path.
- `CAL_SW_WEST`: `west` executable path.
- `CAL_SW_JLINK_GDB_SERVER`: J-Link GDB server executable path.

## Notes

- `app_sensor` calibration firmware supports both ICM45686 and BNO086 command modes.
- ICM host calibration write path uses `CAL_SET_GYRO_BIAS` + `CAL_SET_ACCEL` via RTT.
- Use sector erase when possible to reduce risk of wiping unrelated persistent partitions.
