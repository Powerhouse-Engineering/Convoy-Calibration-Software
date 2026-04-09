import { FormEvent, MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { callBackend } from "./backendClient";

type BoardCode = "ass" | "asc";
type ImuModel = "icm45686" | "bno086";
type EraseMode = "sector" | "chip";
type TabKey = "target" | "firmware" | "runtime" | "calibration";

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
  responses: string[];
};

const BOARD_LABELS: Record<BoardCode, string> = {
  ass: "ASS (app_sensor)",
  asc: "ASC (app_controller)",
};

const TAB_LABELS: Record<TabKey, string> = {
  target: "Target & Tools",
  firmware: "Build & Flash",
  runtime: "Runtime",
  calibration: "Calibration",
};

function toTimestamp(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function isIcmCaptureResult(value: unknown): value is IcmCaptureCalibrationResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<IcmCaptureCalibrationResult>;
  return !!maybe.estimate;
}

function encodeBool(value: boolean): string {
  return value ? "1" : "0";
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>("target");
  const [board, setBoard] = useState<BoardCode>("ass");
  const [imu, setImu] = useState<ImuModel>("icm45686");
  const [eraseMode, setEraseMode] = useState<EraseMode>("sector");

  const [serial, setSerial] = useState("");
  const [repoRoot, setRepoRoot] = useState("");
  const [firmwareDir, setFirmwareDir] = useState("");
  const [flashHexPath, setFlashHexPath] = useState("");

  const [nrfjprogPath, setNrfjprogPath] = useState("");
  const [westPath, setWestPath] = useState("");
  const [jlinkGdbServerPath, setJlinkGdbServerPath] = useState("");

  const [deviceName, setDeviceName] = useState("nRF52840_xxAA");
  const [speedKhz, setSpeedKhz] = useState("4000");
  const [gdbPort, setGdbPort] = useState("2331");
  const [rttTelnetPort, setRttTelnetPort] = useState("19021");
  const [connectTimeoutMs, setConnectTimeoutMs] = useState("10000");
  const [ackTimeoutMs, setAckTimeoutMs] = useState("2000");

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

  const [terminalCommand, setTerminalCommand] = useState("");
  const [autoScrollTerminal, setAutoScrollTerminal] = useState(true);
  const [terminalHeight, setTerminalHeight] = useState(140);
  const [isResizingTerminal, setIsResizingTerminal] = useState(false);

  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [lastEstimate, setLastEstimate] = useState<IcmCalibrationEstimate | null>(null);

  const terminalLogRef = useRef<HTMLDivElement | null>(null);
  const terminalResizeStartYRef = useRef(0);
  const terminalResizeStartHeightRef = useRef(140);

  const boardName = useMemo(() => {
    return board === "ass" ? "nrf52840dk/nrf52840" : "nrf52840dk/nrf52840";
  }, [board]);

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

  function onTerminalResizeStart(event: ReactMouseEvent<HTMLDivElement>) {
    terminalResizeStartYRef.current = event.clientY;
    terminalResizeStartHeightRef.current = terminalHeight;
    setIsResizingTerminal(true);
    event.preventDefault();
  }

  function pushLog(level: LogEntry["level"], text: string) {
    setLogs((prev) => [...prev, { ts: toTimestamp(), level, text }]);
  }

  function globalArgs(includeRepoRoot: boolean): string[] {
    const args: string[] = [];

    if (firmwareDir.trim()) {
      args.push("--firmware-dir", firmwareDir.trim());
    }

    if (nrfjprogPath.trim()) {
      args.push("--nrfjprog", nrfjprogPath.trim());
    }

    if (westPath.trim()) {
      args.push("--west", westPath.trim());
    }

    if (jlinkGdbServerPath.trim()) {
      args.push("--jlink-gdb-server", jlinkGdbServerPath.trim());
    }

    if (includeRepoRoot && repoRoot.trim()) {
      args.push("--repo-root", repoRoot.trim());
    }

    return args;
  }

  function rttOptionArgs(): string[] {
    const args: string[] = [];

    if (serial.trim()) {
      args.push("--serial-number", serial.trim());
    }

    args.push("--device-name", deviceName.trim() || "nRF52840_xxAA");
    args.push("--speed-khz", speedKhz.trim() || "4000");
    args.push("--gdb-port", gdbPort.trim() || "2331");
    args.push("--rtt-telnet-port", rttTelnetPort.trim() || "19021");
    args.push("--connect-timeout-ms", connectTimeoutMs.trim() || "10000");
    args.push("--ack-timeout-ms", ackTimeoutMs.trim() || "2000");

    return args;
  }

  async function run(args: string[]): Promise<unknown | null> {
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
      setBusy(false);
    }
  }

  async function onBuild(event: FormEvent) {
    event.preventDefault();

    if (!repoRoot.trim()) {
      pushLog("error", "repo root is required for build");
      return;
    }

    await run([
      ...globalArgs(true),
      "build",
      "--board",
      board,
      "--board-name",
      boardName,
      "--build-type",
      "imu_calibration_rtt",
    ]);
  }

  async function onFlash(event: FormEvent) {
    event.preventDefault();

    const args = [
      ...globalArgs(false),
      "flash",
      "--board",
      board,
      "--imu",
      imu,
      "--erase",
      eraseMode,
    ];

    if (serial.trim()) {
      args.push("--serial-number", serial.trim());
    }

    if (flashHexPath.trim()) {
      args.push("--hex", flashHexPath.trim());
    }

    await run(args);
  }

  async function onConfigureImu() {
    const commands: string[] = [];

    if (imu === "icm45686") {
      commands.push("IMU ICM45686");
      commands.push("STREAM_FORMAT CSV");
      commands.push(`STREAM_HZ ${streamHz.trim() || "200"}`);
      commands.push(`ODR ${odrHz.trim() || "200"}`);
      commands.push(`ACCEL_RANGE ${accelRangeG.trim() || "16"}`);
      commands.push(`GYRO_RANGE ${gyroRangeDps.trim() || "2000"}`);
      commands.push(`LOW_NOISE ${encodeBool(lowNoise)}`);
      commands.push(`FIFO ${encodeBool(fifo)}`);
      commands.push(`FIFO_HIRES ${encodeBool(fifoHires)}`);
      commands.push("APPLY");
    } else {
      commands.push("IMU BNO086");
      commands.push("STREAM_FORMAT CSV");
      commands.push(`STREAM_HZ ${streamHz.trim() || "100"}`);
      commands.push(`ODR ${odrHz.trim() || "100"}`);
      commands.push(`BNO_RAW ${encodeBool(bnoRaw)}`);
      commands.push(`BNO_6DOF ${encodeBool(bno6dof)}`);
      commands.push(`BNO_9DOF ${encodeBool(bno9dof)}`);
      commands.push("APPLY");
    }

    const args = [...globalArgs(false), "rtt-command", ...rttOptionArgs()];
    for (const command of commands) {
      args.push("--cmd", command);
    }
    args.push("--cmd", "STATUS");

    await run(args);
  }

  async function onStatus() {
    await run([...globalArgs(false), "rtt-command", ...rttOptionArgs(), "--cmd", "STATUS"]);
  }

  async function onStartStream() {
    await run([...globalArgs(false), "rtt-command", ...rttOptionArgs(), "--cmd", "START"]);
  }

  async function onStopStream() {
    await run([...globalArgs(false), "rtt-command", ...rttOptionArgs(), "--cmd", "STOP"]);
  }

  async function onCaptureIcmCalibration() {
    if (imu !== "icm45686") {
      pushLog("error", "capture+compute is currently implemented for ICM45686");
      return;
    }

    const output = await run([
      ...globalArgs(false),
      "icm-capture-cal",
      ...rttOptionArgs(),
      "--capture-seconds",
      captureSeconds.trim() || "30",
      "--gyro-bias-seconds",
      gyroBiasSeconds.trim() || "5",
      "--odr-hz",
      odrHz.trim() || "200",
      "--stream-hz",
      streamHz.trim() || "200",
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
    ]);

    if (!isIcmCaptureResult(output)) {
      return;
    }

    setLastEstimate(output.estimate);
    pushLog(
      "info",
      `ICM calibration computed. samples=${output.estimate.sample_count}, gyro_bias=[${output.estimate.gyro_bias_dps.map((v) => v.toFixed(5)).join(", ")}], rms=${output.estimate.residual_rms_mps2.toFixed(5)}`,
    );
  }

  async function onWriteIcmCalibration() {
    if (imu !== "icm45686") {
      pushLog("error", "write calibration is currently implemented for ICM45686");
      return;
    }

    if (!lastEstimate) {
      pushLog("error", "no computed ICM calibration available. Run capture+compute first.");
      return;
    }

    const estimateJson = JSON.stringify(lastEstimate);

    await run([
      ...globalArgs(false),
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
      "--estimate-json",
      estimateJson,
    ]);
  }

  async function onBnoCalStart() {
    await run([
      ...globalArgs(false),
      "rtt-command",
      ...rttOptionArgs(),
      "--cmd",
      "IMU BNO086",
      "--cmd",
      "APPLY",
      "--cmd",
      "CAL_START",
      "--cmd",
      "START",
    ]);
  }

  async function onBnoCalReady() {
    await run([
      ...globalArgs(false),
      "rtt-command",
      ...rttOptionArgs(),
      "--cmd",
      "IMU BNO086",
      "--cmd",
      "CAL_READY",
      "--cmd",
      "CAL_STATUS",
    ]);
  }

  async function onBnoCalSave() {
    await run([
      ...globalArgs(false),
      "rtt-command",
      ...rttOptionArgs(),
      "--cmd",
      "IMU BNO086",
      "--cmd",
      "STOP",
      "--cmd",
      "CAL_SAVE",
      "--cmd",
      "CAL_STATUS",
    ]);
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

    const args = [...globalArgs(false), "rtt-command", ...rttOptionArgs()];
    for (const command of commands) {
      args.push("--cmd", command);
    }

    await run(args);
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
            Firmware Bundle Dir
            <input
              type="text"
              value={firmwareDir}
              onChange={(event) => setFirmwareDir(event.target.value)}
              placeholder="/abs/path/calibration_software/firmware"
            />
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
            west Executable
            <input
              type="text"
              value={westPath}
              onChange={(event) => setWestPath(event.target.value)}
              placeholder="west"
            />
          </label>

          <label>
            J-Link GDB Server
            <input
              type="text"
              value={jlinkGdbServerPath}
              onChange={(event) => setJlinkGdbServerPath(event.target.value)}
              placeholder="JLinkGDBServerCL"
            />
          </label>
        </div>

        <div className="action-row">
          <button disabled={busy} onClick={() => run([...globalArgs(false), "tools"])}>
            Check Tools
          </button>
          <button disabled={busy} onClick={() => run([...globalArgs(false), "probes"])}>
            List Probes
          </button>
        </div>
      </div>
    );
  }

  function renderFirmwareTab() {
    return (
      <div className="tab-content-block">
        <h2 className="section-title">Build and Flash</h2>
        <div className="grid grid-2">
          <label>
            Repository Root (required to build)
            <input
              type="text"
              value={repoRoot}
              onChange={(event) => setRepoRoot(event.target.value)}
              placeholder="/absolute/path/to/CONVOY-ASS-Firmware"
            />
          </label>

          <label>
            Flash HEX Override (optional)
            <input
              type="text"
              value={flashHexPath}
              onChange={(event) => setFlashHexPath(event.target.value)}
              placeholder="/absolute/path/to/firmware.hex"
            />
          </label>

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
          Target: <strong>{BOARD_LABELS[board]}</strong> | IMU: <strong>{imu}</strong>
        </div>

        <div className="action-row">
          <button disabled={busy} onClick={onBuild}>
            Build Calibration Firmware
          </button>
          <button disabled={busy} onClick={onFlash}>
            Flash Calibration Firmware
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

        <div className="action-row">
          <button disabled={busy} onClick={onConfigureImu}>
            Configure + Apply
          </button>
          <button disabled={busy} onClick={onStartStream}>
            Start Stream
          </button>
          <button disabled={busy} onClick={onStopStream}>
            Stop Stream
          </button>
          <button disabled={busy} onClick={onStatus}>
            Read Status
          </button>
        </div>
      </div>
    );
  }

  function renderCalibrationTab() {
    if (imu === "icm45686") {
      return (
        <div className="tab-content-block">
          <h2 className="section-title">ICM Host Calibration</h2>
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
          </div>

          <div className="action-row">
            <button disabled={busy} onClick={onCaptureIcmCalibration}>
              Capture + Compute
            </button>
            <button disabled={busy || !lastEstimate} onClick={onWriteIcmCalibration}>
              Write Calibration to Board
            </button>
          </div>

          <h3 className="section-subtitle">Last Computed Estimate</h3>
          {lastEstimate ? (
            <pre className="mono-block">{JSON.stringify(lastEstimate, null, 2)}</pre>
          ) : (
            <p className="info-note">No estimate computed yet.</p>
          )}
        </div>
      );
    }

    return (
      <div className="tab-content-block">
        <h2 className="section-title">BNO Calibration Flow</h2>
        <p className="info-note">
          This runs BNO086 internal calibration phases. Move sensor through required motions
          (including figure-8 for magnetometer when needed), then save.
        </p>

        <div className="action-row">
          <button disabled={busy} onClick={onBnoCalStart}>
            Start BNO Calibration
          </button>
          <button disabled={busy} onClick={onBnoCalReady}>
            Mark Ready / Continue
          </button>
          <button disabled={busy} onClick={onBnoCalSave}>
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
        <div className="status-pill">{busy ? "Running..." : "Idle"}</div>
      </section>

      <nav className="tabs" aria-label="Workflow tabs">
        {(Object.keys(TAB_LABELS) as TabKey[]).map((tab) => (
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
          {logs.length === 0 ? (
            <div className="terminal-empty">No logs yet.</div>
          ) : (
            logs.map((entry, idx) => (
              <pre key={`${entry.ts}-${idx}`} className={`terminal-line ${entry.level}`}>
                [{entry.ts}] {entry.text}
              </pre>
            ))
          )}
        </div>

        <form className="terminal-form" onSubmit={onSendTerminalCommand}>
          <input
            className="terminal-input"
            type="text"
            value={terminalCommand}
            onChange={(event) => setTerminalCommand(event.target.value)}
            placeholder='Raw RTT command (use ";" to send multiple, e.g. IMU ICM45686; STATUS)'
          />
          <button type="submit" disabled={busy || !terminalCommand.trim()}>
            Send
          </button>
        </form>
      </section>
    </main>
  );
}
