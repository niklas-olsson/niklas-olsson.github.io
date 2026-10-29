// SPDX-License-Identifier: Apache-2.0

import {
  type MachineRuntime,
  type OutputListener,
  type RuntimeCapabilities,
  type RuntimeListener,
  type RuntimeSnapshot,
  type SerialPort,
} from "./runtime-types.ts";
import {
  commandFrame,
  CommandFrameReader,
  shellQuote,
} from "./command-protocol.ts";
import { validateInitScript } from "./guest-startup.ts";
import type { NetworkPort } from "./network.ts";
import {
  TINYEMU_PROFILE_ASSETS,
  TINYEMU_WASM,
  type TinyEmuAsset,
} from "./tinyemu-assets.ts";
import {
  getRuntimeProfile,
  type RuntimeProfile,
  type TinyEmuProfileId,
} from "./runtime-profiles.ts";

const BOOT_TIMEOUT_MS = 120_000;
const STARTUP_TIMEOUT_MS = 60_000;
const TRANSCRIPT_LIMIT = 256 * 1024;

// The upstream minimal rootfs omits glibc NSS resolver libraries. A named,
// explicit HTTP proxy helper works without changing global guest DNS behavior.
function webgetScript(gateway: string): string {
  return `#!/bin/sh
if [ "$#" -eq 0 ]; then
  echo 'Usage: webget [wget options] http://host/path' >&2
  echo 'Requires Terrarium World mode with the Browser bridge transport.' >&2
  exit 2
fi
http_proxy=http://${gateway} wget "$@"
_webget_rc=$?
if [ "$_webget_rc" -ne 0 ]; then
  echo 'webget requires World + Browser bridge; Wisp and Isolated modes cannot use this HTTP helper.' >&2
  echo 'With Browser bridge enabled, inspect the wget error for HTTP, CORS, or connectivity failures.' >&2
fi
exit "$_webget_rc"
`;
}

interface TinyEmuOptions {
  profileId?: TinyEmuProfileId;
  initScript?: string;
  networkPort?: NetworkPort;
}
interface StartupCommand {
  reader: CommandFrameReader;
  resolve: (result: { output: string; exitCode: number }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface ControlRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function errorOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function assetUrl(file: string): string {
  return new URL(
    `${import.meta.env?.BASE_URL ?? "/"}runtime/tinyemu/${file}`,
    document.baseURI,
  ).href;
}

async function fetchVerified(
  asset: TinyEmuAsset,
  signal: AbortSignal,
  progress: (bytes: number) => void,
): Promise<ArrayBuffer> {
  const response = await fetch(asset.url, {
    signal,
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok)
    throw new Error(
      `${asset.name} download failed (HTTP ${response.status}). Retry when the asset host is available.`,
    );
  const bytes = new Uint8Array(asset.bytes);
  let received = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        if (received + result.value.length > bytes.length)
          throw new Error(`${asset.name} has an unexpected size.`);
        bytes.set(result.value, received);
        received += result.value.length;
        progress(received);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } else {
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length > bytes.length)
      throw new Error(`${asset.name} has an unexpected size.`);
    bytes.set(data);
    received = data.length;
  }
  if (received !== bytes.length)
    throw new Error(`${asset.name} download was incomplete.`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== asset.sha256)
    throw new Error(
      `${asset.name} failed its integrity check. The image has not been executed.`,
    );
  if (signal.aborted) throw new Error("Machine boot was cancelled.");
  progress(received);
  return bytes.buffer;
}

/** Real RV64IMA(FD)C system emulation, isolated in a dedicated worker. */
export class TinyEmuRuntime implements MachineRuntime {
  readonly capabilities: RuntimeCapabilities;
  readonly profileId: TinyEmuProfileId;
  private readonly profile: RuntimeProfile;
  private readonly listeners = new Set<RuntimeListener>();
  private readonly outputListeners = new Set<OutputListener>();
  private readonly networkListeners = new Set<(frame: Uint8Array) => void>();
  private readonly networkPort?: NetworkPort;
  private initScript: string;
  private snapshot: RuntimeSnapshot;
  private transcript = "";
  private promptTail = "";
  private worker: Worker | null = null;
  private generation = 0;
  private bootPromise: Promise<void> | null = null;
  private downloadController: AbortController | null = null;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private ready: {
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;
  private startup: StartupCommand | null = null;
  private readonly controls = new Map<number, ControlRequest>();
  private nextControlId = 1;
  private carrier = false;

  constructor(options: TinyEmuOptions = {}) {
    this.profileId = options.profileId ?? "riscv64";
    if (!Object.hasOwn(TINYEMU_PROFILE_ASSETS, this.profileId))
      throw new Error("Unknown TinyEMU guest profile.");
    this.profile = getRuntimeProfile(this.profileId);
    this.capabilities = Object.freeze({
      label: `TinyEMU · ${this.profile.userland}`,
      architecture: this.profile.architecture,
      serialPorts: [0] as const,
      interactivePorts: [0] as const,
      snapshots: false,
      initScripts: true,
      network: "web",
    });
    this.initScript = validateInitScript(options.initScript ?? "");
    this.networkPort = options.networkPort;
    this.snapshot = Object.freeze<RuntimeSnapshot>({
      status: "idle",
      operation: null,
      downloadProgress: null,
      startedAt: null,
      message: `Ready to boot ${this.profile.userland} on RISC-V64.`,
      controlReady: false,
      displayEpoch: 0,
      sessions: [{ port: 0, title: "Console", status: "starting" }],
      init: {
        status: "idle",
        output: "",
        exitCode: null,
        message: "Runs on the next fresh boot.",
      },
    });
  }

  getSnapshot = (): RuntimeSnapshot => this.snapshot;
  getInitScript = (): string => this.initScript;
  setInitScript = (script: string): void => {
    this.initScript = validateInitScript(script);
  };

  subscribe = (listener: RuntimeListener): (() => void) => {
    this.listeners.add(listener);
    try {
      listener(this.snapshot);
    } catch {
      /* Observers do not own the VM. */
    }
    return () => {
      this.listeners.delete(listener);
    };
  };

  onOutput = (listener: OutputListener, port: SerialPort = 0): (() => void) => {
    this.requirePort(port);
    this.outputListeners.add(listener);
    if (this.transcript) {
      try {
        listener(this.transcript);
      } catch {
        /* A view can detach independently. */
      }
    }
    return () => {
      this.outputListeners.delete(listener);
    };
  };

  onNetworkFrame = (listener: (frame: Uint8Array) => void): (() => void) => {
    this.networkListeners.add(listener);
    return () => {
      this.networkListeners.delete(listener);
    };
  };

  sendNetworkFrame = (frame: Uint8Array): void => {
    if (
      !this.worker ||
      !this.carrier ||
      !["booting", "running"].includes(this.snapshot.status) ||
      frame.length < 14 ||
      frame.length > 65_536
    )
      return;
    const copy = new Uint8Array(frame);
    this.worker.postMessage({ type: "network", frame: copy.buffer }, [
      copy.buffer,
    ]);
  };

  setNetworkCarrier = (enabled: boolean): void => {
    this.carrier = enabled;
    this.worker?.postMessage({ type: "carrier", enabled });
  };

  private requirePort(port: SerialPort): void {
    if (port !== 0)
      throw new Error("This RISC-V64 image exposes one hvc0 console.");
  }

  private update(patch: Partial<RuntimeSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot);
      } catch {
        /* Keep machine state independent of views. */
      }
    }
  }

  private receiveOutput(data: string): void {
    this.transcript = (this.transcript + data).slice(-TRANSCRIPT_LIMIT);
    if (this.ready) {
      this.promptTail = (this.promptTail + data).slice(-4_096);
      const plain = this.promptTail
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\r/g, "");
      if (/(?:^|\n)[^\n]{0,80}# $/.test(plain)) {
        const pending = this.ready;
        this.ready = null;
        pending.resolve();
      }
    }
    if (this.startup) {
      const pending = this.startup;
      const result = pending.reader.push(data);
      if (result.complete || result.limited) {
        this.startup = null;
        clearTimeout(pending.timer);
        if (result.limited)
          pending.reject(
            new Error(
              "Startup output exceeded 64 KiB. Reset the machine to recover.",
            ),
          );
        else
          pending.resolve({
            output: result.output,
            exitCode: result.exitCode!,
          });
      }
    }
    for (const listener of this.outputListeners) {
      try {
        listener(data);
      } catch {
        /* A failed terminal does not halt emulation. */
      }
    }
  }

  private stopWorker(reason: Error): void {
    this.downloadController?.abort();
    this.downloadController = null;
    if (this.bootTimer !== null) clearTimeout(this.bootTimer);
    this.bootTimer = null;
    this.ready?.reject(reason);
    this.ready = null;
    if (this.startup) {
      clearTimeout(this.startup.timer);
      this.startup.reject(reason);
      this.startup = null;
    }
    for (const pending of this.controls.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.controls.clear();
    this.worker?.terminate();
    this.worker = null;
    try {
      this.networkPort?.setReady(false);
      this.networkPort?.detach();
    } catch {
      /* The owner may already have disposed this machine's network port. */
    }
    this.carrier = false;
  }

  boot = (): Promise<void> => {
    if (this.bootPromise) return this.bootPromise;
    if (this.snapshot.status === "running") return Promise.resolve();
    if (this.snapshot.status === "paused") return this.resume();
    const generation = ++this.generation;
    this.stopWorker(new Error("Starting a fresh machine."));
    this.transcript = "";
    this.promptTail = "";
    this.receiveOutput("\x1bc");
    const script = this.initScript;
    this.update({
      status: "loading",
      operation: null,
      message: `Downloading and verifying ${this.profile.userland}…`,
      downloadProgress: 0,
      startedAt: null,
      controlReady: false,
      displayEpoch: (this.snapshot.displayEpoch ?? 0) + 1,
      sessions: [{ port: 0, title: "Console", status: "starting" }],
      init: {
        status: script.trim() ? "pending" : "skipped",
        output: "",
        exitCode: null,
        message: script.trim()
          ? "Waiting for the guest shell."
          : "No init script configured.",
      },
    });
    const task = this.start(generation, script)
      .catch((error: unknown) => {
        const failure = errorOf(error);
        if (this.generation === generation) {
          this.stopWorker(failure);
          this.update({
            status: "error",
            message: failure.message,
            downloadProgress: null,
            controlReady: false,
            ...(this.snapshot.init?.status === "running"
              ? {
                  init: {
                    ...this.snapshot.init,
                    status: "failed" as const,
                    message: failure.message,
                  },
                }
              : {}),
          });
        }
        throw failure;
      })
      .finally(() => {
        if (this.bootPromise === task) this.bootPromise = null;
      });
    this.bootPromise = task;
    return task;
  };

  private async start(generation: number, script: string): Promise<void> {
    if (typeof Worker === "undefined" || typeof WebAssembly === "undefined")
      throw new Error(
        "This browser needs Web Workers and WebAssembly to run RISC-V64.",
      );
    if (!globalThis.crypto?.subtle)
      throw new Error("Image verification requires HTTPS or localhost.");
    if (
      this.profileId !== "riscv64" &&
      typeof DecompressionStream === "undefined"
    )
      throw new Error(
        "This profile requires browser gzip decompression support.",
      );
    const controller = new AbortController();
    this.downloadController = controller;
    this.bootTimer = setTimeout(() => {
      const error = new Error(
        "RISC-V64 boot timed out. Check connectivity and retry.",
      );
      controller.abort();
      this.ready?.reject(error);
      this.startup?.reject(error);
    }, BOOT_TIMEOUT_MS);
    const definitions = {
      ...TINYEMU_PROFILE_ASSETS[this.profileId],
      wasm: { ...TINYEMU_WASM, url: assetUrl("riscvemu64-wasm.wasm") },
    };
    const received = new Map<string, number>();
    const total = Object.values(definitions).reduce(
      (sum, value) => sum + value.bytes,
      0,
    );
    const pairs = await Promise.all(
      Object.entries(definitions).map(async ([key, asset]) => {
        const bytes = await fetchVerified(
          asset,
          controller.signal,
          (amount) => {
            received.set(key, amount);
            if (this.generation === generation)
              this.update({
                downloadProgress: Math.round(
                  ([...received.values()].reduce((sum, n) => sum + n, 0) /
                    total) *
                    100,
                ),
              });
          },
        );
        return [key, bytes] as const;
      }),
    );
    if (this.generation !== generation)
      throw new Error("Machine boot was cancelled.");
    this.downloadController = null;
    const buffers = Object.fromEntries(pairs);
    const worker = new Worker(assetUrl("worker.js"), {
      name: "terrarium-riscv64",
    });
    this.worker = worker;
    await this.networkPort?.attachEthernet(this);
    if (generation !== this.generation || worker !== this.worker)
      throw new Error("Machine boot was cancelled.");
    this.networkPort?.setReady(false);
    this.update({
      status: "booting",
      message: `Preparing ${this.profile.userland} · Linux ${this.profile.kernel} · RISC-V64…`,
      downloadProgress: 100,
      startedAt: Date.now(),
    });
    const ready = new Promise<void>((resolve, reject) => {
      this.ready = { resolve, reject };
    });
    worker.onmessage = ({ data }) => {
      if (generation !== this.generation || worker !== this.worker) return;
      if (data.type === "output" && typeof data.data === "string")
        this.receiveOutput(data.data);
      else if (data.type === "network" && data.frame instanceof ArrayBuffer) {
        const bytes = new Uint8Array(data.frame);
        if (bytes.length < 14 || bytes.length > 65_536) return;
        for (const listener of this.networkListeners) {
          try {
            listener(bytes);
          } catch {
            /* A disconnected LAN port can drop a frame. */
          }
        }
      } else if (data.type === "ack") {
        const pending = this.controls.get(data.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.controls.delete(data.id);
          pending.resolve();
        }
      } else if (data.type === "error")
        this.failWorker(new Error(String(data.message)), generation);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.failWorker(
        new Error(event.message || "The RISC-V64 worker failed to load."),
        generation,
      );
    };
    worker.postMessage(
      {
        type: "boot",
        ...buffers,
        profileId: this.profileId,
        memoryMiB: this.profile.memoryMiB,
        network: !!this.networkPort,
      },
      Object.values(buffers),
    );
    await ready;
    if (this.generation !== generation)
      throw new Error("Machine boot was cancelled.");
    const networkScript = this.networkPort?.guestSetupCommand() ?? "";
    const helper = this.networkPort
      ? `printf '%s' ${shellQuote(webgetScript(this.networkPort.getSnapshot().gateway))} > /usr/bin/webget\nchmod 755 /usr/bin/webget`
      : ":";
    const setup = await this.runStartupCommand(
      `export TERM=xterm-256color\nstty sane -ixon -ixoff rows 30 cols 100\n${networkScript || ":"}\n${helper}`,
    );
    if (setup.exitCode !== 0)
      throw new Error(
        `Guest console/network initialization failed (exit ${setup.exitCode}).`,
      );
    this.networkPort?.setReady(true);
    if (script.trim()) {
      this.update({
        message: "Running the fresh-boot init script…",
        init: {
          status: "running",
          output: "",
          exitCode: null,
          message: "Executing in a noninteractive shell.",
        },
      });
      const result = await this.runStartupCommand(script);
      this.update({
        init: {
          status: result.exitCode === 0 ? "succeeded" : "failed",
          output: result.output,
          exitCode: result.exitCode,
          message:
            result.exitCode === 0
              ? "Init script completed."
              : `Init script exited with code ${result.exitCode}.`,
        },
      });
    }
    if (this.generation !== generation || worker !== this.worker)
      throw new Error("Machine boot was cancelled.");
    if (this.bootTimer !== null) clearTimeout(this.bootTimer);
    this.bootTimer = null;
    this.update({
      status: "running",
      message: `${this.profile.userland} · RISC-V64 · ${this.profile.memoryMiB} MiB`,
      downloadProgress: null,
      controlReady: true,
      sessions: [{ port: 0, title: "Console", status: "ready" }],
    });
    this.networkPort?.setReady(true);
  }

  private failWorker(error: Error, generation: number): void {
    if (generation !== this.generation) return;
    this.stopWorker(error);
    this.update({
      status: "error",
      message: error.message,
      downloadProgress: null,
      controlReady: false,
    });
  }

  private runStartupCommand(
    command: string,
  ): Promise<{ output: string; exitCode: number }> {
    if (!this.worker)
      return Promise.reject(new Error("The RISC-V64 worker is not running."));
    const token = crypto.randomUUID().replace(/-/g, "");
    const frame = commandFrame(command, token);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.startup = null;
        reject(
          new Error(
            "The init script did not finish within 60 seconds. Reset the machine to recover.",
          ),
        );
      }, STARTUP_TIMEOUT_MS);
      this.startup = {
        reader: new CommandFrameReader(token),
        resolve,
        reject,
        timer,
      };
      this.worker!.postMessage({ type: "input", text: frame });
    });
  }

  send = (text: string, port: SerialPort = 0): void => {
    this.requirePort(port);
    if (
      !this.worker ||
      this.snapshot.status !== "running" ||
      this.controls.size
    )
      return;
    if (
      typeof text !== "string" ||
      new TextEncoder().encode(text).length > 32_768
    )
      throw new Error("Console input is limited to 32 KiB per send.");
    this.worker.postMessage({ type: "input", text });
  };

  private control(type: "pause" | "resume"): Promise<void> {
    if (!this.worker)
      return Promise.reject(new Error("Boot this machine first."));
    if (this.controls.size)
      return Promise.reject(
        new Error("Wait for the current machine control operation."),
      );
    const worker = this.worker;
    const id = this.nextControlId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(id);
        const error = new Error(
          "The RISC-V64 worker did not acknowledge the control request. Reset the machine.",
        );
        reject(error);
        this.failWorker(error, this.generation);
      }, 5_000);
      this.controls.set(id, { resolve, reject, timer });
      worker.postMessage({ type, id });
    });
  }

  pause = async (): Promise<void> => {
    if (this.controls.size)
      throw new Error("Wait for the current machine control operation.");
    if (this.snapshot.status === "paused") return;
    if (this.snapshot.status !== "running")
      throw new Error("Boot the machine before pausing it.");
    const generation = this.generation;
    this.networkPort?.setReady(false);
    this.update({
      status: "paused",
      message: "Pausing the RISC-V64 CPU…",
      controlReady: false,
    });
    await this.control("pause");
    if (generation === this.generation)
      this.update({ message: "RISC-V64 CPU and device callbacks are paused." });
  };

  resume = async (): Promise<void> => {
    if (this.controls.size)
      throw new Error("Wait for the current machine control operation.");
    if (this.snapshot.status === "running") return;
    if (this.snapshot.status !== "paused")
      throw new Error("Pause the machine before resuming it.");
    const generation = this.generation;
    await this.control("resume");
    if (generation !== this.generation) return;
    this.update({
      status: "running",
      message: `${this.profile.userland} · RISC-V64 · ${this.profile.memoryMiB} MiB`,
      controlReady: true,
    });
    this.networkPort?.setReady(true);
  };

  reset = async (): Promise<void> => {
    await this.destroy();
    await this.boot();
  };
  save = (): Promise<ArrayBuffer> =>
    Promise.reject(
      new Error("This TinyEMU runtime does not support checkpoints."),
    );
  restore = (_buffer: ArrayBuffer): Promise<void> =>
    Promise.reject(
      new Error("This TinyEMU runtime does not support checkpoint restore."),
    );

  destroy = async (): Promise<void> => {
    ++this.generation;
    this.stopWorker(new Error("Machine was stopped."));
    this.bootPromise = null;
    this.update({
      status: "idle",
      operation: null,
      message: "RISC-V64 machine stopped.",
      downloadProgress: null,
      startedAt: null,
      controlReady: false,
      sessions: [{ port: 0, title: "Console", status: "starting" }],
    });
  };
}
