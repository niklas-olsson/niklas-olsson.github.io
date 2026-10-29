// SPDX-License-Identifier: Apache-2.0
import type { EvidenceArchive } from "./evidence.ts";
import type { RunResult } from "./command-runner.ts";
import type { VolumeAttachment, VolumeAttachmentState } from "./volume-types.ts";
import type { GuestCapabilityReport } from "./guest-capabilities.ts";
import type { X86MachineConfiguration } from "./x86-machine-config.ts";

export interface RestoreOptions {
  paused?: boolean;
}
export interface EvidenceCaptureOptions {
  title?: string;
  machineId?: string;
  machineName?: string;
  checkpointSha256?: string;
}
export type EvidenceExecutor = (command: string) => Promise<RunResult>;

export type RuntimeStatus =
  | "idle"
  | "loading"
  | "booting"
  | "running"
  | "paused"
  | "error";

export type SerialPort = 0 | 1 | 2 | 3;

export interface InitScriptState {
  status: "idle" | "pending" | "running" | "succeeded" | "failed" | "skipped";
  output: string;
  exitCode: number | null;
  message: string;
}

export interface ShellSession {
  port: SerialPort;
  title: string;
  status: "starting" | "ready" | "unavailable";
}

export interface RuntimeCapabilities {
  label: string;
  architecture: string;
  serialPorts: readonly SerialPort[];
  interactivePorts: readonly SerialPort[];
  snapshots: boolean;
  initScripts: boolean;
  network?: "web" | "local" | "none";
  evidenceCapture?: boolean;
  evidenceMount?: boolean;
  volumes?: boolean;
  /** Loading/booting can be cancelled and its owned resources fully drained. */
  cancelBoot?: boolean;
}

export interface RuntimeSnapshot {
  machineConfiguration?: X86MachineConfiguration;
  status: RuntimeStatus;
  operation: "saving" | "restoring" | null;
  message: string;
  /** Download percentage, or null while the total is unknown. */
  downloadProgress: number | null;
  /** Time the current VM started, in milliseconds since the Unix epoch. */
  startedAt: number | null;
  init?: InitScriptState;
  sessions?: readonly ShellSession[];
  /** False when the dedicated command channel needs a reset. */
  controlReady?: boolean;
  /** Incremented when terminal display history is discarded. */
  displayEpoch?: number;
  /** A paused restore has not run guest setup or any guest CPU instructions. */
  passiveRestore?: boolean;
  sourceCheckpointSha256?: string;
  evidenceAttachment?: { id: string; sha256: string; mountPath: string };
  acquiringEvidence?: boolean;
  volumes?: readonly VolumeAttachmentState[];
  volumeOperation?: "attaching" | "detaching" | "syncing" | null;
  /** Actual, guest-reported observations; not a Kubernetes execution guarantee. */
  guestCapabilities?: GuestCapabilityReport;
  guestCapabilityError?: string;
  /** Immutable catalog identity. Fresh boot/reset uses the default; restore selects its recorded bundle. */
  runtimeBundle?: Readonly<{ defaultBootBundleId: string; activeBundleId: string | null }>;
  /** Actual emulator buffer length, separately labelled from configured budgets. Not host RSS. */
  resourceObservation?: Readonly<{
    source: "emulator-memory-buffer";
    sampledAt: number;
    observedWasmMemoryBytes: number;
    configuredGuestMemoryMiB: number;
    configuredTranslationCacheMiB: number;
    accountedWasmReservationMiB: number;
    budgetId: string;
  }>;
}

export type RuntimeListener = (snapshot: RuntimeSnapshot) => void;
export type OutputListener = (data: string) => void;

/** Common contract for independently owned browser machines. */
export interface MachineRuntime {
  readonly capabilities: RuntimeCapabilities;
  getSnapshot(): RuntimeSnapshot;
  subscribe(listener: RuntimeListener): () => void;
  onOutput(listener: OutputListener, port?: SerialPort): () => void;
  send(text: string, port?: SerialPort): void;
  boot(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  reset(): Promise<void>;
  save(): Promise<ArrayBuffer>;
  restore(buffer: ArrayBuffer, options?: RestoreOptions): Promise<void>;
  destroy(): Promise<void>;
  setInitScript(script: string): void;
  getInitScript(): string;
  captureEvidence?(
    paths: string[],
    execute: EvidenceExecutor,
    options?: EvidenceCaptureOptions,
  ): Promise<EvidenceArchive>;
  attachEvidence?(archive: EvidenceArchive): Promise<void>;
  attachVolume?(attachment: VolumeAttachment): Promise<void>;
  detachVolume?(slot: 0 | 1): Promise<void>;
  getVolumeAttachments?(): readonly VolumeAttachment[];
  syncVolumes?(execute: EvidenceExecutor): Promise<void>;
  prepareVolumeShutdown?(execute: EvidenceExecutor): Promise<void>;
}

export const RUNTIME_MEMORY_MIB = 128;
export const RUNTIME_VERSION = "v86@0.5.472-uart4-v1";
export const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
export const MAX_INIT_SCRIPT_BYTES = 8_192;
