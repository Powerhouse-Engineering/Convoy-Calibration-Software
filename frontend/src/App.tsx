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
  setRttPlotDecimation,
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
  seq: number;
  timestampMs: number;
  gx: number;
  gy: number;
  gz: number;
};

type IcmAccelSample = {
  seq: number;
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

const PLOT_MAX_POINTS = 2400;
const PLOT_MAX_BUFFERED_SAMPLES = 1200;
const PLOT_MIN_FRAME_MS = 16;
const PLOT_TIME_WINDOW_S = 4;
const PLOT_RETENTION_MULTIPLIER = 1.5;
const PLOT_LOW_RATE_NO_DECIMATION_THRESHOLD_HZ = 80;
const PLOT_HIGH_RATE_TARGET_EVENT_HZ = 80;
const PLOT_TARGET_UPDATES_PER_SECOND = 30;
const PLOT_MAX_FRAME_DT_S = 0.1;

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
  const [plotDecimation, setPlotDecimation] = useState("1");

  const [accelRangeG, setAccelRangeG] = useState("16");
  const [gyroRangeDps, setGyroRangeDps] = useState("2000");
  const [lowNoise, setLowNoise] = useState(true);
  const [fifo, setFifo] = useState(true);
  const [fifoHires, setFifoHires] = useState(false);

  const [bnoRaw, setBnoRaw] = useState(true);
  const [bno6dof, setBno6dof] = useState(true);

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
  const [gyroDebugIncomingHz, setGyroDebugIncomingHz] = useState(0);
  const [gyroDebugQueueDepth, setGyroDebugQueueDepth] = useState(0);
  const [gyroDebugRenderLagMs, setGyroDebugRenderLagMs] = useState(0);
  const [accelDebugIncomingHz, setAccelDebugIncomingHz] = useState(0);
  const [accelDebugQueueDepth, setAccelDebugQueueDepth] = useState(0);
  const [accelDebugRenderLagMs, setAccelDebugRenderLagMs] = useState(0);
  const [runtimeStreamRunning, setRuntimeStreamRunning] = useState(false);
  const [rttConnected, setRttConnected] = useState(false);
  const [appliedPlotDecimation, setAppliedPlotDecimation] = useState(1);

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
  const gyroRealtimePlotRunningRef = useRef(false);
  const accelRealtimePlotRunningRef = useRef(false);
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
  const gyroPendingStartRef = useRef(0);
  const accelPendingStartRef = useRef(0);
  const plotFlushRafRef = useRef<number | null>(null);
  const plotLastFlushMsRef = useRef(0);
  const plotLastFrameTimeMsRef = useRef<number | null>(null);
  const plotDisplayTimeSRef = useRef(0);
  const gyroLastSeqRef = useRef<number | null>(null);
  const accelLastSeqRef = useRef<number | null>(null);
  const gyroObservedSeqStepRef = useRef<number | null>(null);
  const accelObservedSeqStepRef = useRef<number | null>(null);
  const gyroDropCountRef = useRef(0);
  const accelDropCountRef = useRef(0);
  const gyroDropLogTsRef = useRef(0);
  const accelDropLogTsRef = useRef(0);
  const gyroRateWindowStartMsRef = useRef<number | null>(null);
  const accelRateWindowStartMsRef = useRef<number | null>(null);
  const gyroRateCountRef = useRef(0);
  const accelRateCountRef = useRef(0);
  const gyroIncomingHzRef = useRef(0);
  const accelIncomingHzRef = useRef(0);
  const gyroLastEnqueueTsMsRef = useRef<number | null>(null);
  const accelLastEnqueueTsMsRef = useRef<number | null>(null);
  const appliedPlotDecimationRef = useRef(1);
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
      imu === "bno086"
        ? ["target", "firmware", "runtime", "gyroCalibration", "accelCalibration", "calibration"]
        : ["target", "firmware", "runtime", "gyroCalibration", "accelCalibration"];

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
            const defaultDecimation = currentEffectivePlotDecimationRatio();
            applyLocalPlotDecimation(defaultDecimation);
            gyroRealtimePlotRunningRef.current = false;
            accelRealtimePlotRunningRef.current = false;
            gyroPendingSamplesRef.current = [];
            accelPendingSamplesRef.current = [];
            gyroPendingStartRef.current = 0;
            accelPendingStartRef.current = 0;
            gyroLastSeqRef.current = null;
            accelLastSeqRef.current = null;
            gyroObservedSeqStepRef.current = null;
            accelObservedSeqStepRef.current = null;
            gyroDropCountRef.current = 0;
            accelDropCountRef.current = 0;
            gyroDropLogTsRef.current = 0;
            accelDropLogTsRef.current = 0;
            gyroRateWindowStartMsRef.current = null;
            accelRateWindowStartMsRef.current = null;
            gyroRateCountRef.current = 0;
            accelRateCountRef.current = 0;
            gyroIncomingHzRef.current = 0;
            accelIncomingHzRef.current = 0;
            gyroLastEnqueueTsMsRef.current = null;
            accelLastEnqueueTsMsRef.current = null;
            setGyroDebugIncomingHz(0);
            setGyroDebugQueueDepth(0);
            setGyroDebugRenderLagMs(0);
            setAccelDebugIncomingHz(0);
            setAccelDebugQueueDepth(0);
            setAccelDebugRenderLagMs(0);
            if (plotFlushRafRef.current !== null) {
              window.cancelAnimationFrame(plotFlushRafRef.current);
              plotFlushRafRef.current = null;
            }
            plotLastFlushMsRef.current = 0;
            plotLastFrameTimeMsRef.current = null;
            plotDisplayTimeSRef.current = 0;
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
    gyroRealtimePlotRunningRef.current = gyroRealtimePlotRunning;
    accelRealtimePlotRunningRef.current = accelRealtimePlotRunning;
    if (gyroRealtimePlotRunning || accelRealtimePlotRunning) {
      schedulePlotFlush();
    }
  }, [gyroRealtimePlotRunning, accelRealtimePlotRunning]);

  useEffect(() => {
    gyroLastSeqRef.current = null;
    accelLastSeqRef.current = null;
    gyroObservedSeqStepRef.current = null;
    accelObservedSeqStepRef.current = null;
    gyroDropCountRef.current = 0;
    accelDropCountRef.current = 0;
    gyroDropLogTsRef.current = 0;
    accelDropLogTsRef.current = 0;
    gyroRateWindowStartMsRef.current = null;
    accelRateWindowStartMsRef.current = null;
    gyroRateCountRef.current = 0;
    accelRateCountRef.current = 0;
    gyroIncomingHzRef.current = 0;
    accelIncomingHzRef.current = 0;
  }, [plotDecimation, streamHz, odrHz, appliedPlotDecimation]);

  useEffect(() => {
    if (!rttConnected) {
      const defaultDecimation = currentEffectivePlotDecimationRatio();
      applyLocalPlotDecimation(defaultDecimation);
      return;
    }

    const targetDecimation = currentEffectivePlotDecimationRatio();
    const handle = window.setTimeout(() => {
      void syncRttPlotDecimation(targetDecimation, true);
    }, 200);

    return () => {
      window.clearTimeout(handle);
    };
  }, [rttConnected, plotDecimation, streamHz, odrHz]);

  useEffect(() => {
    const handle = window.setInterval(() => {
      const nowMs = performance.now();

      const gyroLastEnqueue = gyroLastEnqueueTsMsRef.current;
      const accelLastEnqueue = accelLastEnqueueTsMsRef.current;
      if (gyroLastEnqueue === null || nowMs - gyroLastEnqueue > 1500) {
        gyroIncomingHzRef.current = 0;
      }
      if (accelLastEnqueue === null || nowMs - accelLastEnqueue > 1500) {
        accelIncomingHzRef.current = 0;
      }

      const gyroQueueDepth = pendingSampleCount(gyroPendingSamplesRef.current, gyroPendingStartRef.current);
      const accelQueueDepth = pendingSampleCount(
        accelPendingSamplesRef.current,
        accelPendingStartRef.current,
      );

      const gyroRenderedTs = gyroPlotLastTimestampMsRef.current;
      const accelRenderedTs = accelPlotLastTimestampMsRef.current;
      const gyroRenderLagMs =
        gyroLastEnqueue !== null && gyroRenderedTs !== null
          ? Math.max(0, gyroLastEnqueue - gyroRenderedTs)
          : 0;
      const accelRenderLagMs =
        accelLastEnqueue !== null && accelRenderedTs !== null
          ? Math.max(0, accelLastEnqueue - accelRenderedTs)
          : 0;

      setGyroDebugIncomingHz(gyroIncomingHzRef.current);
      setGyroDebugQueueDepth(gyroQueueDepth);
      setGyroDebugRenderLagMs(gyroRenderLagMs);
      setAccelDebugIncomingHz(accelIncomingHzRef.current);
      setAccelDebugQueueDepth(accelQueueDepth);
      setAccelDebugRenderLagMs(accelRenderLagMs);
    }, 200);

    return () => {
      window.clearInterval(handle);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (plotFlushRafRef.current !== null) {
        window.cancelAnimationFrame(plotFlushRafRef.current);
        plotFlushRafRef.current = null;
      }
      plotLastFlushMsRef.current = 0;
      plotLastFrameTimeMsRef.current = null;
      plotDisplayTimeSRef.current = 0;
      gyroPendingStartRef.current = 0;
      accelPendingStartRef.current = 0;
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

  function applyLocalPlotDecimation(value: number) {
    const applied = Math.max(1, Math.floor(value || 1));
    appliedPlotDecimationRef.current = applied;
    setAppliedPlotDecimation(applied);
  }

  async function syncRttPlotDecimation(target: number, logOnError = false): Promise<number> {
    const normalized = Math.max(1, Math.floor(target || 1));

    if (!rttConnected) {
      applyLocalPlotDecimation(normalized);
      return normalized;
    }

    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const applied = await setRttPlotDecimation(normalized);
        applyLocalPlotDecimation(applied);
        return applied;
      } catch (error) {
        lastError = error;
        if (attempt === 0) {
          await new Promise((resolve) => window.setTimeout(resolve, 120));
        }
      }
    }

    applyLocalPlotDecimation(normalized);
    if (logOnError) {
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      pushLog("error", `failed to sync RTT plot decimation: ${message}`);
    }
    return normalized;
  }

  async function refreshRttConnectionStatus() {
    try {
      const status = await getRttConnectionStatus();
      setRttConnected(status.connected);
      if (!status.connected) {
        const defaultDecimation = currentEffectivePlotDecimationRatio();
        applyLocalPlotDecimation(defaultDecimation);
      }
    } catch {
      setRttConnected(false);
      const defaultDecimation = currentEffectivePlotDecimationRatio();
      applyLocalPlotDecimation(defaultDecimation);
    }
  }

  async function disconnectRttPersistentConnection(logWhenAlreadyDisconnected = false): Promise<boolean> {
    try {
      await stopGyroRealtimePlot();
      await stopAccelRealtimePlot();
      const disconnected = await disconnectRttSession();
      setRttConnected(false);
      setRuntimeStreamRunning(false);
      const defaultDecimation = currentEffectivePlotDecimationRatio();
      applyLocalPlotDecimation(defaultDecimation);
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
      const requestedDecimation = currentEffectivePlotDecimationRatio();
      await connectRttSession(currentRttConnectRequest());
      setRttConnected(true);
      setRuntimeStreamRunning(false);
      await syncRttPlotDecimation(requestedDecimation, true);
      lastAppliedRuntimeRef.current = null;
    } catch (error) {
      setRttConnected(false);
      const defaultDecimation = currentEffectivePlotDecimationRatio();
      applyLocalPlotDecimation(defaultDecimation);
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
      plot_decimation: currentEffectivePlotDecimationRatio(),
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
      await syncRttPlotDecimation(currentEffectivePlotDecimationRatio(), true);
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
    gyroPendingStartRef.current = 0;
    gyroLastSeqRef.current = null;
    gyroObservedSeqStepRef.current = null;
    gyroDropCountRef.current = 0;
    gyroDropLogTsRef.current = 0;
    gyroRateWindowStartMsRef.current = null;
    gyroRateCountRef.current = 0;
    gyroIncomingHzRef.current = 0;
    gyroLastEnqueueTsMsRef.current = null;
    setGyroDebugIncomingHz(0);
    setGyroDebugQueueDepth(0);
    setGyroDebugRenderLagMs(0);
    plotLastFlushMsRef.current = 0;
    plotLastFrameTimeMsRef.current = null;
    plotDisplayTimeSRef.current = 0;
    drawAllPlotCanvases();
  }

  function resetAccelPlot() {
    accelPlotPointsRef.current = [];
    accelPlotLastTimestampMsRef.current = null;
    accelPlotLastTimeSRef.current = 0;
    accelPlotHasDataRef.current = false;
    setAccelPlotHasData(false);
    accelPendingSamplesRef.current = [];
    accelPendingStartRef.current = 0;
    accelLastSeqRef.current = null;
    accelObservedSeqStepRef.current = null;
    accelDropCountRef.current = 0;
    accelDropLogTsRef.current = 0;
    accelRateWindowStartMsRef.current = null;
    accelRateCountRef.current = 0;
    accelIncomingHzRef.current = 0;
    accelLastEnqueueTsMsRef.current = null;
    setAccelDebugIncomingHz(0);
    setAccelDebugQueueDepth(0);
    setAccelDebugRenderLagMs(0);
    plotLastFlushMsRef.current = 0;
    plotLastFrameTimeMsRef.current = null;
    plotDisplayTimeSRef.current = 0;
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

  function drawAxisCanvas<T extends { t: number }>(
    canvas: HTMLCanvasElement | null,
    points: T[],
    displayTimeS: number,
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

    const padding = 10;
    const drawableWidth = Math.max(1, cssWidth - padding * 2);
    const drawableHeight = Math.max(1, cssHeight - padding * 2);
    const clampedDisplayTimeS = Math.max(0, displayTimeS);
    const earliestVisibleTimeS = Math.max(0, clampedDisplayTimeS - PLOT_TIME_WINDOW_S);
    let startIdx = 0;
    while (startIdx < points.length && points[startIdx].t < earliestVisibleTimeS) {
      startIdx += 1;
    }
    let endIdx = points.length - 1;
    while (endIdx >= startIdx && points[endIdx].t > clampedDisplayTimeS) {
      endIdx -= 1;
    }
    const visibleCount = endIdx >= startIdx ? endIdx - startIdx + 1 : 0;

    if (visibleCount < 2) {
      if (visibleCount === 1) {
        return readValue(points[startIdx]);
      }
      return null;
    }

    let maxAbs = 1;

    for (let idx = startIdx; idx <= endIdx; idx += 1) {
      const point = points[idx];
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

    const visibleSpanS = Math.max(1e-6, PLOT_TIME_WINDOW_S);
    const timeToX = (timeS: number) =>
      padding + ((timeS - earliestVisibleTimeS) / visibleSpanS) * drawableWidth;

    const targetSegments = Math.max(80, Math.floor(drawableWidth));
    const stride = Math.max(1, Math.floor(visibleCount / targetSegments));

    context.strokeStyle = strokeColor;
    context.lineWidth = 2;
    context.beginPath();

    let firstDrawn = true;
    for (let idx = startIdx; idx <= endIdx; idx += stride) {
      const value = readValue(points[idx]);
      const x = timeToX(points[idx].t);
      const y = valueToY(value);
      if (firstDrawn) {
        context.moveTo(x, y);
        firstDrawn = false;
      } else {
        context.lineTo(x, y);
      }
    }

    const lastIndex = endIdx;
    const lastValue = readValue(points[lastIndex]);
    const lastX = timeToX(points[lastIndex].t);
    const lastY = valueToY(lastValue);
    context.lineTo(lastX, lastY);
    if (points[lastIndex].t < clampedDisplayTimeS) {
      context.lineTo(timeToX(clampedDisplayTimeS), lastY);
    }
    context.stroke();

    return lastValue;
  }

  function drawAllPlotCanvases() {
    const displayTimeS = plotDisplayTimeSRef.current;
    const gyroPoints = gyroPlotPointsRef.current;
    const accelPoints = accelPlotPointsRef.current;

    updatePlotValue(
      gyroValueRefs.current.gx,
      drawAxisCanvas(
        gyroCanvasRefs.current.gx,
        gyroPoints,
        displayTimeS,
        (point) => point.gx,
        "#ef7f45",
      ),
      "dps",
    );
    updatePlotValue(
      gyroValueRefs.current.gy,
      drawAxisCanvas(
        gyroCanvasRefs.current.gy,
        gyroPoints,
        displayTimeS,
        (point) => point.gy,
        "#0d8f9a",
      ),
      "dps",
    );
    updatePlotValue(
      gyroValueRefs.current.gz,
      drawAxisCanvas(
        gyroCanvasRefs.current.gz,
        gyroPoints,
        displayTimeS,
        (point) => point.gz,
        "#4a77ff",
      ),
      "dps",
    );
    updatePlotValue(
      accelValueRefs.current.ax,
      drawAxisCanvas(
        accelCanvasRefs.current.ax,
        accelPoints,
        displayTimeS,
        (point) => point.ax,
        "#ff6f61",
      ),
      "m/s²",
    );
    updatePlotValue(
      accelValueRefs.current.ay,
      drawAxisCanvas(
        accelCanvasRefs.current.ay,
        accelPoints,
        displayTimeS,
        (point) => point.ay,
        "#2a9d8f",
      ),
      "m/s²",
    );
    updatePlotValue(
      accelValueRefs.current.az,
      drawAxisCanvas(
        accelCanvasRefs.current.az,
        accelPoints,
        displayTimeS,
        (point) => point.az,
        "#3a86ff",
      ),
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
        t = plotDisplayTimeSRef.current;
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

    const retentionCutoffS = Math.max(
      0,
      Math.max(lastTimeS, plotDisplayTimeSRef.current) -
        PLOT_TIME_WINDOW_S * PLOT_RETENTION_MULTIPLIER,
    );
    let staleCount = 0;
    while (staleCount < points.length && points[staleCount].t < retentionCutoffS) {
      staleCount += 1;
    }
    if (staleCount > 0) {
      points.splice(0, staleCount);
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
        t = plotDisplayTimeSRef.current;
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

    const retentionCutoffS = Math.max(
      0,
      Math.max(lastTimeS, plotDisplayTimeSRef.current) -
        PLOT_TIME_WINDOW_S * PLOT_RETENTION_MULTIPLIER,
    );
    let staleCount = 0;
    while (staleCount < points.length && points[staleCount].t < retentionCutoffS) {
      staleCount += 1;
    }
    if (staleCount > 0) {
      points.splice(0, staleCount);
    }

    accelPlotLastTimestampMsRef.current = lastTimestampMs;
    accelPlotLastTimeSRef.current = lastTimeS;

    const hasData = points.length >= 2;
    if (hasData !== accelPlotHasDataRef.current) {
      accelPlotHasDataRef.current = hasData;
      setAccelPlotHasData(hasData);
    }
  }

  function shouldKeepPlotFlushLoopAlive(): boolean {
    return (
      gyroRealtimePlotRunningRef.current ||
      accelRealtimePlotRunningRef.current ||
      pendingSampleCount(gyroPendingSamplesRef.current, gyroPendingStartRef.current) > 0 ||
      pendingSampleCount(accelPendingSamplesRef.current, accelPendingStartRef.current) > 0
    );
  }

  function maxSamplesPerFrame(frameDtS: number): number {
    const effectiveStreamHz = Math.max(
      1,
      parsePositiveIntOr(streamHz, parsePositiveIntOr(odrHz, 200)),
    );
    const safeFrameDtS = Math.max(1 / PLOT_TARGET_UPDATES_PER_SECOND, frameDtS);
    const expectedSamplesThisFrame = Math.ceil(effectiveStreamHz * safeFrameDtS);
    return Math.max(1, Math.min(256, expectedSamplesThisFrame + 1));
  }

  function pendingSampleCount<T>(pending: T[], startIndex: number): number {
    return Math.max(0, pending.length - startIndex);
  }

  function maybeCompactPendingQueue<T>(
    pending: T[],
    startRef: { current: number },
    force = false,
  ) {
    const startIndex = startRef.current;
    if (startIndex <= 0) {
      return;
    }

    if (force || startIndex >= pending.length) {
      pending.length = 0;
      startRef.current = 0;
      return;
    }

    if (startIndex >= 512 && startIndex * 2 >= pending.length) {
      pending.splice(0, startIndex);
      startRef.current = 0;
    }
  }

  function stopPlotFlushLoopIfIdle() {
    if (shouldKeepPlotFlushLoopAlive()) {
      return;
    }
    if (plotFlushRafRef.current !== null) {
      window.cancelAnimationFrame(plotFlushRafRef.current);
      plotFlushRafRef.current = null;
    }
    plotLastFlushMsRef.current = 0;
    plotLastFrameTimeMsRef.current = null;
  }

  function schedulePlotFlush() {
    if (plotFlushRafRef.current !== null) {
      return;
    }

    const flushOnFrame = (frameTimeMs: number) => {
      plotFlushRafRef.current = null;

      const previousFrameTimeMs = plotLastFrameTimeMsRef.current;
      let frameDtS = 1 / PLOT_TARGET_UPDATES_PER_SECOND;
      if (previousFrameTimeMs !== null) {
        frameDtS = Math.max(
          0,
          Math.min(PLOT_MAX_FRAME_DT_S, (frameTimeMs - previousFrameTimeMs) / 1000),
        );
        if (gyroRealtimePlotRunningRef.current || accelRealtimePlotRunningRef.current) {
          plotDisplayTimeSRef.current += frameDtS;
        }
      }
      plotLastFrameTimeMsRef.current = frameTimeMs;

      if (frameTimeMs - plotLastFlushMsRef.current >= PLOT_MIN_FRAME_MS) {
        plotLastFlushMsRef.current = frameTimeMs;
        const frameSampleBudget = maxSamplesPerFrame(frameDtS);

        const gyroPending = gyroPendingSamplesRef.current;
        const gyroAvailable = pendingSampleCount(gyroPending, gyroPendingStartRef.current);
        if (gyroAvailable > 0) {
          const gyroTake = Math.min(frameSampleBudget, gyroAvailable);
          const gyroStart = gyroPendingStartRef.current;
          const gyroBatch = gyroPending.slice(gyroStart, gyroStart + gyroTake);
          gyroPendingStartRef.current = gyroStart + gyroTake;
          maybeCompactPendingQueue(gyroPending, gyroPendingStartRef, false);
          appendGyroPlotSamples(gyroBatch);
        }

        const accelPending = accelPendingSamplesRef.current;
        const accelAvailable = pendingSampleCount(accelPending, accelPendingStartRef.current);
        if (accelAvailable > 0) {
          const accelTake = Math.min(frameSampleBudget, accelAvailable);
          const accelStart = accelPendingStartRef.current;
          const accelBatch = accelPending.slice(accelStart, accelStart + accelTake);
          accelPendingStartRef.current = accelStart + accelTake;
          maybeCompactPendingQueue(accelPending, accelPendingStartRef, false);
          appendAccelPlotSamples(accelBatch);
        }

        if (
          gyroRealtimePlotRunningRef.current ||
          accelRealtimePlotRunningRef.current ||
          gyroPlotPointsRef.current.length > 0 ||
          accelPlotPointsRef.current.length > 0
        ) {
          drawAllPlotCanvases();
        }
      }

      if (shouldKeepPlotFlushLoopAlive()) {
        plotFlushRafRef.current = window.requestAnimationFrame(flushOnFrame);
      } else {
        plotLastFlushMsRef.current = 0;
        plotLastFrameTimeMsRef.current = null;
      }
    };

    plotFlushRafRef.current = window.requestAnimationFrame(flushOnFrame);
  }

  function queueGyroPlotSample(sample: IcmGyroSample) {
    if (!shouldQueueGyroSample(sample)) {
      return;
    }
    recordIncomingRate(
      sample.timestampMs,
      gyroRateWindowStartMsRef,
      gyroRateCountRef,
      gyroIncomingHzRef,
      gyroLastEnqueueTsMsRef,
    );
    const pending = gyroPendingSamplesRef.current;
    pending.push(sample);
    const activeCount = pendingSampleCount(pending, gyroPendingStartRef.current);
    const maxBuffered = PLOT_MAX_BUFFERED_SAMPLES;
    if (activeCount > maxBuffered) {
      gyroPendingStartRef.current += activeCount - maxBuffered;
      maybeCompactPendingQueue(pending, gyroPendingStartRef, false);
    }
    schedulePlotFlush();
  }

  function queueAccelPlotSample(sample: IcmAccelSample) {
    if (!shouldQueueAccelSample(sample)) {
      return;
    }
    recordIncomingRate(
      sample.timestampMs,
      accelRateWindowStartMsRef,
      accelRateCountRef,
      accelIncomingHzRef,
      accelLastEnqueueTsMsRef,
    );
    const pending = accelPendingSamplesRef.current;
    pending.push(sample);
    const activeCount = pendingSampleCount(pending, accelPendingStartRef.current);
    const maxBuffered = PLOT_MAX_BUFFERED_SAMPLES;
    if (activeCount > maxBuffered) {
      accelPendingStartRef.current += activeCount - maxBuffered;
      maybeCompactPendingQueue(pending, accelPendingStartRef, false);
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

  function currentPlotDecimationRatio(): number {
    return Math.max(1, parsePositiveIntOr(plotDecimation, 1));
  }

  function currentEffectivePlotDecimationRatio(): number {
    const requested = currentPlotDecimationRatio();
    const effectiveStreamHz = Math.max(
      1,
      parsePositiveIntOr(streamHz, parsePositiveIntOr(odrHz, 200)),
    );
    if (effectiveStreamHz <= PLOT_LOW_RATE_NO_DECIMATION_THRESHOLD_HZ) {
      return 1;
    }
    const highRateAuto = Math.max(
      1,
      Math.ceil(effectiveStreamHz / PLOT_HIGH_RATE_TARGET_EVENT_HZ),
    );
    return Math.max(requested, highRateAuto);
  }

  function recordIncomingRate(
    timestampMs: number,
    windowStartRef: { current: number | null },
    countRef: { current: number },
    hzRef: { current: number },
    lastEnqueueRef: { current: number | null },
  ) {
    if (!Number.isFinite(timestampMs)) {
      return;
    }

    lastEnqueueRef.current = timestampMs;

    if (windowStartRef.current === null) {
      windowStartRef.current = timestampMs;
      countRef.current = 1;
      return;
    }

    countRef.current += 1;
    const elapsedMs = timestampMs - windowStartRef.current;
    if (elapsedMs >= 1000) {
      hzRef.current = (countRef.current * 1000) / Math.max(1, elapsedMs);
      windowStartRef.current = timestampMs;
      countRef.current = 0;
    }
  }

  function trackDroppedFrames(
    label: string,
    seq: number,
    lastSeqRef: { current: number | null },
    observedStepRef: { current: number | null },
    droppedRef: { current: number },
    lastLogTsRef: { current: number },
  ) {
    const ratio = Math.max(
      1,
      rttConnected ? appliedPlotDecimationRef.current : currentEffectivePlotDecimationRatio(),
    );
    if (!Number.isFinite(seq) || seq <= 0) {
      lastSeqRef.current = Number.isFinite(seq) ? seq : null;
      observedStepRef.current = null;
      droppedRef.current = 0;
      return;
    }

    const previousSeq = lastSeqRef.current;
    if (previousSeq !== null) {
      const seqDelta = seq - previousSeq;
      if (seqDelta > 0) {
        const observedStep = observedStepRef.current;
        if (observedStep === null || seqDelta < observedStep) {
          observedStepRef.current = seqDelta;
        }

        const expectedStep = Math.max(1, ratio, observedStepRef.current ?? ratio);
        if (seqDelta > expectedStep) {
          droppedRef.current += seqDelta - expectedStep;
        }
      } else {
        observedStepRef.current = null;
        droppedRef.current = 0;
      }
    }
    lastSeqRef.current = seq;

    const now = Date.now();
    if (droppedRef.current > 0 && now - lastLogTsRef.current >= 1000) {
      pushLog("error", `${label} stream: dropped ${droppedRef.current} sample(s)`);
      droppedRef.current = 0;
      lastLogTsRef.current = now;
    }
  }

  function shouldQueueGyroSample(sample: IcmGyroSample): boolean {
    trackDroppedFrames(
      "gyro plot",
      sample.seq,
      gyroLastSeqRef,
      gyroObservedSeqStepRef,
      gyroDropCountRef,
      gyroDropLogTsRef,
    );

    return true;
  }

  function shouldQueueAccelSample(sample: IcmAccelSample): boolean {
    if (!gyroRealtimePlotRunning) {
      trackDroppedFrames(
        "accel plot",
        sample.seq,
        accelLastSeqRef,
        accelObservedSeqStepRef,
        accelDropCountRef,
        accelDropLogTsRef,
      );
    }

    return true;
  }

  async function stopGyroRealtimePlot() {
    const wasRunning = gyroRealtimePlotRunning;
    setGyroRealtimePlotRunning(false);
    gyroRealtimePlotRunningRef.current = false;
    gyroPendingSamplesRef.current = [];
    gyroPendingStartRef.current = 0;
    clearGyroRealtimeListeners();
    stopPlotFlushLoopIfIdle();
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
    gyroRealtimePlotRunningRef.current = true;
    schedulePlotFlush();

    try {
      const unlistenSamples = await listenGyroRealtimeSamples(
        (payload: GyroRealtimeSampleEvent) => {
          queueGyroPlotSample({
            seq: payload.seq,
            timestampMs: performance.now(),
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
      gyroRealtimePlotRunningRef.current = false;
      clearGyroRealtimeListeners();
      stopPlotFlushLoopIfIdle();
      const message = error instanceof Error ? error.message : String(error);
      pushLog("error", message);
    }
  }

  async function stopAccelRealtimePlot() {
    const wasRunning = accelRealtimePlotRunning;
    setAccelRealtimePlotRunning(false);
    accelRealtimePlotRunningRef.current = false;
    accelPendingSamplesRef.current = [];
    accelPendingStartRef.current = 0;
    clearAccelRealtimeListeners();
    stopPlotFlushLoopIfIdle();
    if (wasRunning) {
      pushLog("info", "accelerometer real-time plotting stopped");
    }
  }

  async function startAccelRealtimePlot() {
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
    accelRealtimePlotRunningRef.current = true;
    schedulePlotFlush();

    try {
      const unlistenSamples = await listenGyroRealtimeSamples(
        (payload: GyroRealtimeSampleEvent) => {
          queueAccelPlotSample({
            seq: payload.seq,
            timestampMs: performance.now(),
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
      accelRealtimePlotRunningRef.current = false;
      clearAccelRealtimeListeners();
      stopPlotFlushLoopIfIdle();
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
        { key: "stream_format", value: "BIN", command: "STREAM_FORMAT BIN" },
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
      { key: "stream_format", value: "BIN", command: "STREAM_FORMAT BIN" },
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

    const applyOutput = await runConnectedRttCommands(
      [plan.imuCommand, ...plan.params.map((entry) => entry.command), "APPLY"],
      { logPrefix: "RTT APPLY" },
    );
    if (applyOutput === null) {
      return;
    }

    lastAppliedRuntimeRef.current = plan.snapshot;
    setRuntimeStreamRunning(false);

    const statusOutput = await runConnectedRttCommands(["STATUS"], {
      logPrefix: "RTT APPLY_STATUS",
    });
    if (statusOutput === null) {
      pushLog(
        "info",
        "configuration was applied, but STATUS did not reply in time; you can retry STATUS manually",
      );
    }
    await syncRttPlotDecimation(currentEffectivePlotDecimationRatio(), true);
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
    await syncRttPlotDecimation(currentEffectivePlotDecimationRatio(), true);
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
        imu_model: imu,
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
        bno_raw: imu === "bno086" ? true : bnoRaw,
        bno_6dof: bno6dof,
        keep_stream_running: keepStreamRunningDuringAndAfterCapture,
        plot_decimation: currentEffectivePlotDecimationRatio(),
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

    }

    setLastEstimate(merged);
    setRuntimeStreamRunning(keepStreamRunningDuringAndAfterCapture);
  }

  async function onWriteIcmCalibration(writeGyro: boolean, writeAccelCal: boolean) {
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
      "--imu",
      imu,
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
      "--bno-raw",
      encodeBool(bnoRaw),
      "--bno-6dof",
      encodeBool(bno6dof),
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

          <label>
            Plot Decimation
            <input
              type="number"
              min="1"
              value={plotDecimation}
              onChange={(event) => setPlotDecimation(event.target.value)}
            />
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
            <div />
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
        <p className="info-note">
          Plot Decimation controls UI plotting load only. `1` = plot every sample, `2` = every
          second sample. For low stream rates ({"<="} 80 Hz), decimation is forced to `1` so updates
          remain sample-by-sample. For high stream rates, the app may increase effective decimation
          automatically to keep RTT/UI throughput stable.
        </p>
        <p className="info-note">
          Effective plot decimation: <strong>{currentEffectivePlotDecimationRatio()}</strong>
          {rttConnected ? (
            <>
              {" "}
              | Applied in RTT session: <strong>{appliedPlotDecimation}</strong>
            </>
          ) : null}
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

        <h3 className="section-subtitle">Gyro Plot Debug</h3>
        <div className="grid grid-3">
          <div className="info-note">
            Incoming rate: <strong>{gyroDebugIncomingHz.toFixed(1)} Hz</strong>
          </div>
          <div className="info-note">
            Queue depth: <strong>{gyroDebugQueueDepth}</strong>
          </div>
          <div className="info-note">
            Render lag: <strong>{gyroDebugRenderLagMs.toFixed(1)} ms</strong>
          </div>
        </div>

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

        <h3 className="section-subtitle">Accel Plot Debug</h3>
        <div className="grid grid-3">
          <div className="info-note">
            Incoming rate: <strong>{accelDebugIncomingHz.toFixed(1)} Hz</strong>
          </div>
          <div className="info-note">
            Queue depth: <strong>{accelDebugQueueDepth}</strong>
          </div>
          <div className="info-note">
            Render lag: <strong>{accelDebugRenderLagMs.toFixed(1)} ms</strong>
          </div>
        </div>

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
          imu === "bno086"
            ? ([
                "target",
                "firmware",
                "runtime",
                "gyroCalibration",
                "accelCalibration",
                "calibration",
              ] as TabKey[])
            : (["target", "firmware", "runtime", "gyroCalibration", "accelCalibration"] as TabKey[])
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
