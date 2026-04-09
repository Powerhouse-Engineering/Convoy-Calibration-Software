export type BackendCallResult = {
  mode: "tauri" | "preview";
  command: string;
  output: unknown;
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
