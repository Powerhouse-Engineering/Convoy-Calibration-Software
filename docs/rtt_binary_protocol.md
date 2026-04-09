# RTT Binary IMU Frame Protocol

The calibration firmware supports two streaming modes:

- `STREAM_FORMAT CSV`: legacy text lines on RTT up channel `0`.
- `STREAM_FORMAT BIN`: compact binary IMU frames on RTT up channel `1`.

Command/ACK traffic remains text on channel `0` in both modes.

## Frame Header (16 bytes, little-endian)

| Offset | Size | Field |
|---:|---:|---|
| 0 | 2 | `magic` = `0xCA1B` |
| 2 | 1 | `version` = `1` |
| 3 | 1 | `frame_type` = `1` (IMU sample) |
| 4 | 1 | `model` (`0` = ICM45686, `1` = BNO086) |
| 5 | 1 | `flags` (reserved, currently `0`) |
| 6 | 2 | `payload_len` |
| 8 | 4 | `seq` |
| 12 | 4 | `timestamp_ms` |

## ICM45686 Payload (36 bytes)

Order:

1. `sample_count` (`u32`)
2. `accel_x_mps2` (`f32`)
3. `accel_y_mps2` (`f32`)
4. `accel_z_mps2` (`f32`)
5. `gyro_x_dps` (`f32`)
6. `gyro_y_dps` (`f32`)
7. `gyro_z_dps` (`f32`)
8. `temp_c` (`f32`, NaN if invalid)
9. `valid_flags` (`u8`, bit0 accel, bit1 gyro, bit2 temp)
10. `accel_accuracy` (`u8`)
11. `gyro_accuracy` (`u8`)
12. `cal_state` (`u8`)

## BNO086 Payload (45 bytes)

Order:

1. `accel_x_mps2` (`f32`)
2. `accel_y_mps2` (`f32`)
3. `accel_z_mps2` (`f32`)
4. `gyro_x_dps` (`f32`)
5. `gyro_y_dps` (`f32`)
6. `gyro_z_dps` (`f32`)
7. `quat_w` (`f32`)
8. `quat_x` (`f32`)
9. `quat_y` (`f32`)
10. `quat_z` (`f32`)
11. `valid_flags` (`u8`, bit0 accel, bit1 gyro, bit2 quat)
12. `accel_accuracy` (`u8`)
13. `gyro_accuracy` (`u8`)
14. `mag_accuracy` (`u8`)
15. `cal_state` (`u8`)
