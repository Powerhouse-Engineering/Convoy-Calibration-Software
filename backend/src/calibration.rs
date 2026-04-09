use crate::types::{IcmCalibrationEstimate, IcmCsvSample};
use crate::{BackendError, Result};
use nalgebra::{DMatrix, DVector, Matrix3, Vector3};

const GRAVITY_MPS2: f64 = 9.80665;

pub fn estimate_icm_calibration(
    samples: &[IcmCsvSample],
    gyro_bias_seconds: f32,
) -> Result<IcmCalibrationEstimate> {
    if samples.len() < 80 {
        return Err(BackendError::InvalidInput(
            "not enough IMU samples for calibration (need at least 80)".to_string(),
        ));
    }

    let gyro_bias = estimate_gyro_bias(samples, gyro_bias_seconds)?;
    let (accel_offset, accel_xform, residual_rms, residual_max) =
        estimate_accel_ellipsoid(samples)?;

    let gyro_sample_count = samples
        .iter()
        .filter(|sample| sample.host_elapsed_s <= gyro_bias_seconds)
        .count();

    Ok(IcmCalibrationEstimate {
        sample_count: samples.len(),
        gyro_sample_count,
        gyro_bias_dps: gyro_bias,
        accel_offset_mps2: accel_offset,
        accel_xform,
        residual_rms_mps2: residual_rms,
        residual_max_mps2: residual_max,
    })
}

pub fn estimate_gyro_bias(samples: &[IcmCsvSample], gyro_bias_seconds: f32) -> Result<[f32; 3]> {
    if gyro_bias_seconds <= 0.0 {
        return Err(BackendError::InvalidInput(
            "gyro_bias_seconds must be > 0".to_string(),
        ));
    }

    let window_samples = samples
        .iter()
        .filter(|sample| sample.host_elapsed_s <= gyro_bias_seconds)
        .collect::<Vec<&IcmCsvSample>>();

    if window_samples.len() < 20 {
        return Err(BackendError::InvalidInput(format!(
            "not enough samples in gyro bias window ({} found, need at least 20)",
            window_samples.len()
        )));
    }

    let mut bias = [0.0f64; 3];
    for sample in &window_samples {
        bias[0] += f64::from(sample.gyro_dps[0]);
        bias[1] += f64::from(sample.gyro_dps[1]);
        bias[2] += f64::from(sample.gyro_dps[2]);
    }

    let denom = window_samples.len() as f64;
    Ok([
        (bias[0] / denom) as f32,
        (bias[1] / denom) as f32,
        (bias[2] / denom) as f32,
    ])
}

pub fn estimate_accel_ellipsoid(
    samples: &[IcmCsvSample],
) -> Result<([f32; 3], [[f32; 3]; 3], f32, f32)> {
    let accel_points = samples
        .iter()
        .filter_map(|sample| {
            let point = [
                f64::from(sample.accel_mps2[0]),
                f64::from(sample.accel_mps2[1]),
                f64::from(sample.accel_mps2[2]),
            ];

            if point.iter().all(|value| value.is_finite()) {
                Some(point)
            } else {
                None
            }
        })
        .collect::<Vec<[f64; 3]>>();

    if accel_points.len() < 80 {
        return Err(BackendError::InvalidInput(format!(
            "not enough accel points for ellipsoid fit ({} found, need at least 80)",
            accel_points.len()
        )));
    }

    let rows = accel_points.len();
    let mut design = DMatrix::<f64>::zeros(rows, 9);
    let ones = DVector::<f64>::from_element(rows, 1.0);

    for (row, point) in accel_points.iter().enumerate() {
        let x = point[0];
        let y = point[1];
        let z = point[2];

        design[(row, 0)] = x * x;
        design[(row, 1)] = y * y;
        design[(row, 2)] = z * z;
        design[(row, 3)] = 2.0 * x * y;
        design[(row, 4)] = 2.0 * x * z;
        design[(row, 5)] = 2.0 * y * z;
        design[(row, 6)] = 2.0 * x;
        design[(row, 7)] = 2.0 * y;
        design[(row, 8)] = 2.0 * z;
    }

    let params = design.qr().solve(&ones).ok_or_else(|| {
        BackendError::InvalidInput("ellipsoid fit failed to solve least squares".to_string())
    })?;

    let mut shape = Matrix3::<f64>::zeros();
    shape[(0, 0)] = params[0];
    shape[(1, 1)] = params[1];
    shape[(2, 2)] = params[2];
    shape[(0, 1)] = params[3];
    shape[(1, 0)] = params[3];
    shape[(0, 2)] = params[4];
    shape[(2, 0)] = params[4];
    shape[(1, 2)] = params[5];
    shape[(2, 1)] = params[5];

    let linear = Vector3::<f64>::new(params[6], params[7], params[8]);

    let inv_shape = shape.try_inverse().ok_or_else(|| {
        BackendError::InvalidInput("ellipsoid fit produced singular shape matrix".to_string())
    })?;

    let center = -(inv_shape * linear);
    let scale_term: f64 = 1.0 + center.dot(&(shape * center));

    if !scale_term.is_finite() || scale_term <= 0.0 {
        return Err(BackendError::InvalidInput(
            "invalid ellipsoid scale term computed from fit".to_string(),
        ));
    }

    let normalized_shape = shape / scale_term;
    let symmetric_shape = (normalized_shape + normalized_shape.transpose()) * 0.5;
    let eigen = symmetric_shape.symmetric_eigen();

    let mut sqrt_diag = Matrix3::<f64>::zeros();
    for idx in 0..3 {
        let value = eigen.eigenvalues[idx];
        if !value.is_finite() || value <= 0.0 {
            return Err(BackendError::InvalidInput(
                "ellipsoid fit produced non-positive eigenvalue".to_string(),
            ));
        }
        sqrt_diag[(idx, idx)] = value.sqrt();
    }

    let sqrt_shape = eigen.eigenvectors * sqrt_diag * eigen.eigenvectors.transpose();
    let xform = sqrt_shape * GRAVITY_MPS2;

    let mut sum_sq = 0.0f64;
    let mut max_abs = 0.0f64;

    for point in &accel_points {
        let vec = Vector3::<f64>::new(point[0], point[1], point[2]) - center;
        let corrected = xform * vec;
        let magnitude = corrected.norm();
        let error = magnitude - GRAVITY_MPS2;
        sum_sq += error * error;
        max_abs = max_abs.max(error.abs());
    }

    let rms = (sum_sq / (accel_points.len() as f64)).sqrt();

    Ok((
        [center[0] as f32, center[1] as f32, center[2] as f32],
        [
            [
                xform[(0, 0)] as f32,
                xform[(0, 1)] as f32,
                xform[(0, 2)] as f32,
            ],
            [
                xform[(1, 0)] as f32,
                xform[(1, 1)] as f32,
                xform[(1, 2)] as f32,
            ],
            [
                xform[(2, 0)] as f32,
                xform[(2, 1)] as f32,
                xform[(2, 2)] as f32,
            ],
        ],
        rms as f32,
        max_abs as f32,
    ))
}

pub fn parse_icm_csv_sample(line: &str, host_elapsed_s: f32) -> Option<IcmCsvSample> {
    let fields = line.trim().split(',').collect::<Vec<&str>>();

    if fields.len() < 16 {
        return None;
    }
    if fields[0] != "RTT_IMU" || !fields[1].eq_ignore_ascii_case("ICM45686") {
        return None;
    }

    let parse_u32 = |value: &str| value.parse::<u32>().ok();
    let parse_u8 = |value: &str| value.parse::<u8>().ok();
    let parse_f32 = |value: &str| value.parse::<f32>().ok();

    Some(IcmCsvSample {
        host_elapsed_s,
        seq: parse_u32(fields[2])?,
        timestamp_ms: parse_u32(fields[3])?,
        sample_count: parse_u32(fields[4])?,
        accel_mps2: [
            parse_f32(fields[5])?,
            parse_f32(fields[6])?,
            parse_f32(fields[7])?,
        ],
        gyro_dps: [
            parse_f32(fields[8])?,
            parse_f32(fields[9])?,
            parse_f32(fields[10])?,
        ],
        temp_c: parse_f32(fields[11])?,
        temp_valid: parse_u8(fields[12])? != 0,
        accel_accuracy: parse_u8(fields[13])?,
        gyro_accuracy: parse_u8(fields[14])?,
        cal_state: parse_u8(fields[15])?,
    })
}
