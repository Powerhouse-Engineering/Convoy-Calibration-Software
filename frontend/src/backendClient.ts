export type BackendCallResult = {
  mode: "tauri" | "preview";
  command: string;
  output: unknown;
};

export type GyroRealtimeStreamRequest = {
  serial_number: string | null;
  device_name: string;
  speed_khz: number;
  gdb_port: number;
  rtt_telnet_port: number;
  connect_timeout_ms: number;
  ack_timeout_ms: number;
  odr_hz: number;
  stream_hz: number;
  accel_range_g: number;
  gyro_range_dps: number;
  low_noise: boolean;
  fifo: boolean;
  fifo_hires: boolean;
  nrfjprog: string | null;
  jlink_gdb_server: string | null;
};

export type GyroRealtimeSampleEvent = {
  timestamp_ms: number;
  ax: number;
  ay: number;
  az: number;
  gx: number;
  gy: number;
  gz: number;
};

export type GyroRealtimeStatusEvent = {
  level: string;
  message: string;
};

export type RttConnectRequest = {
  serial_number: string | null;
  device_name: string;
  speed_khz: number;
  gdb_port: number;
  rtt_telnet_port: number;
  connect_timeout_ms: number;
  ack_timeout_ms: number;
  nrfjprog: string | null;
  jlink_gdb_server: string | null;
};

export type RttConnectedCommandRequest = {
  commands: string[];
  ack_timeout_ms: number | null;
};

export type RttConnectionStatus = {
  connected: boolean;
};

export type RttConnectionStatusEvent = {
  connected: boolean;
  message: string;
};

export type IcmConnectedCaptureRequest = {
  serial_number: string | null;
  device_name: string;
  speed_khz: number;
  gdb_port: number;
  rtt_telnet_port: number;
  connect_timeout_ms: number;
  ack_timeout_ms: number;
  capture_seconds: number;
  gyro_bias_seconds: number;
  compute_gyro: boolean;
  compute_accel: boolean;
  min_total_samples: number;
  min_gyro_samples: number;
  min_accel_points: number;
  odr_hz: number;
  stream_hz: number;
  accel_range_g: number;
  gyro_range_dps: number;
  low_noise: boolean;
  fifo: boolean;
  fifo_hires: boolean;
  keep_stream_running: boolean;
};

type InvokeFn = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;

function toCommandString(args: string[]): string {
  return `calibration-backend ${args.join(" ")}`;
}

function hasTauriRuntime(): boolean {
  return typeof window !== "undefined" && typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined";
}

async function resolveInvoke(): Promise<InvokeFn | null> {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    const core = await import("@tauri-apps/api/core");
    return core.invoke as InvokeFn;
  } catch {
    return null;
  }
}

export async function callBackend(args: string[]): Promise<BackendCallResult> {
  const invoke = await resolveInvoke();
  const command = toCommandString(args);

  if (!invoke) {
    return {
      mode: "preview",
      command,
      output: {
        note: "Tauri backend bridge is not connected. This is command preview mode.",
      },
    };
  }

  const output = await invoke("run_backend_cli", { args });
  return {
    mode: "tauri",
    command,
    output,
  };
}

export async function startGyroRealtimeStream(
  request: GyroRealtimeStreamRequest,
): Promise<void> {
  const invoke = await resolveInvoke();
  if (!invoke) {
    throw new Error("Tauri backend bridge is not connected.");
  }

  await invoke("start_gyro_stream", { request });
}

export async function stopGyroRealtimeStream(): Promise<boolean> {
  const invoke = await resolveInvoke();
  if (!invoke) {
    return false;
  }

  const result = await invoke("stop_gyro_stream");
  return result === true;
}

export async function listenGyroRealtimeSamples(
  handler: (payload: GyroRealtimeSampleEvent) => void,
): Promise<() => void> {
  if (!hasTauriRuntime()) {
    return () => {};
  }

  const events = await import("@tauri-apps/api/event");
  return events.listen<GyroRealtimeSampleEvent>("gyro-stream-sample", (event) => {
    handler(event.payload);
  });
}

export async function listenGyroRealtimeStatus(
  handler: (payload: GyroRealtimeStatusEvent) => void,
): Promise<() => void> {
  if (!hasTauriRuntime()) {
    return () => {};
  }

  const events = await import("@tauri-apps/api/event");
  return events.listen<GyroRealtimeStatusEvent>("gyro-stream-status", (event) => {
    handler(event.payload);
  });
}

export async function connectRttSession(request: RttConnectRequest): Promise<void> {
  const invoke = await resolveInvoke();
  if (!invoke) {
    throw new Error("Tauri backend bridge is not connected.");
  }
  await invoke("connect_rtt", { request });
}

export async function disconnectRttSession(): Promise<boolean> {
  const invoke = await resolveInvoke();
  if (!invoke) {
    return false;
  }
  const result = await invoke("disconnect_rtt");
  return result === true;
}

export async function getRttConnectionStatus(): Promise<RttConnectionStatus> {
  const invoke = await resolveInvoke();
  if (!invoke) {
    return { connected: false };
  }
  const result = await invoke("rtt_connection_status");
  const maybe = result as Partial<RttConnectionStatus>;
  return { connected: maybe.connected === true };
}

export async function sendConnectedRttCommands(
  request: RttConnectedCommandRequest,
): Promise<unknown> {
  const invoke = await resolveInvoke();
  if (!invoke) {
    throw new Error("Tauri backend bridge is not connected.");
  }
  return invoke("rtt_command_connected", { request });
}

export async function listenRttConnectionStatus(
  handler: (payload: RttConnectionStatusEvent) => void,
): Promise<() => void> {
  if (!hasTauriRuntime()) {
    return () => {};
  }

  const events = await import("@tauri-apps/api/event");
  return events.listen<RttConnectionStatusEvent>("rtt-connection-status", (event) => {
    handler(event.payload);
  });
}

export async function captureIcmCalibrationConnected(
  request: IcmConnectedCaptureRequest,
): Promise<unknown> {
  const invoke = await resolveInvoke();
  if (!invoke) {
    throw new Error("Tauri backend bridge is not connected.");
  }
  return invoke("icm_capture_calibration_connected", { request });
}
