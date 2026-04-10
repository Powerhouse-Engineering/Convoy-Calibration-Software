import { FormEvent, MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  captureIcmCalibrationConnected,
  callBackend,
  connectRttSession,
  disconnectRttSession,
  getRttConnectionStatus,
  listenGyroRealtimeSamples,
  listenGyroRealtimeStatus,
  listenRttConnectionStatus,
  sendConnectedRttCommands,
  type GyroRealtimeSampleEvent,
  type GyroRealtimeStatusEvent,
  type RttConnectionStatusEvent,
} from "./backendClient";

type BoardCode = "ass" | "asc";
type ImuModel = "icm45686" | "bno086";
type EraseMode = "sector" | "chip";
type TabKey =
  | "target"
  | "firmware"
  | "runtime"
  | "gyroCalibration"
  | "accelCalibration"
  | "calibration";

type LogEntry = {
  ts: string;
  level: "info" | "error";
  text: string;
};

type IcmCalibrationEstimate = {
  sample_count: number;
  gyro_sample_count: number;
  gyro_bias_dps: [number, number, number];
  accel_offset_mps2: [number, number, number];
  accel_xform: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];
  residual_rms_mps2: number;
  residual_max_mps2: number;
};

type IcmCaptureCalibrationResult = {
  estimate: IcmCalibrationEstimate;
  computed_gyro: boolean;
  computed_accel: boolean;
  responses: string[];
};

type GyroPlotPoint = {
  t: number;
  gx: number;
  gy: number;
  gz: number;
};

type GyroAxisKey = "gx" | "gy" | "gz";

type AccelPlotPoint = {
  t: number;
  ax: number;
  ay: number;
  az: number;
};

type AccelAxisKey = "ax" | "ay" | "az";

type RuntimeParamCommand = {
  key: string;
  value: string;
  command: string;
};

type RuntimeApplySnapshot = {
  imu: ImuModel;
  targetKey: string;
  values: Record<string, string>;
};

type ConnectedRttCommandOptions = {
  ackTimeoutMs?: number | null;
  logPrefix?: string;
};

type IcmGyroSample = {
  timestampMs: number;
  gx: number;
  gy: number;
  gz: number;
};

type IcmAccelSample = {
  timestampMs: number;
  ax: number;
  ay: number;
  az: number;
};

type ToolStatus = {
  executable: string;
  available: boolean;
  version: string | null;
  error: string | null;
};

type ToolchainStatus = {
  nrfjprog?: ToolStatus;
  jlink_gdb_server?: ToolStatus;
};

type NativeDialogFilter = {
  name: string;
  extensions: string[];
};

type NativeDialogOpenFn = (options: {
  title?: string;
  directory?: boolean;
  multiple?: boolean;
  defaultPath?: string;
  filters?: NativeDialogFilter[];
}) => Promise<string | string[] | null>;

const BOARD_LABELS: Record<BoardCode, string> = {
  ass: "ASS (app_sensor)",
  asc: "ASC (app_controller)",
};

const TAB_LABELS: Record<TabKey, string> = {
  target: "Target & Tools",
  firmware: "Flash",
  runtime: "Runtime",
  gyroCalibration: "Gyro Calibration",
  accelCalibration: "Accel Calibration",
  calibration: "Calibration",
};

const PLOT_MAX_POINTS = 400;
const PLOT_MAX_BUFFERED_SAMPLES = 1200;
const PLOT_MIN_FRAME_MS = 33;

function toTimestamp(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function isIcmCaptureResult(value: unknown): value is IcmCaptureCalibrationResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<IcmCaptureCalibrationResult>;
  return (
    !!maybe.estimate &&
    typeof maybe.computed_gyro === "boolean" &&
    typeof maybe.computed_accel === "boolean"
  );
}

function encodeBool(value: boolean): string {
  return value ? "1" : "0";
}

function isToolStatus(value: unknown): value is ToolStatus {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<ToolStatus>;
  return (
    typeof maybe.executable === "string" &&
    typeof maybe.available === "boolean" &&
    (typeof maybe.version === "string" || maybe.version === null) &&
    (typeof maybe.error === "string" || maybe.error === null)
  );
}

function isToolchainStatus(value: unknown): value is ToolchainStatus {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<ToolchainStatus>;
  const nrfValid = maybe.nrfjprog === undefined || isToolStatus(maybe.nrfjprog);
  const jlinkValid =
    maybe.jlink_gdb_server === undefined || isToolStatus(maybe.jlink_gdb_server);

  return nrfValid && jlinkValid;
}

function isProbeList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function hasTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined"
  );
}

function createDefaultEstimate(): IcmCalibrationEstimate {
  return {
    sample_count: 0,
    gyro_sample_count: 0,
    gyro_bias_dps: [0, 0, 0],
    accel_offset_mps2: [0, 0, 0],
    accel_xform: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    residual_rms_mps2: 0,
    residual_max_mps2: 0,
  };
}

function stripAnsiSequences(input: string): string {
  return input.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function parseIcmGyroSamples(lines: string[]): IcmGyroSample[] {
  const samples: IcmGyroSample[] = [];

  for (const rawLine of lines) {
    const line = stripAnsiSequences(rawLine);
    const start = line.indexOf("RTT_IMU,ICM45686,");
    if (start < 0) {
      continue;
    }

    const fields = line.slice(start).split(",");
    if (fields.length < 11) {
      continue;
    }

    const timestampMs = Number(fields[3]);
    const gx = Number(fields[8]);
    const gy = Number(fields[9]);
    const gz = Number(fields[10]);

    if (
      Number.isFinite(timestampMs) &&
      Number.isFinite(gx) &&
      Number.isFinite(gy) &&
      Number.isFinite(gz)
    ) {
      samples.push({ timestampMs, gx, gy, gz });
    }
  }

  return samples;
}

function parseIcmAccelSamples(lines: string[]): IcmAccelSample[] {
  const samples: IcmAccelSample[] = [];

  for (const rawLine of lines) {
    const line = stripAnsiSequences(rawLine);
    const start = line.indexOf("RTT_IMU,ICM45686,");
    if (start < 0) {
      continue;
    }

    const fields = line.slice(start).split(",");
    if (fields.length < 8) {
      continue;
    }

    const timestampMs = Number(fields[3]);
    const ax = Number(fields[5]);
    const ay = Number(fields[6]);
    const az = Number(fields[7]);

    if (
      Number.isFinite(timestampMs) &&
      Number.isFinite(ax) &&
      Number.isFinite(ay) &&
      Number.isFinite(az)
    ) {
      samples.push({ timestampMs, ax, ay, az });
    }
  }

  return samples;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>("target");
  const [board, setBoard] = useState<BoardCode>("ass");
  const [imu, setImu] = useState<ImuModel>("icm45686");
  const [eraseMode, setEraseMode] = useState<EraseMode>("sector");

  const [serial, setSerial] = useState("");
  const [flashHexPath, setFlashHexPath] = useState("");

  const [nrfjprogPath, setNrfjprogPath] = useState("");
  const [jlinkGdbServerPath, setJlinkGdbServerPath] = useState("");

  const [deviceName, setDeviceName] = useState("nRF52840_xxAA");
  const [speedKhz, setSpeedKhz] = useState("4000");
  const [gdbPort, setGdbPort] = useState("2335");
  const [rttTelnetPort, setRttTelnetPort] = useState("19025");
  const [connectTimeoutMs, setConnectTimeoutMs] = useState("10000");
  const [ackTimeoutMs, setAckTimeoutMs] = useState("2000");
  const [fastApplyMode, setFastApplyMode] = useState(false);

  const [odrHz, setOdrHz] = useState("200");
  const [streamHz, setStreamHz] = useState("200");

  const [accelRangeG, setAccelRangeG] = useState("16");
  const [gyroRangeDps, setGyroRangeDps] = useState("2000");
  const [lowNoise, setLowNoise] = useState(true);
  const [fifo, setFifo] = useState(true);
  const [fifoHires, setFifoHires] = useState(false);

  const [bnoRaw, setBnoRaw] = useState(true);
  const [bno6dof, setBno6dof] = useState(true);
  const [bno9dof, setBno9dof] = useState(true);

  const [captureSeconds, setCaptureSeconds] = useState("30");
  const [gyroBiasSeconds, setGyroBiasSeconds] = useState("5");
  const [minTotalSamples, setMinTotalSamples] = useState("80");
  const [minGyroSamples, setMinGyroSamples] = useState("20");
  const [minAccelPoints, setMinAccelPoints] = useState("80");
  const [writeGyroBias, setWriteGyroBias] = useState(true);
  const [writeAccel, setWriteAccel] = useState(true);
  const [gyroRealtimePlotEnabled, setGyroRealtimePlotEnabled] = useState(false);
  const [gyroRealtimePlotRunning, setGyroRealtimePlotRunning] = useState(false);
  const [gyroPlotHasData, setGyroPlotHasData] = useState(false);
  const [accelRealtimePlotEnabled, setAccelRealtimePlotEnabled] = useState(false);
  const [accelRealtimePlotRunning, setAccelRealtimePlotRunning] = useState(false);
  const [accelPlotHasData, setAccelPlotHasData] = useState(false);
  const [runtimeStreamRunning, setRuntimeStreamRunning] = useState(false);
  const [rttConnected, setRttConnected] = useState(false);

  const [terminalCommand, setTerminalCommand] = useState("");
  const [autoScrollTerminal, setAutoScrollTerminal] = useState(true);
  const [terminalHeight, setTerminalHeight] = useState(140);
  const [isResizingTerminal, setIsResizingTerminal] = useState(false);

  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [lastEstimate, setLastEstimate] = useState<IcmCalibrationEstimate | null>(null);
  const [hasGyroEstimate, setHasGyroEstimate] = useState(false);
  const [hasAccelEstimate, setHasAccelEstimate] = useState(false);

  const terminalLogRef = useRef<HTMLDivElement | null>(null);
  const terminalResizeStartYRef = useRef(0);
  const terminalResizeStartHeightRef = useRef(140);
  const gyroSampleUnlistenRef = useRef<(() => void) | null>(null);
  const gyroStatusUnlistenRef = useRef<(() => void) | null>(null);
  const accelSampleUnlistenRef = useRef<(() => void) | null>(null);
  const accelStatusUnlistenRef = useRef<(() => void) | null>(null);
  const rttConnectionStatusUnlistenRef = useRef<(() => void) | null>(null);
  const gyroPlotLastTimestampMsRef = useRef<number | null>(null);
  const gyroPlotLastTimeSRef = useRef(0);
  const accelPlotLastTimestampMsRef = useRef<number | null>(null);
  const accelPlotLastTimeSRef = useRef(0);
  const gyroPlotPointsRef = useRef<GyroPlotPoint[]>([]);
  const accelPlotPointsRef = useRef<AccelPlotPoint[]>([]);
  const gyroPlotHasDataRef = useRef(false);
  const accelPlotHasDataRef = useRef(false);
  const gyroPendingSamplesRef = useRef<IcmGyroSample[]>([]);
  const accelPendingSamplesRef = useRef<IcmAccelSample[]>([]);
  const plotFlushRafRef = useRef<number | null>(null);
  const plotLastFlushMsRef = useRef(0);
  const gyroCanvasRefs = useRef<Record<GyroAxisKey, HTMLCanvasElement | null>>({
    gx: null,
    gy: null,
    gz: null,
  });
  const accelCanvasRefs = useRef<Record<AccelAxisKey, HTMLCanvasElement | null>>({
    ax: null,
    ay: null,
    az: null,
  });
  const gyroValueRefs = useRef<Record<GyroAxisKey, HTMLSpanElement | null>>({
    gx: null,
    gy: null,
    gz: null,
  });
  const accelValueRefs = useRef<Record<AccelAxisKey, HTMLSpanElement | null>>({
    ax: null,
    ay: null,
    az: null,
  });
  const lastAppliedRuntimeRef = useRef<RuntimeApplySnapshot | null>(null);

  useEffect(() => {
    const tabsForImu: TabKey[] =
      imu === "icm45686"
        ? ["target", "firmware", "runtime", "gyroCalibration", "accelCalibration"]
        : ["target", "firmware", "runtime", "calibration"];

    if (!tabsForImu.includes(activeTab)) {
      setActiveTab("target");
    }
  }, [imu, activeTab]);

  useEffect(() => {
    if (!autoScrollTerminal || !terminalLogRef.current) {
      return;
    }

    terminalLogRef.current.scrollTop = terminalLogRef.current.scrollHeight;
  }, [logs, autoScrollTerminal]);

  useEffect(() => {
    if (!isResizingTerminal) {
      return;
    }

    function onWindowMouseMove(event: MouseEvent) {
      const dragDelta = terminalResizeStartYRef.current - event.clientY;
      const nextHeight = terminalResizeStartHeightRef.current + dragDelta;
      const clampedHeight = Math.max(90, Math.min(420, nextHeight));
      setTerminalHeight(clampedHeight);
    }

    function onWindowMouseUp() {
      setIsResizingTerminal(false);
    }

    window.addEventListener("mousemove", onWindowMouseMove);
    window.addEventListener("mouseup", onWindowMouseUp);

    return () => {
      window.removeEventListener("mousemove", onWindowMouseMove);
      window.removeEventListener("mouseup", onWindowMouseUp);
    };
  }, [isResizingTerminal]);

  useEffect(() => {
    if (!isResizingTerminal) {
      return;
    }

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [isResizingTerminal]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const unlisten = await listenRttConnectionStatus(
        (payload: RttConnectionStatusEvent) => {
          setRttConnected(payload.connected);
          if (!payload.connected) {
            setRuntimeStreamRunning(false);
            setGyroRealtimePlotRunning(false);
            setAccelRealtimePlotRunning(false);
            gyroPendingSamplesRef.current = [];
            accelPendingSamplesRef.current = [];
            if (plotFlushRafRef.current !== null) {
              window.cancelAnimationFrame(plotFlushRafRef.current);
              plotFlushRafRef.current = null;
            }
            plotLastFlushMsRef.current = 0;
            clearGyroRealtimeListeners();
            clearAccelRealtimeListeners();
          }
          const level: LogEntry["level"] = payload.connected ? "info" : "error";
          pushLog(level, payload.message);
        },
      );
      if (!active) {
        unlisten();
        return;
      }
      rttConnectionStatusUnlistenRef.current = unlisten;
    })();

    return () => {
      active = false;
      if (rttConnectionStatusUnlistenRef.current) {
        const unlisten = rttConnectionStatusUnlistenRef.current;
        rttConnectionStatusUnlistenRef.current = null;
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    void refreshRttConnectionStatus();
  }, []);

  useEffect(() => {
    if (!gyroRealtimePlotEnabled) {
      void stopGyroRealtimePlot();
    }
  }, [gyroRealtimePlotEnabled]);

  useEffect(() => {
    if (!accelRealtimePlotEnabled) {
      void stopAccelRealtimePlot();
    }
  }, [accelRealtimePlotEnabled]);

  useEffect(() => {
    return () => {
      if (plotFlushRafRef.current !== null) {
        window.cancelAnimationFrame(plotFlushRafRef.current);
        plotFlushRafRef.current = null;
      }
      plotLastFlushMsRef.current = 0;
      void stopGyroRealtimePlot();
      void stopAccelRealtimePlot();
      void disconnectRttSession();
    };
  }, []);

  function onTerminalResizeStart(event: ReactMouseEvent<HTMLDivElement>) {
    terminalResizeStartYRef.current = event.clientY;
    terminalResizeStartHeightRef.current = terminalHeight;
    setIsResizingTerminal(true);
    event.preventDefault();
  }

  function pushLog(level: LogEntry["level"], text: string) {
    setLogs((prev) => [...prev, { ts: toTimestamp(), level, text }]);
  }

  async function refreshRttConnectionStatus() {
    try {
      const status = await getRttConnectionStatus();
      setRttConnected(status.connected);
    } catch {
      setRttConnected(false);
    }
  }

  async function disconnectRttPersistentConnection(logWhenAlreadyDisconnected = false): Promise<boolean> {
    try {
      await stopGyroRealtimePlot();
      await stopAccelRealtimePlot();
      const disconnected = await disconnectRttSession();
      setRttConnected(false);
      setRuntimeStreamRunning(false);
      if (!disconnected && logWhenAlreadyDisconnected) {
        pushLog("info", "RTT was already disconnected");
      }
      return disconnected;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushLog("error", message);
      return false;
    }
  }

  async function onConnectRtt() {
    setBusy(true);
    try {
      await connectRttSession(currentRttConnectRequest());
      setRttConnected(true);
      setRuntimeStreamRunning(false);
      lastAppliedRuntimeRef.current = null;
    } catch (error) {
      setRttConnected(false);
      const message = error instanceof Error ? error.message : String(error);
      pushLog("error", message);
    } finally {
      setBusy(false);
    }
  }

  async function onDisconnectRtt() {
    await disconnectRttPersistentConnection(true);
    lastAppliedRuntimeRef.current = null;
  }

  async function onBrowseFlashHex() {
    if (!hasTauriRuntime()) {
      pushLog(
        "error",
        "hex file picker is available only in the desktop app runtime",
      );
      return;
    }

    try {
      const dialog = await import("@tauri-apps/plugin-dialog");
      const open = dialog.open as NativeDialogOpenFn;
      const selection = await open({
        title: "Select calibration firmware .hex",
        directory: false,
        multiple: false,
        defaultPath: flashHexPath.trim() || undefined,
        filters: [{ name: "HEX", extensions: ["hex"] }],
      });

      if (typeof selection === "string") {
        setFlashHexPath(selection);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushLog("error", `failed to open native file picker: ${message}`);
    }
  }

  function globalArgs(): string[] {
    const args: string[] = [];

    if (nrfjprogPath.trim()) {
      args.push("--nrfjprog", nrfjprogPath.trim());
    }

    if (jlinkGdbServerPath.trim()) {
      args.push("--jlink-gdb-server", jlinkGdbServerPath.trim());
    }

    return args;
  }

  function currentRttConnectRequest() {
    return {
      serial_number: serial.trim() || null,
      device_name: deviceName.trim() || "nRF52840_xxAA",
      speed_khz: parsePositiveIntOr(speedKhz, 4000),
      gdb_port: parsePositiveIntOr(gdbPort, 2335),
      rtt_telnet_port: parsePositiveIntOr(rttTelnetPort, 19025),
      connect_timeout_ms: parsePositiveIntOr(connectTimeoutMs, 10000),
      ack_timeout_ms: parsePositiveIntOr(ackTimeoutMs, 2000),
      nrfjprog: nrfjprogPath.trim() || null,
      jlink_gdb_server: jlinkGdbServerPath.trim() || null,
    };
  }

  function rttOptionArgs(): string[] {
    const args: string[] = [];

    if (serial.trim()) {
      args.push("--serial-number", serial.trim());
    }

    args.push("--device-name", deviceName.trim() || "nRF52840_xxAA");
    args.push("--speed-khz", speedKhz.trim() || "4000");
    args.push("--gdb-port", gdbPort.trim() || "2335");
    args.push("--rtt-telnet-port", rttTelnetPort.trim() || "19025");
    args.push("--connect-timeout-ms", connectTimeoutMs.trim() || "10000");
    args.push("--ack-timeout-ms", ackTimeoutMs.trim() || "2000");

    return args;
  }

  function firstBackendCommand(args: string[]): string | null {
    const globalOptionsWithValue = new Set(["--firmware-dir", "--nrfjprog", "--jlink-gdb-server"]);
    let index = 0;
    while (index < args.length) {
      const token = args[index];
      if (globalOptionsWithValue.has(token)) {
        index += 2;
        continue;
      }
      return token;
    }
    return null;
  }

  function commandRequiresExclusiveRttOwnership(command: string | null): boolean {
    return command === "icm-capture-cal" || command === "icm-write-cal";
  }

  async function ensureSessionStateForBackendCommand(args: string[]) {
    const command = firstBackendCommand(args);
    if (commandRequiresExclusiveRttOwnership(command) && rttConnected) {
      await disconnectRttPersistentConnection(true);
    }
  }

  async function reconnectAfterExclusiveBackendCommand() {
    try {
      await connectRttSession(currentRttConnectRequest());
      setRttConnected(true);
      setRuntimeStreamRunning(false);
      pushLog("info", "RTT reconnected after exclusive calibration command");
    } catch (error) {
      setRttConnected(false);
      const message = error instanceof Error ? error.message : String(error);
      pushLog("error", `failed to reconnect RTT after calibration command: ${message}`);
    }
  }

  async function run(args: string[]): Promise<unknown | null> {
    const command = firstBackendCommand(args);
    const shouldReconnectAfter =
      commandRequiresExclusiveRttOwnership(command) && rttConnected;

    await ensureSessionStateForBackendCommand(args);
    setBusy(true);
    try {
      const result = await callBackend(args);
      pushLog("info", `${result.mode.toUpperCase()} ${result.command}`);
      pushLog("info", JSON.stringify(result.output, null, 2));
      return result.output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushLog("error", message);
      return null;
    } finally {
      if (shouldReconnectAfter) {
        await reconnectAfterExclusiveBackendCommand();
      }
      setBusy(false);
    }
  }

  async function runConnectedRttCommands(
    commands: string[],
    options?: ConnectedRttCommandOptions,
  ): Promise<unknown | null> {
    if (commands.length === 0) {
      pushLog("error", "at least one RTT command is required");
      return null;
    }

    if (!rttConnected) {
      pushLog("error", "RTT is not connected. Use Connect first.");
      return null;
    }

    setBusy(true);
    try {
      const ackTimeout =
        options && options.ackTimeoutMs !== undefined
          ? options.ackTimeoutMs
          : parsePositiveIntOr(ackTimeoutMs, 2000);
      const output = await sendConnectedRttCommands({
        commands,
        ack_timeout_ms: ackTimeout ?? null,
      });
      const prefix = options?.logPrefix ?? "RTT";
      pushLog("info", `${prefix} ${commands.join(" ; ")}`);
      pushLog("info", JSON.stringify(output, null, 2));
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (shouldMarkDisconnectedAfterCommandError(message)) {
        setRttConnected(false);
        setRuntimeStreamRunning(false);
      }
      pushLog("error", message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  function resetGyroPlot() {
    gyroPlotPointsRef.current = [];
    gyroPlotLastTimestampMsRef.current = null;
    gyroPlotLastTimeSRef.current = 0;
    gyroPlotHasDataRef.current = false;
    setGyroPlotHasData(false);
    gyroPendingSamplesRef.current = [];
    plotLastFlushMsRef.current = 0;
    drawAllPlotCanvases();
  }

  function resetAccelPlot() {
    accelPlotPointsRef.current = [];
    accelPlotLastTimestampMsRef.current = null;
    accelPlotLastTimeSRef.current = 0;
    accelPlotHasDataRef.current = false;
    setAccelPlotHasData(false);
    accelPendingSamplesRef.current = [];
    plotLastFlushMsRef.current = 0;
    drawAllPlotCanvases();
  }

  function updatePlotValue(ref: HTMLSpanElement | null, value: number | null, unit: string) {
    if (!ref) {
      return;
    }
    if (value === null || !Number.isFinite(value)) {
      ref.textContent = "waiting for samples...";
      return;
    }
    ref.textContent = `${value.toFixed(4)} ${unit}`;
  }

  function drawAxisCanvas<T>(
    canvas: HTMLCanvasElement | null,
    points: T[],
    readValue: (point: T) => number,
    strokeColor: string,
  ): number | null {
    if (!canvas) {
      return null;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }

    const cssWidth = Math.max(1, Math.floor(canvas.clientWidth));
    const cssHeight = Math.max(1, Math.floor(canvas.clientHeight));
    const dpr = window.devicePixelRatio || 1;
    const targetWidth = Math.max(1, Math.round(cssWidth * dpr));
    const targetHeight = Math.max(1, Math.round(cssHeight * dpr));

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);

    if (points.length < 2) {
      if (points.length === 1) {
        return readValue(points[0]);
      }
      return null;
    }

    const padding = 10;
    const drawableWidth = Math.max(1, cssWidth - padding * 2);
    const drawableHeight = Math.max(1, cssHeight - padding * 2);
    let maxAbs = 1;

    for (const point of points) {
      const magnitude = Math.abs(readValue(point));
      if (Number.isFinite(magnitude) && magnitude > maxAbs) {
        maxAbs = magnitude;
      }
    }

    const minY = -maxAbs;
    const maxY = maxAbs;
    const yRange = Math.max(1e-6, maxY - minY);

    const valueToY = (value: number) =>
      padding + (1 - (value - minY) / yRange) * drawableHeight;

    context.strokeStyle = "rgba(20, 35, 47, 0.2)";
    context.lineWidth = 1;
    context.beginPath();
    const zeroLineY = valueToY(0);
    context.moveTo(padding, zeroLineY);
    context.lineTo(cssWidth - padding, zeroLineY);
    context.stroke();

    const targetSegments = Math.max(60, Math.floor(drawableWidth));
    const stride = Math.max(1, Math.floor(points.length / targetSegments));

    context.strokeStyle = strokeColor;
    context.lineWidth = 2;
    context.beginPath();

    for (let idx = 0; idx < points.length; idx += stride) {
      const value = readValue(points[idx]);
      const x = padding + (idx / Math.max(1, points.length - 1)) * drawableWidth;
      const y = valueToY(value);
      if (idx === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    }

    const lastIndex = points.length - 1;
    const lastValue = readValue(points[lastIndex]);
    const lastX = padding + (lastIndex / Math.max(1, points.length - 1)) * drawableWidth;
    const lastY = valueToY(lastValue);
    context.lineTo(lastX, lastY);
    context.stroke();

    return lastValue;
  }

  function drawAllPlotCanvases() {
    const gyroPoints = gyroPlotPointsRef.current;
    const accelPoints = accelPlotPointsRef.current;

    updatePlotValue(
      gyroValueRefs.current.gx,
      drawAxisCanvas(gyroCanvasRefs.current.gx, gyroPoints, (point) => point.gx, "#ef7f45"),
      "dps",
    );
    updatePlotValue(
      gyroValueRefs.current.gy,
      drawAxisCanvas(gyroCanvasRefs.current.gy, gyroPoints, (point) => point.gy, "#0d8f9a"),
      "dps",
    );
    updatePlotValue(
      gyroValueRefs.current.gz,
      drawAxisCanvas(gyroCanvasRefs.current.gz, gyroPoints, (point) => point.gz, "#4a77ff"),
      "dps",
    );
    updatePlotValue(
      accelValueRefs.current.ax,
      drawAxisCanvas(accelCanvasRefs.current.ax, accelPoints, (point) => point.ax, "#ff6f61"),
      "m/s²",
    );
    updatePlotValue(
      accelValueRefs.current.ay,
      drawAxisCanvas(accelCanvasRefs.current.ay, accelPoints, (point) => point.ay, "#2a9d8f"),
      "m/s²",
    );
    updatePlotValue(
      accelValueRefs.current.az,
      drawAxisCanvas(accelCanvasRefs.current.az, accelPoints, (point) => point.az, "#3a86ff"),
      "m/s²",
    );
  }

  function appendGyroPlotSamples(samples: IcmGyroSample[]) {
    if (samples.length === 0) {
      return;
    }

    const fallbackDt = 1 / Math.max(1, Number(streamHz) || 200);
    const points = gyroPlotPointsRef.current;
    let lastTimestampMs = gyroPlotLastTimestampMsRef.current;
    let lastTimeS = gyroPlotLastTimeSRef.current;

    for (const sample of samples) {
      let t = 0;
      if (lastTimestampMs === null) {
        t = 0;
      } else {
        const deltaMs = sample.timestampMs - lastTimestampMs;
        const dt = deltaMs > 0 && deltaMs < 1000 ? deltaMs / 1000 : fallbackDt;
        t = lastTimeS + dt;
      }

      points.push({
        t,
        gx: sample.gx,
        gy: sample.gy,
        gz: sample.gz,
      });

      lastTimestampMs = sample.timestampMs;
      lastTimeS = t;
    }

    if (points.length > PLOT_MAX_POINTS) {
      points.splice(0, points.length - PLOT_MAX_POINTS);
    }

    gyroPlotLastTimestampMsRef.current = lastTimestampMs;
    gyroPlotLastTimeSRef.current = lastTimeS;

    const hasData = points.length >= 2;
    if (hasData !== gyroPlotHasDataRef.current) {
      gyroPlotHasDataRef.current = hasData;
      setGyroPlotHasData(hasData);
    }
  }

  function appendAccelPlotSamples(samples: IcmAccelSample[]) {
    if (samples.length === 0) {
      return;
    }

    const fallbackDt = 1 / Math.max(1, Number(streamHz) || 200);
    const points = accelPlotPointsRef.current;
    let lastTimestampMs = accelPlotLastTimestampMsRef.current;
    let lastTimeS = accelPlotLastTimeSRef.current;

    for (const sample of samples) {
      let t = 0;
      if (lastTimestampMs === null) {
        t = 0;
      } else {
        const deltaMs = sample.timestampMs - lastTimestampMs;
        const dt = deltaMs > 0 && deltaMs < 1000 ? deltaMs / 1000 : fallbackDt;
        t = lastTimeS + dt;
      }

      points.push({
        t,
        ax: sample.ax,
        ay: sample.ay,
        az: sample.az,
      });

      lastTimestampMs = sample.timestampMs;
      lastTimeS = t;
    }

    if (points.length > PLOT_MAX_POINTS) {
      points.splice(0, points.length - PLOT_MAX_POINTS);
    }

    accelPlotLastTimestampMsRef.current = lastTimestampMs;
    accelPlotLastTimeSRef.current = lastTimeS;

    const hasData = points.length >= 2;
    if (hasData !== accelPlotHasDataRef.current) {
      accelPlotHasDataRef.current = hasData;
      setAccelPlotHasData(hasData);
    }
  }

  function schedulePlotFlush() {
    if (plotFlushRafRef.current !== null) {
      return;
    }

    const flushOnFrame = (frameTimeMs: number) => {
      if (frameTimeMs - plotLastFlushMsRef.current < PLOT_MIN_FRAME_MS) {
        plotFlushRafRef.current = window.requestAnimationFrame(flushOnFrame);
        return;
      }

      plotFlushRafRef.current = null;
      plotLastFlushMsRef.current = frameTimeMs;

      if (gyroPendingSamplesRef.current.length > 0) {
        const gyroBatch = gyroPendingSamplesRef.current;
        gyroPendingSamplesRef.current = [];
        appendGyroPlotSamples(gyroBatch);
      }

      if (accelPendingSamplesRef.current.length > 0) {
        const accelBatch = accelPendingSamplesRef.current;
        accelPendingSamplesRef.current = [];
        appendAccelPlotSamples(accelBatch);
      }

      drawAllPlotCanvases();

      if (gyroPendingSamplesRef.current.length > 0 || accelPendingSamplesRef.current.length > 0) {
        schedulePlotFlush();
      }
    };

    plotFlushRafRef.current = window.requestAnimationFrame(flushOnFrame);
  }

  function queueGyroPlotSample(sample: IcmGyroSample) {
    gyroPendingSamplesRef.current.push(sample);
    const maxBuffered = PLOT_MAX_BUFFERED_SAMPLES;
    if (gyroPendingSamplesRef.current.length > maxBuffered) {
      gyroPendingSamplesRef.current = gyroPendingSamplesRef.current.slice(-maxBuffered);
    }
    schedulePlotFlush();
  }

  function queueAccelPlotSample(sample: IcmAccelSample) {
    accelPendingSamplesRef.current.push(sample);
    const maxBuffered = PLOT_MAX_BUFFERED_SAMPLES;
    if (accelPendingSamplesRef.current.length > maxBuffered) {
      accelPendingSamplesRef.current = accelPendingSamplesRef.current.slice(-maxBuffered);
    }
    schedulePlotFlush();
  }

  function clearGyroRealtimeListeners() {
    if (gyroSampleUnlistenRef.current) {
      const unlisten = gyroSampleUnlistenRef.current;
      gyroSampleUnlistenRef.current = null;
      unlisten();
    }
    if (gyroStatusUnlistenRef.current) {
      const unlisten = gyroStatusUnlistenRef.current;
      gyroStatusUnlistenRef.current = null;
      unlisten();
    }
  }

  function clearAccelRealtimeListeners() {
    if (accelSampleUnlistenRef.current) {
      const unlisten = accelSampleUnlistenRef.current;
      accelSampleUnlistenRef.current = null;
      unlisten();
    }
    if (accelStatusUnlistenRef.current) {
      const unlisten = accelStatusUnlistenRef.current;
      accelStatusUnlistenRef.current = null;
      unlisten();
    }
  }

  function parsePositiveIntOr(value: string, fallback: number): number {
    const parsed = Number.parseInt(value.trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }
    return parsed;
  }

  function shouldMarkDisconnectedAfterCommandError(message: string): boolean {
    const lower = message.toLowerCase();
    return (
      lower.includes("broken pipe") ||
      lower.includes("connection reset") ||
      lower.includes("not connected") ||
      lower.includes("unexpected eof") ||
      lower.includes("rtt is not connected") ||
      lower.includes("rtt disconnected")
    );
  }

  async function stopGyroRealtimePlot() {
    const wasRunning = gyroRealtimePlotRunning;
    setGyroRealtimePlotRunning(false);
    gyroPendingSamplesRef.current = [];
    clearGyroRealtimeListeners();
    if (wasRunning) {
      pushLog("info", "gyro real-time plotting stopped");
    }
  }

  const terminalLogContent = useMemo(() => {
    if (logs.length === 0) {
      return <div className="terminal-empty">No logs yet.</div>;
    }

    return logs.map((entry, idx) => (
      <pre key={`${entry.ts}-${idx}`} className={`terminal-line ${entry.level}`}>
        [{entry.ts}] {entry.text}
      </pre>
    ));
  }, [logs]);

  async function startGyroRealtimePlot() {
    if (imu !== "icm45686") {
      pushLog("error", "real-time gyro plotting is available only for ICM45686");
      return;
    }

    if (!gyroRealtimePlotEnabled) {
      pushLog("error", "enable real-time plotting first");
      return;
    }

    if (gyroRealtimePlotRunning) {
      return;
    }

    clearGyroRealtimeListeners();
    resetGyroPlot();
    setGyroRealtimePlotRunning(true);

    try {
      const unlistenSamples = await listenGyroRealtimeSamples(
        (payload: GyroRealtimeSampleEvent) => {
          queueGyroPlotSample({
            timestampMs: payload.timestamp_ms,
            gx: payload.gx,
            gy: payload.gy,
            gz: payload.gz,
          });
        },
      );
      const unlistenStatus = await listenGyroRealtimeStatus(
        (payload: GyroRealtimeStatusEvent) => {
          const level: LogEntry["level"] = payload.level === "error" ? "error" : "info";
          pushLog(level, payload.message);
        },
      );

      gyroSampleUnlistenRef.current = unlistenSamples;
      gyroStatusUnlistenRef.current = unlistenStatus;

      pushLog("info", "gyro real-time plotting started");
      if (!runtimeStreamRunning && !busy) {
        pushLog(
          "info",
          "plot is enabled. start stream or capture to receive live gyro samples",
        );
      }
    } catch (error) {
      setGyroRealtimePlotRunning(false);
      clearGyroRealtimeListeners();
      const message = error instanceof Error ? error.message : String(error);
      pushLog("error", message);
    }
  }

  async function stopAccelRealtimePlot() {
    const wasRunning = accelRealtimePlotRunning;
    setAccelRealtimePlotRunning(false);
    accelPendingSamplesRef.current = [];
    clearAccelRealtimeListeners();
    if (wasRunning) {
      pushLog("info", "accelerometer real-time plotting stopped");
    }
  }

  async function startAccelRealtimePlot() {
    if (imu !== "icm45686") {
      pushLog("error", "real-time accelerometer plotting is available only for ICM45686");
      return;
    }

    if (!accelRealtimePlotEnabled) {
      pushLog("error", "enable real-time accelerometer plotting first");
      return;
    }

    if (accelRealtimePlotRunning) {
      return;
    }

    clearAccelRealtimeListeners();
    resetAccelPlot();
    setAccelRealtimePlotRunning(true);

    try {
      const unlistenSamples = await listenGyroRealtimeSamples(
        (payload: GyroRealtimeSampleEvent) => {
          queueAccelPlotSample({
            timestampMs: payload.timestamp_ms,
            ax: payload.ax,
            ay: payload.ay,
            az: payload.az,
          });
        },
      );
      const unlistenStatus = await listenGyroRealtimeStatus(
        (payload: GyroRealtimeStatusEvent) => {
          const level: LogEntry["level"] = payload.level === "error" ? "error" : "info";
          pushLog(level, payload.message);
        },
      );

      accelSampleUnlistenRef.current = unlistenSamples;
      accelStatusUnlistenRef.current = unlistenStatus;

      pushLog("info", "accelerometer real-time plotting started");
      if (!runtimeStreamRunning && !busy) {
        pushLog(
          "info",
          "plot is enabled. start stream or capture to receive live accelerometer samples",
        );
      }
    } catch (error) {
      setAccelRealtimePlotRunning(false);
      clearAccelRealtimeListeners();
      const message = error instanceof Error ? error.message : String(error);
      pushLog("error", message);
    }
  }

  async function onFlash(event: FormEvent) {
    event.preventDefault();
    const selectedHex = flashHexPath.trim();
    if (!selectedHex) {
      pushLog("error", "flash hex file is required");
      return;
    }

    const args = [
      ...globalArgs(),
      "flash",
      "--board",
      board,
      "--imu",
      imu,
      "--erase",
      eraseMode,
      "--hex",
      selectedHex,
    ];

    if (serial.trim()) {
      args.push("--serial-number", serial.trim());
    }

    const output = await run(args);
    if (output !== null) {
      lastAppliedRuntimeRef.current = null;
    }
  }

  function buildRuntimeApplyPlan(): {
    imuCommand: string;
    params: RuntimeParamCommand[];
    snapshot: RuntimeApplySnapshot;
  } {
    const targetKey = `${serial.trim() || "default"}|${deviceName.trim() || "nRF52840_xxAA"}`;

    if (imu === "icm45686") {
      const params: RuntimeParamCommand[] = [
        { key: "stream_format", value: "CSV", command: "STREAM_FORMAT CSV" },
        {
          key: "stream_hz",
          value: streamHz.trim() || "200",
          command: `STREAM_HZ ${streamHz.trim() || "200"}`,
        },
        {
          key: "odr_hz",
          value: odrHz.trim() || "200",
          command: `ODR ${odrHz.trim() || "200"}`,
        },
        {
          key: "accel_range_g",
          value: accelRangeG.trim() || "16",
          command: `ACCEL_RANGE ${accelRangeG.trim() || "16"}`,
        },
        {
          key: "gyro_range_dps",
          value: gyroRangeDps.trim() || "2000",
          command: `GYRO_RANGE ${gyroRangeDps.trim() || "2000"}`,
        },
        {
          key: "low_noise",
          value: encodeBool(lowNoise),
          command: `LOW_NOISE ${encodeBool(lowNoise)}`,
        },
        {
          key: "fifo",
          value: encodeBool(fifo),
          command: `FIFO ${encodeBool(fifo)}`,
        },
        {
          key: "fifo_hires",
          value: encodeBool(fifoHires),
          command: `FIFO_HIRES ${encodeBool(fifoHires)}`,
        },
      ];

      return {
        imuCommand: "IMU ICM45686",
        params,
        snapshot: {
          imu,
          targetKey,
          values: Object.fromEntries(params.map((entry) => [entry.key, entry.value])),
        },
      };
    }

    const params: RuntimeParamCommand[] = [
      { key: "stream_format", value: "CSV", command: "STREAM_FORMAT CSV" },
      {
        key: "stream_hz",
        value: streamHz.trim() || "100",
        command: `STREAM_HZ ${streamHz.trim() || "100"}`,
      },
      {
        key: "odr_hz",
        value: odrHz.trim() || "100",
        command: `ODR ${odrHz.trim() || "100"}`,
      },
      {
        key: "bno_raw",
        value: encodeBool(bnoRaw),
        command: `BNO_RAW ${encodeBool(bnoRaw)}`,
      },
      {
        key: "bno_6dof",
        value: encodeBool(bno6dof),
        command: `BNO_6DOF ${encodeBool(bno6dof)}`,
      },
      {
        key: "bno_9dof",
        value: encodeBool(bno9dof),
        command: `BNO_9DOF ${encodeBool(bno9dof)}`,
      },
    ];

    return {
      imuCommand: "IMU BNO086",
      params,
      snapshot: {
        imu,
        targetKey,
        values: Object.fromEntries(params.map((entry) => [entry.key, entry.value])),
      },
    };
  }

  async function onConfigureImu() {
    const plan = buildRuntimeApplyPlan();
    const previousSnapshot = lastAppliedRuntimeRef.current;

    if (fastApplyMode) {
      const changedParams = plan.params.filter((entry) => {
        if (
          !previousSnapshot ||
          previousSnapshot.imu !== plan.snapshot.imu ||
          previousSnapshot.targetKey !== plan.snapshot.targetKey
        ) {
          return true;
        }
        return previousSnapshot.values[entry.key] !== entry.value;
      });

      if (
        changedParams.length === 0 &&
        previousSnapshot &&
        previousSnapshot.imu === plan.snapshot.imu &&
        previousSnapshot.targetKey === plan.snapshot.targetKey
      ) {
        pushLog("info", "fast apply: no runtime parameter changes detected, skipping apply");
        return;
      }

      const fastCommands = [plan.imuCommand, ...changedParams.map((entry) => entry.command), "APPLY"];
      const output = await runConnectedRttCommands(fastCommands, {
        logPrefix: "RTT FAST_APPLY",
      });
      if (output !== null) {
        lastAppliedRuntimeRef.current = plan.snapshot;
        setRuntimeStreamRunning(false);
        pushLog("info", `fast apply: applied ${changedParams.length} changed parameter(s)`);
      }
      return;
    }

    const output = await runConnectedRttCommands(
      [plan.imuCommand, ...plan.params.map((entry) => entry.command), "APPLY", "STATUS"],
      { logPrefix: "RTT APPLY" },
    );
    if (output !== null) {
      lastAppliedRuntimeRef.current = plan.snapshot;
      setRuntimeStreamRunning(false);
    }
  }

  async function onStatus() {
    if (runtimeStreamRunning) {
      const output = await runConnectedRttCommands(["STOP", "STATUS", "START"], {
        logPrefix: "RTT STATUS_SAFE",
      });
      if (output !== null) {
        setRuntimeStreamRunning(true);
        return;
      }
      pushLog("info", "status-safe sequence failed, retrying direct STATUS");
    }

    const output = await runConnectedRttCommands(["STATUS"], { logPrefix: "RTT STATUS" });
    if (output !== null && !runtimeStreamRunning) {
      setRuntimeStreamRunning(false);
    }
  }

  async function onStartStream() {
    const output = await runConnectedRttCommands(["START"]);
    if (output !== null) {
      setRuntimeStreamRunning(true);
    }
  }

  async function onStopStream() {
    const output = await runConnectedRttCommands(["STOP"]);
    if (output !== null) {
      setRuntimeStreamRunning(false);
      await stopGyroRealtimePlot();
      await stopAccelRealtimePlot();
    }
  }

  async function onCaptureIcmCalibration(computeGyro: boolean, computeAccel: boolean) {
    if (imu !== "icm45686") {
      pushLog("error", "capture+compute is currently implemented for ICM45686");
      return;
    }

    if (!computeGyro && !computeAccel) {
      pushLog("error", "select at least one calculation mode (gyro or accel)");
      return;
    }

    if (!rttConnected) {
      pushLog("error", "RTT is not connected. Use Connect first.");
      return;
    }

    const keepStreamRunningDuringAndAfterCapture =
      runtimeStreamRunning || gyroRealtimePlotRunning || accelRealtimePlotRunning;
    setBusy(true);
    let output: unknown | null = null;
    try {
      output = await captureIcmCalibrationConnected({
        serial_number: serial.trim() || null,
        device_name: deviceName.trim() || "nRF52840_xxAA",
        speed_khz: parsePositiveIntOr(speedKhz, 4000),
        gdb_port: parsePositiveIntOr(gdbPort, 2335),
        rtt_telnet_port: parsePositiveIntOr(rttTelnetPort, 19025),
        connect_timeout_ms: parsePositiveIntOr(connectTimeoutMs, 10000),
        ack_timeout_ms: parsePositiveIntOr(ackTimeoutMs, 2000),
        capture_seconds: Number.parseFloat(captureSeconds.trim()) || 30,
        gyro_bias_seconds: Number.parseFloat(gyroBiasSeconds.trim()) || 5,
        compute_gyro: computeGyro,
        compute_accel: computeAccel,
        min_total_samples: parsePositiveIntOr(minTotalSamples, 80),
        min_gyro_samples: parsePositiveIntOr(minGyroSamples, 20),
        min_accel_points: parsePositiveIntOr(minAccelPoints, 80),
        odr_hz: parsePositiveIntOr(odrHz, 200),
        stream_hz: parsePositiveIntOr(streamHz, 200),
        accel_range_g: parsePositiveIntOr(accelRangeG, 16),
        gyro_range_dps: parsePositiveIntOr(gyroRangeDps, 2000),
        low_noise: lowNoise,
        fifo: fifo,
        fifo_hires: fifoHires,
        keep_stream_running: keepStreamRunningDuringAndAfterCapture,
      });
      pushLog("info", "RTT CAPTURE_CAL (connected session)");
      pushLog("info", JSON.stringify(output, null, 2));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (shouldMarkDisconnectedAfterCommandError(message)) {
        setRttConnected(false);
        setRuntimeStreamRunning(false);
      }
      pushLog("error", message);
    } finally {
      setBusy(false);
    }

    if (!isIcmCaptureResult(output)) {
      return;
    }

    const base = lastEstimate ?? createDefaultEstimate();
    const merged: IcmCalibrationEstimate = {
      ...base,
      sample_count: output.estimate.sample_count,
    };

    if (output.computed_gyro) {
      merged.gyro_sample_count = output.estimate.gyro_sample_count;
      merged.gyro_bias_dps = output.estimate.gyro_bias_dps;
      setHasGyroEstimate(true);
      pushLog(
        "info",
        `Gyro calibration computed. gyro_samples=${output.estimate.gyro_sample_count}, gyro_bias=[${output.estimate.gyro_bias_dps.map((v) => v.toFixed(5)).join(", ")}]`,
      );

      if (gyroRealtimePlotEnabled && !gyroRealtimePlotRunning) {
        appendGyroPlotSamples(parseIcmGyroSamples(output.responses));
      }
    }

    if (output.computed_accel) {
      merged.accel_offset_mps2 = output.estimate.accel_offset_mps2;
      merged.accel_xform = output.estimate.accel_xform;
      merged.residual_rms_mps2 = output.estimate.residual_rms_mps2;
      merged.residual_max_mps2 = output.estimate.residual_max_mps2;
      setHasAccelEstimate(true);
      pushLog(
        "info",
        `Accel calibration computed. samples=${output.estimate.sample_count}, rms=${output.estimate.residual_rms_mps2.toFixed(5)}, max=${output.estimate.residual_max_mps2.toFixed(5)}`,
      );

      if (accelRealtimePlotEnabled && !accelRealtimePlotRunning) {
        appendAccelPlotSamples(parseIcmAccelSamples(output.responses));
      }
    }

    setLastEstimate(merged);
    setRuntimeStreamRunning(keepStreamRunningDuringAndAfterCapture);
  }

  async function onWriteIcmCalibration(writeGyro: boolean, writeAccelCal: boolean) {
    if (imu !== "icm45686") {
      pushLog("error", "write calibration is currently implemented for ICM45686");
      return;
    }

    if (!writeGyro && !writeAccelCal) {
      pushLog("error", "select at least one calibration to write (gyro or accel)");
      return;
    }

    if (writeGyro && !hasGyroEstimate) {
      pushLog("error", "no computed gyro calibration available.");
      return;
    }

    if (writeAccelCal && !hasAccelEstimate) {
      pushLog("error", "no computed accelerometer calibration available.");
      return;
    }

    if (!lastEstimate) {
      pushLog("error", "no computed calibration available.");
      return;
    }

    const estimateToWrite: IcmCalibrationEstimate = {
      ...createDefaultEstimate(),
      ...lastEstimate,
      sample_count: lastEstimate.sample_count,
    };

    const estimateJson = JSON.stringify(estimateToWrite);

    await run([
      ...globalArgs(),
      "icm-write-cal",
      ...rttOptionArgs(),
      "--odr-hz",
      odrHz.trim() || "200",
      "--accel-range-g",
      accelRangeG.trim() || "16",
      "--gyro-range-dps",
      gyroRangeDps.trim() || "2000",
      "--low-noise",
      encodeBool(lowNoise),
      "--fifo",
      encodeBool(fifo),
      "--fifo-hires",
      encodeBool(fifoHires),
      "--write-gyro-bias",
      encodeBool(writeGyro),
      "--write-accel",
      encodeBool(writeAccelCal),
      "--estimate-json",
      estimateJson,
    ]);
  }

  async function onBnoCalStart() {
    const output = await runConnectedRttCommands(["IMU BNO086", "APPLY", "CAL_START", "START"]);
    if (output !== null) {
      setRuntimeStreamRunning(true);
    }
  }

  async function onBnoCalReady() {
    await runConnectedRttCommands(["IMU BNO086", "CAL_READY", "CAL_STATUS"]);
  }

  async function onBnoCalSave() {
    const output = await runConnectedRttCommands(["IMU BNO086", "STOP", "CAL_SAVE", "CAL_STATUS"]);
    if (output !== null) {
      setRuntimeStreamRunning(false);
    }
  }

  async function onSendTerminalCommand(event: FormEvent) {
    event.preventDefault();

    const raw = terminalCommand.trim();
    if (!raw) {
      return;
    }

    const commands = raw
      .split(";")
      .map((cmd) => cmd.trim())
      .filter((cmd) => cmd.length > 0);

    if (commands.length === 0) {
      return;
    }

    setTerminalCommand("");
    const output = await runConnectedRttCommands(commands);
    if (output !== null) {
      const upperCommands = commands.map((cmd) => cmd.trim().toUpperCase());
      if (upperCommands.some((cmd) => cmd === "START")) {
        setRuntimeStreamRunning(true);
      }
      if (upperCommands.some((cmd) => cmd === "STOP")) {
        setRuntimeStreamRunning(false);
      }
    }
  }

  async function onAutoDetectTargetSettings() {
    const toolsOutput = await run(["tools"]);
    if (isToolchainStatus(toolsOutput)) {
      if (toolsOutput.nrfjprog && toolsOutput.nrfjprog.available) {
        setNrfjprogPath(toolsOutput.nrfjprog.executable);
      }

      if (toolsOutput.jlink_gdb_server && toolsOutput.jlink_gdb_server.available) {
        setJlinkGdbServerPath(toolsOutput.jlink_gdb_server.executable);
      }
    }

    const probesOutput = await run(["probes"]);
    if (!isProbeList(probesOutput)) {
      return;
    }

    if (probesOutput.length === 0) {
      pushLog("error", "auto detect: no probes found");
      return;
    }

    setSerial(probesOutput[0]);
    if (probesOutput.length > 1) {
      pushLog("info", `auto detect: selected first probe serial ${probesOutput[0]}`);
    } else {
      pushLog("info", `auto detect: selected probe serial ${probesOutput[0]}`);
    }
  }

  function renderGyroAxisPlot(axisKey: GyroAxisKey, title: string) {
    return (
      <div className="gyro-plot-card">
        <div className="gyro-plot-header">
          <strong>{title}</strong>
          <span
            className="gyro-plot-value"
            ref={(node) => {
              gyroValueRefs.current[axisKey] = node;
            }}
          >
            waiting for samples...
          </span>
        </div>
        {!gyroPlotHasData ? <div className="gyro-plot-empty">Not enough data yet.</div> : null}
        <canvas
          className="gyro-plot-canvas"
          ref={(node) => {
            gyroCanvasRefs.current[axisKey] = node;
            if (node) {
              drawAllPlotCanvases();
            }
          }}
        />
      </div>
    );
  }

  function renderAccelAxisPlot(axisKey: AccelAxisKey, title: string) {
    return (
      <div className="gyro-plot-card">
        <div className="gyro-plot-header">
          <strong>{title}</strong>
          <span
            className="gyro-plot-value"
            ref={(node) => {
              accelValueRefs.current[axisKey] = node;
            }}
          >
            waiting for samples...
          </span>
        </div>
        {!accelPlotHasData ? <div className="gyro-plot-empty">Not enough data yet.</div> : null}
        <canvas
          className="gyro-plot-canvas"
          ref={(node) => {
            accelCanvasRefs.current[axisKey] = node;
            if (node) {
              drawAllPlotCanvases();
            }
          }}
        />
      </div>
    );
  }

  function renderTargetTab() {
    return (
      <div className="tab-content-block">
        <h2 className="section-title">Target and Toolchain</h2>
        <div className="grid grid-3">
          <label>
            Board
            <select value={board} onChange={(event) => setBoard(event.target.value as BoardCode)}>
              <option value="ass">{BOARD_LABELS.ass}</option>
              <option value="asc">{BOARD_LABELS.asc}</option>
            </select>
          </label>

          <label>
            IMU
            <select value={imu} onChange={(event) => setImu(event.target.value as ImuModel)}>
              <option value="icm45686">ICM45686</option>
              <option value="bno086">BNO086</option>
            </select>
          </label>

          <label>
            Probe Serial (optional)
            <input
              type="text"
              value={serial}
              onChange={(event) => setSerial(event.target.value)}
              placeholder="e.g. 1050123456"
            />
          </label>

          <label>
            Flash HEX File
            <div className="path-picker">
              <input
                type="text"
                value={flashHexPath}
                onChange={(event) => setFlashHexPath(event.target.value)}
                placeholder="/absolute/path/to/calibration.hex"
              />
              <button type="button" onClick={onBrowseFlashHex} disabled={busy}>
                Browse
              </button>
            </div>
          </label>

          <label>
            nrfjprog Executable
            <input
              type="text"
              value={nrfjprogPath}
              onChange={(event) => setNrfjprogPath(event.target.value)}
              placeholder="nrfjprog"
            />
          </label>

          <label>
            J-Link GDB Server
            <input
              type="text"
              value={jlinkGdbServerPath}
              onChange={(event) => setJlinkGdbServerPath(event.target.value)}
              placeholder="JLinkGDBServerCLExe"
            />
          </label>
        </div>

        <div className="action-row">
          <button disabled={busy} onClick={onAutoDetectTargetSettings}>
            Auto Detect
          </button>
          <button disabled={busy} onClick={() => run([...globalArgs(), "tools"])}>
            Check Tools
          </button>
          <button disabled={busy} onClick={() => run([...globalArgs(), "probes"])}>
            List Probes
          </button>
        </div>
      </div>
    );
  }

  function renderFirmwareTab() {
    return (
      <div className="tab-content-block">
        <h2 className="section-title">Flash Firmware</h2>
        <div className="grid grid-2">
          <label>
            Erase Mode
            <select
              value={eraseMode}
              onChange={(event) => setEraseMode(event.target.value as EraseMode)}
            >
              <option value="sector">Sector (recommended)</option>
              <option value="chip">Chip (full erase)</option>
            </select>
          </label>
        </div>

        <div className="info-note">
          Target: <strong>{BOARD_LABELS[board]}</strong> | IMU: <strong>{imu}</strong> | HEX:{" "}
          <strong>{flashHexPath.trim() || "(not selected)"}</strong>
        </div>

        <div className="action-row">
          <button disabled={busy || !flashHexPath.trim()} onClick={onFlash}>
            Flash Selected HEX
          </button>
        </div>
      </div>
    );
  }

  function renderRuntimeTab() {
    return (
      <div className="tab-content-block">
        <h2 className="section-title">RTT Session and IMU Runtime Config</h2>
        <div className="grid grid-3">
          <label>
            Device Name
            <input
              type="text"
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              placeholder="nRF52840_xxAA"
            />
          </label>

          <label>
            SWD Speed (kHz)
            <input type="number" value={speedKhz} onChange={(event) => setSpeedKhz(event.target.value)} />
          </label>

          <label>
            GDB Port
            <input type="number" value={gdbPort} onChange={(event) => setGdbPort(event.target.value)} />
          </label>

          <label>
            RTT Telnet Port
            <input
              type="number"
              value={rttTelnetPort}
              onChange={(event) => setRttTelnetPort(event.target.value)}
            />
          </label>

          <label>
            Connect Timeout (ms)
            <input
              type="number"
              value={connectTimeoutMs}
              onChange={(event) => setConnectTimeoutMs(event.target.value)}
            />
          </label>

          <label>
            ACK Timeout (ms)
            <input
              type="number"
              value={ackTimeoutMs}
              onChange={(event) => setAckTimeoutMs(event.target.value)}
            />
          </label>

          <label>
            ODR (Hz)
            <input type="number" value={odrHz} onChange={(event) => setOdrHz(event.target.value)} />
          </label>

          <label>
            Stream Rate (Hz)
            <input type="number" value={streamHz} onChange={(event) => setStreamHz(event.target.value)} />
          </label>

          {imu === "icm45686" ? (
            <label>
              Accel Range (g)
              <select value={accelRangeG} onChange={(event) => setAccelRangeG(event.target.value)}>
                <option value="2">2</option>
                <option value="4">4</option>
                <option value="8">8</option>
                <option value="16">16</option>
              </select>
            </label>
          ) : (
            <label>
              BNO Raw Sensors
              <select value={encodeBool(bnoRaw)} onChange={(event) => setBnoRaw(event.target.value === "1")}>
                <option value="1">Enabled</option>
                <option value="0">Disabled</option>
              </select>
            </label>
          )}

          {imu === "icm45686" ? (
            <label>
              Gyro Range (dps)
              <select value={gyroRangeDps} onChange={(event) => setGyroRangeDps(event.target.value)}>
                <option value="125">125</option>
                <option value="250">250</option>
                <option value="500">500</option>
                <option value="1000">1000</option>
                <option value="2000">2000</option>
              </select>
            </label>
          ) : (
            <label>
              BNO 6DOF
              <select value={encodeBool(bno6dof)} onChange={(event) => setBno6dof(event.target.value === "1")}>
                <option value="1">Enabled</option>
                <option value="0">Disabled</option>
              </select>
            </label>
          )}

          {imu === "icm45686" ? (
            <label>
              Low Noise
              <select value={encodeBool(lowNoise)} onChange={(event) => setLowNoise(event.target.value === "1")}>
                <option value="1">Enabled</option>
                <option value="0">Disabled</option>
              </select>
            </label>
          ) : (
            <label>
              BNO 9DOF
              <select value={encodeBool(bno9dof)} onChange={(event) => setBno9dof(event.target.value === "1")}>
                <option value="1">Enabled</option>
                <option value="0">Disabled</option>
              </select>
            </label>
          )}

          {imu === "icm45686" ? (
            <label>
              FIFO
              <select value={encodeBool(fifo)} onChange={(event) => setFifo(event.target.value === "1")}>
                <option value="1">Enabled</option>
                <option value="0">Disabled</option>
              </select>
            </label>
          ) : (
            <div />
          )}

          {imu === "icm45686" ? (
            <label>
              FIFO High Resolution
              <select value={encodeBool(fifoHires)} onChange={(event) => setFifoHires(event.target.value === "1")}>
                <option value="1">Enabled</option>
                <option value="0">Disabled</option>
              </select>
            </label>
          ) : (
            <div />
          )}
        </div>

        <p className="info-note">
          RTT commands in this tab use the persistent connection. Use the Connect / Disconnect
          buttons in the top bar.
        </p>

        <label className="checkbox-inline">
          <input
            type="checkbox"
            checked={fastApplyMode}
            onChange={(event) => setFastApplyMode(event.target.checked)}
          />
          Fast Apply mode (only changed parameters, skip STATUS)
        </label>

        <div className="action-row">
          <button disabled={busy || !rttConnected} onClick={onConfigureImu}>
            Configure + Apply
          </button>
          <button disabled={busy || !rttConnected} onClick={onStartStream}>
            Start Stream
          </button>
          <button disabled={busy || !rttConnected} onClick={onStopStream}>
            Stop Stream
          </button>
          <button disabled={busy || !rttConnected} onClick={onStatus}>
            Read Status
          </button>
        </div>
      </div>
    );
  }

  function renderGyroCalibrationTab() {
    if (imu !== "icm45686") {
      return (
        <div className="tab-content-block">
          <h2 className="section-title">Gyroscope Calibration</h2>
          <p className="info-note">Gyroscope host calibration is available only for ICM45686.</p>
        </div>
      );
    }

    return (
      <div className="tab-content-block">
        <h2 className="section-title">Gyroscope Calibration</h2>
        <div className="grid grid-2">
          <label>
            Capture Duration (s)
            <input
              type="number"
              value={captureSeconds}
              onChange={(event) => setCaptureSeconds(event.target.value)}
            />
          </label>
          <label>
            Gyro Bias Window (s)
            <input
              type="number"
              value={gyroBiasSeconds}
              onChange={(event) => setGyroBiasSeconds(event.target.value)}
            />
          </label>
          <label>
            Min Total Samples
            <input
              type="number"
              value={minTotalSamples}
              onChange={(event) => setMinTotalSamples(event.target.value)}
            />
          </label>
          <label>
            Min Gyro Samples
            <input
              type="number"
              value={minGyroSamples}
              onChange={(event) => setMinGyroSamples(event.target.value)}
            />
          </label>
        </div>

        <div className="action-row">
          <button disabled={busy} onClick={() => onCaptureIcmCalibration(true, false)}>
            Capture + Compute Gyro
          </button>
        </div>

        <label className="checkbox-inline">
          <input
            type="checkbox"
            checked={writeGyroBias}
            onChange={(event) => setWriteGyroBias(event.target.checked)}
          />
          Enable write gyroscope calibration
        </label>

        <div className="action-row">
          <button
            disabled={busy || !writeGyroBias || !lastEstimate || !hasGyroEstimate}
            onClick={() => onWriteIcmCalibration(true, false)}
          >
            Write Gyroscope Calibration
          </button>
        </div>

        <label className="checkbox-inline">
          <input
            type="checkbox"
            checked={gyroRealtimePlotEnabled}
            onChange={(event) => setGyroRealtimePlotEnabled(event.target.checked)}
          />
          Enable real-time gyro plotting
        </label>

        {gyroRealtimePlotEnabled ? (
          <>
            <div className="action-row">
              <button disabled={gyroRealtimePlotRunning} onClick={startGyroRealtimePlot}>
                Start Plot
              </button>
              <button onClick={stopGyroRealtimePlot}>Stop Plot</button>
              <button onClick={resetGyroPlot}>Clear Plot</button>
            </div>
            <div className="gyro-plots-grid">
              {renderGyroAxisPlot("gx", "Gyro X Axis")}
              {renderGyroAxisPlot("gy", "Gyro Y Axis")}
              {renderGyroAxisPlot("gz", "Gyro Z Axis")}
            </div>
          </>
        ) : null}

        <h3 className="section-subtitle">Last Gyro Estimate</h3>
        {hasGyroEstimate && lastEstimate ? (
          <pre className="mono-block">
            {JSON.stringify(
              {
                gyro_sample_count: lastEstimate.gyro_sample_count,
                gyro_bias_dps: lastEstimate.gyro_bias_dps,
              },
              null,
              2,
            )}
          </pre>
        ) : (
          <p className="info-note">No gyroscope estimate computed yet.</p>
        )}
      </div>
    );
  }

  function renderAccelCalibrationTab() {
    if (imu !== "icm45686") {
      return (
        <div className="tab-content-block">
          <h2 className="section-title">Accelerometer Calibration</h2>
          <p className="info-note">Accelerometer host calibration is available only for ICM45686.</p>
        </div>
      );
    }

    return (
      <div className="tab-content-block">
        <h2 className="section-title">Accelerometer Calibration</h2>
        <div className="grid grid-2">
          <label>
            Capture Duration (s)
            <input
              type="number"
              value={captureSeconds}
              onChange={(event) => setCaptureSeconds(event.target.value)}
            />
          </label>
          <label>
            Min Total Samples
            <input
              type="number"
              value={minTotalSamples}
              onChange={(event) => setMinTotalSamples(event.target.value)}
            />
          </label>
          <label>
            Min Accel Points
            <input
              type="number"
              value={minAccelPoints}
              onChange={(event) => setMinAccelPoints(event.target.value)}
            />
          </label>
        </div>

        <div className="action-row">
          <button disabled={busy} onClick={() => onCaptureIcmCalibration(false, true)}>
            Capture + Compute Accel
          </button>
        </div>

        <label className="checkbox-inline">
          <input
            type="checkbox"
            checked={writeAccel}
            onChange={(event) => setWriteAccel(event.target.checked)}
          />
          Enable write accelerometer calibration
        </label>

        <div className="action-row">
          <button
            disabled={busy || !writeAccel || !lastEstimate || !hasAccelEstimate}
            onClick={() => onWriteIcmCalibration(false, true)}
          >
            Write Accelerometer Calibration
          </button>
        </div>

        <label className="checkbox-inline">
          <input
            type="checkbox"
            checked={accelRealtimePlotEnabled}
            onChange={(event) => setAccelRealtimePlotEnabled(event.target.checked)}
          />
          Enable real-time accelerometer plotting
        </label>

        {accelRealtimePlotEnabled ? (
          <>
            <div className="action-row">
              <button disabled={accelRealtimePlotRunning} onClick={startAccelRealtimePlot}>
                Start Plot
              </button>
              <button onClick={stopAccelRealtimePlot}>Stop Plot</button>
              <button onClick={resetAccelPlot}>Clear Plot</button>
            </div>
            <div className="gyro-plots-grid">
              {renderAccelAxisPlot("ax", "Accel X Axis")}
              {renderAccelAxisPlot("ay", "Accel Y Axis")}
              {renderAccelAxisPlot("az", "Accel Z Axis")}
            </div>
          </>
        ) : null}

        <h3 className="section-subtitle">Last Accel Estimate</h3>
        {hasAccelEstimate && lastEstimate ? (
          <pre className="mono-block">
            {JSON.stringify(
              {
                sample_count: lastEstimate.sample_count,
                accel_offset_mps2: lastEstimate.accel_offset_mps2,
                accel_xform: lastEstimate.accel_xform,
                residual_rms_mps2: lastEstimate.residual_rms_mps2,
                residual_max_mps2: lastEstimate.residual_max_mps2,
              },
              null,
              2,
            )}
          </pre>
        ) : (
          <p className="info-note">No accelerometer estimate computed yet.</p>
        )}
      </div>
    );
  }

  function renderCalibrationTab() {
    return (
      <div className="tab-content-block">
        <h2 className="section-title">BNO Calibration Flow</h2>
        <p className="info-note">
          This runs BNO086 internal calibration phases. Move sensor through required motions
          (including figure-8 for magnetometer when needed), then save.
        </p>
        <p className="info-note">Requires active RTT connection from the top bar.</p>

        <div className="action-row">
          <button disabled={busy || !rttConnected} onClick={onBnoCalStart}>
            Start BNO Calibration
          </button>
          <button disabled={busy || !rttConnected} onClick={onBnoCalReady}>
            Mark Ready / Continue
          </button>
          <button disabled={busy || !rttConnected} onClick={onBnoCalSave}>
            Save BNO Calibration
          </button>
        </div>
      </div>
    );
  }

  return (
    <main className="shell">
      <section className="hero panel">
        <div>
          <h1>CONVOY Factory Calibration</h1>
          <p>Tabs for setup, firmware, runtime, and calibration. Terminal is docked at the bottom.</p>
        </div>
        <div className="hero-controls">
          <div className={`status-pill ${rttConnected ? "connected" : "disconnected"}`}>
            {busy ? "Running..." : "Idle"} | RTT {rttConnected ? "Connected" : "Disconnected"}
          </div>
          <div className="action-row">
            <button type="button" disabled={rttConnected} onClick={onConnectRtt}>
              Connect
            </button>
            <button type="button" disabled={!rttConnected} onClick={onDisconnectRtt}>
              Disconnect
            </button>
          </div>
        </div>
      </section>

      <nav className="tabs" aria-label="Workflow tabs">
        {(
          imu === "icm45686"
            ? (["target", "firmware", "runtime", "gyroCalibration", "accelCalibration"] as TabKey[])
            : (["target", "firmware", "runtime", "calibration"] as TabKey[])
        ).map((tab) => (
          <button
            key={tab}
            type="button"
            className={`tab-button ${activeTab === tab ? "active" : ""}`}
            onClick={() => setActiveTab(tab)}
            disabled={busy && activeTab === tab}
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </nav>

      <section className="panel tab-panel">
        {activeTab === "target" && renderTargetTab()}
        {activeTab === "firmware" && renderFirmwareTab()}
        {activeTab === "runtime" && renderRuntimeTab()}
        {activeTab === "gyroCalibration" && renderGyroCalibrationTab()}
        {activeTab === "accelCalibration" && renderAccelCalibrationTab()}
        {activeTab === "calibration" && renderCalibrationTab()}
      </section>

      <section className="panel terminal-dock">
        <div className="terminal-header">
          <h2>Terminal</h2>
          <div className="terminal-controls">
            <label className="checkbox-inline">
              <input
                type="checkbox"
                checked={autoScrollTerminal}
                onChange={(event) => setAutoScrollTerminal(event.target.checked)}
              />
              Auto-scroll
            </label>
            <button type="button" onClick={() => setLogs([])} disabled={busy && logs.length === 0}>
              Clear
            </button>
          </div>
        </div>

        <div
          className={`terminal-resizer ${isResizingTerminal ? "active" : ""}`}
          onMouseDown={onTerminalResizeStart}
          role="separator"
          aria-label="Resize terminal"
          aria-valuemin={90}
          aria-valuemax={420}
          aria-valuenow={terminalHeight}
        />

        <div
          className="terminal-log"
          ref={terminalLogRef}
          role="log"
          aria-live="polite"
          style={{ height: `${terminalHeight}px` }}
        >
          {terminalLogContent}
        </div>

        <form className="terminal-form" onSubmit={onSendTerminalCommand}>
          <input
            className="terminal-input"
            type="text"
            value={terminalCommand}
            onChange={(event) => setTerminalCommand(event.target.value)}
            placeholder='Raw RTT command (use ";" to send multiple, e.g. IMU ICM45686; STATUS). Requires Connect.'
          />
          <button type="submit" disabled={busy || !rttConnected || !terminalCommand.trim()}>
            Send
          </button>
        </form>
      </section>
    </main>
  );
}
