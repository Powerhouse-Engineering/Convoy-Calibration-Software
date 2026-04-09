# Calibration GUI (React + Tauri)

Desktop GUI for factory calibration workflow.

## What This GUI Now Covers

- Select board (`ASS`/`ASC`) and IMU (`ICM45686`/`BNO086`)
- Configure IMU runtime settings over RTT (`ODR`, ranges, stream rate, BNO mode toggles)
- Build calibration firmware (`west`) and flash (`nrfjprog`)
- Capture ICM data and compute host calibration (gyro bias + accel ellipsoid fit)
- Write ICM calibration back to board
- Run BNO calibration control flow (`CAL_START`, `CAL_READY`, `CAL_SAVE`)
- Log all backend command output in the GUI

## Start (Desktop GUI)

From repository root:

```bash
cd calibration_software
./scripts/launch_calibration_gui.sh
```

This defaults to portable mode (release executable, no Vite watcher).

From inside `calibration_software/scripts`:

```bash
./launch_calibration_gui.sh
```

If you run `launch_calibration_gui.sh` without `./`, shell can return `command not found` when current directory is not in `PATH`.

Portable-only launcher:

```bash
cd calibration_software
./scripts/launch_calibration_portable.sh
```

This launcher auto-rebuilds the portable binary when key sources/config/icon changed.

Build portable folder explicitly:

```bash
cd calibration_software
./scripts/build_calibration_portable.sh
```

Output folder: `calibration_software/dist_portable/`

## Start (Direct Frontend)

```bash
cd calibration_software/frontend
npm install
npm run tauri:dev
```

Or with launcher:

```bash
cd calibration_software
CAL_SW_GUI_MODE=dev ./scripts/launch_calibration_gui.sh
```

## Browser Preview Mode

```bash
cd calibration_software/frontend
npm install
npm run dev
```

Preview mode does not execute native backend operations; it only previews command payloads.

If dev mode fails with Linux `ENOSPC` file watcher error, increase inotify limits:

```bash
echo fs.inotify.max_user_watches=524288 | sudo tee /etc/sysctl.d/99-inotify.conf
echo fs.inotify.max_user_instances=1024 | sudo tee -a /etc/sysctl.d/99-inotify.conf
sudo sysctl --system
```

## Build

```bash
npm run build
```

## Linux Dependencies

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

If needed, replace `libwebkit2gtk-4.1-dev` with `libwebkit2gtk-4.0-dev`.
