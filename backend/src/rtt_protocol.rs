use crate::types::ImuModel;
use crate::{BackendError, Result};
use serde::{Deserialize, Serialize};

pub const RTT_BIN_MAGIC: u16 = 0xCA1B;
pub const RTT_BIN_VERSION: u8 = 1;
pub const RTT_BIN_FRAME_IMU: u8 = 1;
pub const RTT_BIN_HEADER_LEN: usize = 16;
pub const RTT_BIN_ICM_PAYLOAD_LEN: usize = 48;
pub const RTT_BIN_ICM_PAYLOAD_LEN_LEGACY: usize = 36;
pub const RTT_BIN_BNO_PAYLOAD_LEN: usize = 57;
pub const RTT_BIN_BNO_PAYLOAD_LEN_LEGACY: usize = 45;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RttBinaryHeader {
    pub magic: u16,
    pub version: u8,
    pub frame_type: u8,
    pub model: ImuModel,
    pub flags: u8,
    pub payload_len: u16,
    pub seq: u32,
    pub timestamp_ms: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IcmBinaryPayload {
    pub sample_count: u32,
    pub accel_mps2: [f32; 3],
    pub gyro_dps: [f32; 3],
    pub temp_c: f32,
    pub gravity_mps2: [f32; 3],
    pub valid_flags: u8,
    pub accel_accuracy: u8,
    pub gyro_accuracy: u8,
    pub cal_state: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BnoBinaryPayload {
    pub accel_mps2: [f32; 3],
    pub gyro_dps: [f32; 3],
    pub quat: [f32; 4],
    pub gravity_mps2: [f32; 3],
    pub valid_flags: u8,
    pub accel_accuracy: u8,
    pub gyro_accuracy: u8,
    pub mag_accuracy: u8,
    pub cal_state: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "payload_type", content = "payload")]
pub enum ImuBinaryPayload {
    Icm(IcmBinaryPayload),
    Bno(BnoBinaryPayload),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImuBinaryFrame {
    pub header: RttBinaryHeader,
    pub payload: ImuBinaryPayload,
}

pub fn parse_binary_imu_frame(frame: &[u8]) -> Result<ImuBinaryFrame> {
    if frame.len() < RTT_BIN_HEADER_LEN {
        return Err(BackendError::InvalidInput(format!(
            "frame too short: {} bytes",
            frame.len()
        )));
    }

    let magic = read_u16_le(frame, 0)?;
    if magic != RTT_BIN_MAGIC {
        return Err(BackendError::InvalidInput(format!(
            "invalid magic: 0x{magic:04X}"
        )));
    }

    let version = frame[2];
    if version != RTT_BIN_VERSION {
        return Err(BackendError::InvalidInput(format!(
            "unsupported version: {version}"
        )));
    }

    let frame_type = frame[3];
    if frame_type != RTT_BIN_FRAME_IMU {
        return Err(BackendError::InvalidInput(format!(
            "unsupported frame type: {frame_type}"
        )));
    }

    let model = match frame[4] {
        0 => ImuModel::Icm45686,
        1 => ImuModel::Bno086,
        raw => {
            return Err(BackendError::InvalidInput(format!(
                "unsupported IMU model id: {raw}"
            )))
        }
    };

    let flags = frame[5];
    let payload_len = read_u16_le(frame, 6)?;
    let seq = read_u32_le(frame, 8)?;
    let timestamp_ms = read_u32_le(frame, 12)?;

    let expected_total = RTT_BIN_HEADER_LEN + usize::from(payload_len);
    if frame.len() != expected_total {
        return Err(BackendError::InvalidInput(format!(
            "frame size mismatch: header says {expected_total} bytes, got {}",
            frame.len()
        )));
    }

    let payload_bytes = &frame[RTT_BIN_HEADER_LEN..];
    let payload = match model {
        ImuModel::Icm45686 => ImuBinaryPayload::Icm(parse_icm_payload(payload_bytes)?),
        ImuModel::Bno086 => ImuBinaryPayload::Bno(parse_bno_payload(payload_bytes)?),
    };

    Ok(ImuBinaryFrame {
        header: RttBinaryHeader {
            magic,
            version,
            frame_type,
            model,
            flags,
            payload_len,
            seq,
            timestamp_ms,
        },
        payload,
    })
}

fn parse_icm_payload(payload: &[u8]) -> Result<IcmBinaryPayload> {
    let (gravity_offset, flags_offset) = match payload.len() {
        RTT_BIN_ICM_PAYLOAD_LEN => (Some(32usize), 44usize),
        RTT_BIN_ICM_PAYLOAD_LEN_LEGACY => (None, 32usize),
        _ => {
            return Err(BackendError::InvalidInput(format!(
                "invalid ICM payload length: {}",
                payload.len()
            )))
        }
    };

    let gravity_mps2 = if let Some(offset) = gravity_offset {
        [
            read_f32_le(payload, offset)?,
            read_f32_le(payload, offset + 4)?,
            read_f32_le(payload, offset + 8)?,
        ]
    } else {
        [f32::NAN, f32::NAN, f32::NAN]
    };

    let accel_accuracy_offset = flags_offset + 1;
    let gyro_accuracy_offset = flags_offset + 2;
    let cal_state_offset = flags_offset + 3;

    if cal_state_offset >= payload.len() {
        return Err(BackendError::InvalidInput(format!(
            "invalid ICM payload length: {}",
            payload.len()
        )));
    }

    Ok(IcmBinaryPayload {
        sample_count: read_u32_le(payload, 0)?,
        accel_mps2: [
            read_f32_le(payload, 4)?,
            read_f32_le(payload, 8)?,
            read_f32_le(payload, 12)?,
        ],
        gyro_dps: [
            read_f32_le(payload, 16)?,
            read_f32_le(payload, 20)?,
            read_f32_le(payload, 24)?,
        ],
        temp_c: read_f32_le(payload, 28)?,
        gravity_mps2,
        valid_flags: payload[flags_offset],
        accel_accuracy: payload[accel_accuracy_offset],
        gyro_accuracy: payload[gyro_accuracy_offset],
        cal_state: payload[cal_state_offset],
    })
}

fn parse_bno_payload(payload: &[u8]) -> Result<BnoBinaryPayload> {
    let (gravity_offset, flags_offset) = match payload.len() {
        RTT_BIN_BNO_PAYLOAD_LEN => (Some(40usize), 52usize),
        RTT_BIN_BNO_PAYLOAD_LEN_LEGACY => (None, 40usize),
        _ => {
            return Err(BackendError::InvalidInput(format!(
                "invalid BNO payload length: {}",
                payload.len()
            )))
        }
    };

    let gravity_mps2 = if let Some(offset) = gravity_offset {
        [
            read_f32_le(payload, offset)?,
            read_f32_le(payload, offset + 4)?,
            read_f32_le(payload, offset + 8)?,
        ]
    } else {
        [f32::NAN, f32::NAN, f32::NAN]
    };

    let accel_accuracy_offset = flags_offset + 1;
    let gyro_accuracy_offset = flags_offset + 2;
    let mag_accuracy_offset = flags_offset + 3;
    let cal_state_offset = flags_offset + 4;

    if cal_state_offset >= payload.len() {
        return Err(BackendError::InvalidInput(format!(
            "invalid BNO payload length: {}",
            payload.len()
        )));
    }

    Ok(BnoBinaryPayload {
        accel_mps2: [
            read_f32_le(payload, 0)?,
            read_f32_le(payload, 4)?,
            read_f32_le(payload, 8)?,
        ],
        gyro_dps: [
            read_f32_le(payload, 12)?,
            read_f32_le(payload, 16)?,
            read_f32_le(payload, 20)?,
        ],
        quat: [
            read_f32_le(payload, 24)?,
            read_f32_le(payload, 28)?,
            read_f32_le(payload, 32)?,
            read_f32_le(payload, 36)?,
        ],
        gravity_mps2,
        valid_flags: payload[flags_offset],
        accel_accuracy: payload[accel_accuracy_offset],
        gyro_accuracy: payload[gyro_accuracy_offset],
        mag_accuracy: payload[mag_accuracy_offset],
        cal_state: payload[cal_state_offset],
    })
}

fn read_u16_le(bytes: &[u8], offset: usize) -> Result<u16> {
    if offset + 2 > bytes.len() {
        return Err(BackendError::InvalidInput(
            "unexpected end of frame".to_string(),
        ));
    }
    Ok(u16::from_le_bytes([bytes[offset], bytes[offset + 1]]))
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Result<u32> {
    if offset + 4 > bytes.len() {
        return Err(BackendError::InvalidInput(
            "unexpected end of frame".to_string(),
        ));
    }
    Ok(u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ]))
}

fn read_f32_le(bytes: &[u8], offset: usize) -> Result<f32> {
    Ok(f32::from_bits(read_u32_le(bytes, offset)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_icm_frame_success() {
        let mut frame = Vec::<u8>::new();
        frame.extend_from_slice(&RTT_BIN_MAGIC.to_le_bytes());
        frame.push(RTT_BIN_VERSION);
        frame.push(RTT_BIN_FRAME_IMU);
        frame.push(0); // model ICM
        frame.push(0); // header flags
        frame.extend_from_slice(&(RTT_BIN_ICM_PAYLOAD_LEN as u16).to_le_bytes());
        frame.extend_from_slice(&(7u32).to_le_bytes());
        frame.extend_from_slice(&(1234u32).to_le_bytes());

        frame.extend_from_slice(&(10u32).to_le_bytes());
        frame.extend_from_slice(&(1.0f32).to_le_bytes());
        frame.extend_from_slice(&(2.0f32).to_le_bytes());
        frame.extend_from_slice(&(3.0f32).to_le_bytes());
        frame.extend_from_slice(&(4.0f32).to_le_bytes());
        frame.extend_from_slice(&(5.0f32).to_le_bytes());
        frame.extend_from_slice(&(6.0f32).to_le_bytes());
        frame.extend_from_slice(&(25.0f32).to_le_bytes());
        frame.extend_from_slice(&(7.0f32).to_le_bytes());
        frame.extend_from_slice(&(8.0f32).to_le_bytes());
        frame.extend_from_slice(&(9.0f32).to_le_bytes());
        frame.push(0b0000_1111);
        frame.push(3);
        frame.push(2);
        frame.push(4);

        let parsed = parse_binary_imu_frame(&frame).expect("frame should parse");
        assert_eq!(parsed.header.seq, 7);
        assert_eq!(parsed.header.timestamp_ms, 1234);

        match parsed.payload {
            ImuBinaryPayload::Icm(payload) => {
                assert_eq!(payload.sample_count, 10);
                assert_eq!(payload.accel_mps2, [1.0, 2.0, 3.0]);
                assert_eq!(payload.gyro_dps, [4.0, 5.0, 6.0]);
                assert_eq!(payload.gravity_mps2, [7.0, 8.0, 9.0]);
                assert_eq!(payload.valid_flags, 0b0000_1111);
                assert_eq!(payload.accel_accuracy, 3);
                assert_eq!(payload.gyro_accuracy, 2);
                assert_eq!(payload.cal_state, 4);
            }
            ImuBinaryPayload::Bno(_) => panic!("unexpected payload type"),
        }
    }

    #[test]
    fn parse_legacy_icm_frame_success() {
        let mut frame = Vec::<u8>::new();
        frame.extend_from_slice(&RTT_BIN_MAGIC.to_le_bytes());
        frame.push(RTT_BIN_VERSION);
        frame.push(RTT_BIN_FRAME_IMU);
        frame.push(0); // model ICM
        frame.push(0); // header flags
        frame.extend_from_slice(&(RTT_BIN_ICM_PAYLOAD_LEN_LEGACY as u16).to_le_bytes());
        frame.extend_from_slice(&(9u32).to_le_bytes());
        frame.extend_from_slice(&(4321u32).to_le_bytes());

        frame.extend_from_slice(&(17u32).to_le_bytes());
        frame.extend_from_slice(&(1.0f32).to_le_bytes());
        frame.extend_from_slice(&(2.0f32).to_le_bytes());
        frame.extend_from_slice(&(3.0f32).to_le_bytes());
        frame.extend_from_slice(&(4.0f32).to_le_bytes());
        frame.extend_from_slice(&(5.0f32).to_le_bytes());
        frame.extend_from_slice(&(6.0f32).to_le_bytes());
        frame.extend_from_slice(&(24.0f32).to_le_bytes());
        frame.push(0b0000_0111);
        frame.push(3);
        frame.push(2);
        frame.push(4);

        let parsed = parse_binary_imu_frame(&frame).expect("legacy frame should parse");
        assert_eq!(parsed.header.seq, 9);
        assert_eq!(parsed.header.timestamp_ms, 4321);

        match parsed.payload {
            ImuBinaryPayload::Icm(payload) => {
                assert_eq!(payload.sample_count, 17);
                assert_eq!(payload.accel_mps2, [1.0, 2.0, 3.0]);
                assert_eq!(payload.gyro_dps, [4.0, 5.0, 6.0]);
                assert!(payload.gravity_mps2.iter().all(|value| value.is_nan()));
                assert_eq!(payload.valid_flags, 0b0000_0111);
            }
            ImuBinaryPayload::Bno(_) => panic!("unexpected payload type"),
        }
    }
}
