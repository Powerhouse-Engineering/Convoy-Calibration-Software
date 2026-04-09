# Firmware Bundle Directory

Store calibration firmware images here for distribution builds.

Expected structure from `manifest.json`:

- `app_sensor/icm45686_calibration.hex`
- `app_sensor/bno086_calibration.hex`
- `app_controller/icm45686_calibration.hex`
- `app_controller/bno086_calibration.hex`

The backend resolves paths relative to this folder when `flash --hex` is not provided.
