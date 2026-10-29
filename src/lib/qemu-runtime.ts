// SPDX-License-Identifier: Apache-2.0

import {
  type MachineRuntime,
  type OutputListener,
  type RuntimeCapabilities,
  type RuntimeListener,
  type RuntimeSnapshot,
  type SerialPort,
  type EvidenceExecutor,
  type EvidenceCaptureOptions,
  type RestoreOptions,
} from "./runtime-types.ts";
import { getSharedMemorySupport } from "./browser-isolation.ts";
import { defaultQemuResourceBudget, type QemuResourceBudget, type QemuResourceLease } from "./runtime-resources.ts";
import { parseQemuTranslationStats, type QemuMonitorResourceObservation } from "../../public/runtime/qemu/monitor.js";
import { assertQemuConstructorOptions } from "../../public/runtime/qemu/options.js";
import { defaultX86MachineConfiguration, validateX86MachineConfiguration, qemuPresetBootOptions, type X86MachineConfiguration } from "./x86-machine-config.ts";
import { readMachineImage } from "./machine-image-store.ts";
import type { RawMachineImage } from "../../public/runtime/qemu/custom-image.js";
import { buildGuestCapabilityProbe, parseGuestCapabilityReport } from "./guest-capabilities.ts";
import {
  commandFrame,
  CommandFrameReader,
  shellQuote,
} from "./command-protocol.ts";
import {
  INTERACTIVE_SERIAL_PORTS,
  isSessionPrompt,
  sessionBootstrapCommand,
  validateInitScript,
} from "./guest-startup.ts";
import type { NetworkPort } from "./network.ts";
import type { VolumeAttachment } from "./volume-types.ts";
import { QemuVolumeManager } from "./qemu-volumes.ts";
import {
  createEvidenceArchive,
  importEvidenceArchive,
  exportEvidenceArchive,
  sha256Bytes,
  type EvidenceArchive,
} from "./evidence.ts";
import { createQemuEvidenceImage, captureQemuEvidenceFiles } from "./qemu-evidence.ts";
import {
  createQemuCheckpoint,
  parseQemuCheckpoint,
  MAX_QEMU_CHECKPOINT_PAYLOAD_BYTES,
  type QemuCheckpoint,
} from "./qemu-checkpoint.ts";
import {
  DEFAULT_QEMU_BUNDLE_ID,
  getQemuBundle,
  resolveQemuAssetUrl,
  type QemuAsset,
  type QemuBundleId,
  type QemuRuntimeBundle,
} from "./qemu-assets.ts";
import {
  getRuntimeProfile,
  type RuntimeProfile,
} from "./runtime-profiles.ts";

type QemuProfileId = "alpine-x86_64";

const BOOT_TIMEOUT_MS = 240_000;
const STARTUP_TIMEOUT_MS = 60_000;
const TRANSCRIPT_LIMIT = 256 * 1024;

// ttyS0 carries the cooperative command protocol. Keep ordinary asynchronous
// kernel messages in the printk ring instead of mixing them into command
// stdout. Boot messages remain visible; panic/ignore_loglevel and deliberate
// guest policy changes can still override this. Never run this on passive restore.
const CONTROL_CONSOLE_POLICY = [
  "printf '0\\n' > /proc/sys/kernel/printk",
  // proc_dointvec can return EOF on a second read at a nonzero offset. A
  // shell read builtin may read one byte at a time, so read the value in bulk.
  "_trm_console_loglevel=$(cat /proc/sys/kernel/printk)",
  '_trm_console_loglevel=${_trm_console_loglevel%%[[:space:]]*}',
  '[ "$_trm_console_loglevel" = 0 ] || { printf "Could not reserve the command console.\\n" >&2; exit 1; }',
].join("\n");

// An explicit, invocation-local proxy helper for the Browser bridge. Normal
// guest DNS remains independent of this optional convenience command.
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

interface QemuOptions {
  profileId?: QemuProfileId;
  /** Fixed app-owned catalog identity. Never an asset URL or caller-supplied registry. */
  defaultBootBundleId?: QemuBundleId;
  initScript?: string;
  networkPort?: NetworkPort;
  volumes?: readonly VolumeAttachment[];
  /** Explicit qualification policy; ordinary UI/API runtimes share the default. */
  resourceBudget?: QemuResourceBudget;
  machine?: X86MachineConfiguration;
}
interface StartupCommand {
  reader: CommandFrameReader;
  resolve: (result: { output: string; exitCode: number }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface ControlRequest {
  type: ControlType;
  resolve: (reply: ControlReply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
type ControlType = "pause" | "resume" | "destroy" | "flush-disks" | "save-checkpoint" | "inspect-registers" | "inspect-resources";
interface ControlReply { buffer?: ArrayBuffer; registers?: string; resources?: QemuMonitorResourceObservation }
interface PendingBootInputs {
  buffers: Record<string, ArrayBuffer> | null;
  customImage?: RawMachineImage;
}

export interface QemuPausedResourceInspection extends QemuMonitorResourceObservation {
  readonly source: "qemu-hmp-info-jit";
  readonly runtimeBundleId: QemuBundleId;
  readonly sampledAt: number;
  readonly cpuState: "paused";
  readonly configuredTranslationCacheMiB: number;
  readonly excludedMemory: "engine-native-compiled-wasm-and-process-overhead";
}

function resourceReply(value: unknown, bundle: QemuRuntimeBundle): QemuMonitorResourceObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "monitorText,translationStats")
    throw new Error("The emulator returned invalid translation-resource observations.");
  const { monitorText, translationStats } = value as QemuMonitorResourceObservation;
  const parsed = parseQemuTranslationStats(monitorText);
  if (!translationStats || typeof translationStats !== "object" || Array.isArray(translationStats)
    || Object.keys(translationStats).sort().join(",") !== Object.keys(parsed).sort().join(",")
    || Object.entries(parsed).some(([key, number]) => translationStats[key as keyof typeof parsed] !== number)
    || parsed.generatedCodeCapacityBytes > bundle.resources.translationCacheMiB * 1024 * 1024)
    throw new Error("The emulator returned invalid translation-resource observations.");
  return Object.freeze({ monitorText, translationStats: parsed });
}

function errorOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function assetUrl(file: string): string {
  return new URL(
    `${import.meta.env?.BASE_URL ?? "/"}runtime/qemu/${file}`,
    document.baseURI,
  ).href;
}

async function fetchVerified(
  asset: QemuAsset,
  signal: AbortSignal,
  progress: (bytes: number) => void,
): Promise<ArrayBuffer> {
  const response = await fetch(resolveQemuAssetUrl(asset, document.baseURI, import.meta.env?.BASE_URL ?? "/"), {
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

/** Real x86_64 system emulation in a dedicated worker with QEMU pthreads. */
export class QemuRuntime implements MachineRuntime {
  private runtimeCapabilities: RuntimeCapabilities;
  get capabilities(): RuntimeCapabilities { return this.runtimeCapabilities; }
  readonly profileId: QemuProfileId;
  private configuredMachine: X86MachineConfiguration;
  private activeMachine: X86MachineConfiguration | null = null;
  private verifiedImageIdentity: { id: string; guest: RawMachineImage["manifest"]["guest"] } | null = null;
  get defaultBootBundleId(): QemuBundleId { return this.configuredMachine.runtimeBundleId; }
  private activeBundleId: QemuBundleId | null = null;
  private readonly profile: RuntimeProfile;
  private readonly listeners = new Set<RuntimeListener>();
  private readonly outputListeners = Array.from({ length: 4 }, () => new Set<OutputListener>());
  private readonly networkListeners = new Set<(frame: Uint8Array) => void>();
  private readonly networkPort?: NetworkPort;
  private readonly volumes: QemuVolumeManager;
  private storageDrain: Promise<void> | null = null;
  private storageFailure: Error | null = null;
  private volumeTaskBusy = false;
  private volumeShutdownPrepared = false;
  private evidenceArchive: EvidenceArchive | null = null;
  private evidenceImage: ArrayBuffer | null = null;
  private evidenceBusy = false;
  private checkpointBusy = false;
  private restoringCheckpoint = false;
  private restoredNeedsSetup = false;
  private initScript: string;
  private snapshot: RuntimeSnapshot;
  private readonly transcripts = ["", "", "", ""];
  private readonly sessionTails = ["", "", "", ""];
  private promptTail = "";
  private controlQueryTail = "";
  private controlQueriesEnabled = false;
  private worker: Worker | null = null;
  // Browser termination returns void. Native adapters can return a Promise;
  // a rejection leaves ownership unconfirmed and must keep its admission lease.
  private workerTerminationFailure: Error | null = null;
  private readonly resourceBudget: QemuResourceBudget;
  private resourceLease: QemuResourceLease | null = null;
  private generation = 0;
  private bootPromise: Promise<void> | null = null;
  // Blob materialization and crypto verification may outlive abort(). Keep the
  // admitted boot owner until every input operation has actually settled.
  private inputSettlement: Promise<void> | null = null;
  private pendingBootInputs: PendingBootInputs | null = null;
  private destroyPromise: Promise<void> | null = null;
  private downloadController: AbortController | null = null;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private bootFailure: Error | null = null;
  private ready: {
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;
  private startup: StartupCommand | null = null;
  private readonly controls = new Map<number, ControlRequest>();
  private nextControlId = 1;
  private carrier = false;
  private loginSent = false;
  private mac = (() => {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    bytes[0] = (bytes[0] & 0xfc) | 0x02;
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(":");
  })();

  constructor(options: QemuOptions = {}) {
    assertQemuConstructorOptions(options);
    this.resourceBudget = options.resourceBudget ?? defaultQemuResourceBudget;
    this.profileId = options.profileId ?? "alpine-x86_64";
    this.configuredMachine = options.machine ? validateX86MachineConfiguration(options.machine)
      : defaultX86MachineConfiguration({ runtimeBundleId: options.defaultBootBundleId ?? DEFAULT_QEMU_BUNDLE_ID, mac: this.mac });
    if (options.defaultBootBundleId && options.defaultBootBundleId !== this.configuredMachine.runtimeBundleId)
      throw new Error("The selected runtime differs from the machine's configuration identity.");
    this.mac = this.configuredMachine.nic.mac;
    const bundle = getQemuBundle(this.configuredMachine.runtimeBundleId);
    if (this.profileId !== bundle.profileId)
      throw new Error("Unknown QEMU-Wasm guest profile.");
    this.profile = getRuntimeProfile(this.profileId);
    this.runtimeCapabilities = Object.freeze({
      label: `QEMU-Wasm · ${this.guestLabel}`,
      architecture: this.profile.architecture,
      serialPorts: [0, 1, 2, 3] as const,
      interactivePorts: INTERACTIVE_SERIAL_PORTS,
      snapshots: false,
      initScripts: true,
      network: this.profile.capabilities.network,
      volumes: true,
      cancelBoot: true,
      evidenceCapture: true,
      evidenceMount: true,
    });
    this.initScript = validateInitScript(options.initScript ?? "");
    this.networkPort = options.networkPort;
    this.snapshot = Object.freeze<RuntimeSnapshot>({
      status: "idle",
      operation: null,
      downloadProgress: null,
      startedAt: null,
      message: `Ready to boot ${this.guestLabel} on x86_64.`,
      runtimeBundle: Object.freeze({ defaultBootBundleId: this.defaultBootBundleId, activeBundleId: null }),
      controlReady: false,
      displayEpoch: 0,
      sessions: INTERACTIVE_SERIAL_PORTS.map((port) => ({ port, title: `Shell ${port}`, status: "starting" })),
      init: {
        status: "idle",
        output: "",
        exitCode: null,
        message: "Runs on the next fresh boot.",
      },
    });
    this.volumes = new QemuVolumeManager(options.volumes ?? [], {
      onState: (volumes) => this.update({ volumes }),
      onError: (error) => {
        this.storageFailure ??= error;
        if (this.worker) this.failWorker(new Error(`Volume I/O stopped: ${error.message}`), this.generation);
      },
    });
    this.update({ volumes: this.volumes.getStates() });
    this.refreshCapabilities();
  }

  getSnapshot = (): RuntimeSnapshot => this.snapshot;
  getMachineConfiguration = (): X86MachineConfiguration => this.configuredMachine;
  /** Called only after the workspace has validated image availability and committed its definition. */
  setMachineConfiguration = (configuration: X86MachineConfiguration): void => {
    this.requireVolumeConfiguration();
    if (this.resourceLease || this.workerTerminationFailure || this.storageFailure)
      throw new Error("Finish the previous runtime and storage teardown before changing its configuration.");
    const next = validateX86MachineConfiguration(configuration);
    this.configuredMachine = next; this.activeMachine = null; this.activeBundleId = null; this.mac = next.nic.mac;
    this.refreshCapabilities();
    this.update({ message: `Ready to boot the ${next.presetId} x86_64 preset.`, machineConfiguration: next });
  };
  assertMachineConfigurationMutable = (): void => {
    this.requireVolumeConfiguration();
    if (this.resourceLease || this.workerTerminationFailure || this.storageFailure)
      throw new Error("Finish the previous runtime and storage teardown before changing its configuration.");
  };
  private get actualMachine(): X86MachineConfiguration { return this.activeMachine ?? this.configuredMachine; }
  private get guestLabel(): string {
    const image = this.actualMachine.image;
    if (image.kind === "builtin") return this.bundle.guest.userland;
    const verified = this.verifiedImageIdentity?.id === image.id ? this.verifiedImageIdentity.guest : null;
    return verified ? `${verified.name} ${verified.version}` : `Custom Linux image ${image.id.slice(0, 12)}`;
  }
  private get guestDescription(): string {
    const image = this.actualMachine.image;
    const kernel = image.kind === "builtin" ? this.bundle.guest.kernel
      : this.verifiedImageIdentity?.id === image.id ? this.verifiedImageIdentity.guest.kernelRelease : null;
    return `${this.guestLabel}${kernel ? ` · Linux ${kernel}` : ""}`;
  }
  private get hardware() { return qemuPresetBootOptions(this.actualMachine); }
  private get bundle(): QemuRuntimeBundle { return getQemuBundle(this.activeBundleId ?? this.defaultBootBundleId); }
  /** Keeps verification identical while allowing small downloader fixtures in subclasses. */
  protected loadVerifiedAsset(asset: QemuAsset, signal: AbortSignal, progress: (bytes: number) => void): Promise<ArrayBuffer> {
    return fetchVerified(asset, signal, progress);
  }
  getInitScript = (): string => this.initScript;
  setInitScript = (script: string): void => {
    this.initScript = validateInitScript(script);
  };

  getVolumeAttachments = (): readonly VolumeAttachment[] => this.volumes.getAttachments();

  private refreshCapabilities(): void {
    this.runtimeCapabilities = Object.freeze({
      ...this.runtimeCapabilities,
      label: `QEMU-Wasm · ${this.guestLabel}`,
      snapshots: this.profile.capabilities.snapshots && this.hardware.checkpointSupported && !this.evidenceArchive && this.volumes.getAttachments().length === 0,
      evidenceCapture: !this.evidenceArchive,
    });
  }

  private requireVolumeConfiguration(): void {
    if (this.worker || this.bootPromise || this.destroyPromise || this.storageDrain
      || this.volumeTaskBusy || this.evidenceBusy || this.checkpointBusy || this.snapshot.status !== "idle" || this.snapshot.operation)
      throw new Error("Stop this machine and wait for its current operation before changing data disks. Disk hotplug is not supported.");
  }

  attachVolume = async (attachment: VolumeAttachment): Promise<void> => {
    this.requireVolumeConfiguration();
    this.volumeTaskBusy = true;
    this.update({ volumeOperation: "attaching" });
    try { await this.volumes.attach(attachment); this.refreshCapabilities(); }
    finally { this.volumeTaskBusy = false; this.update({ volumeOperation: null }); }
  };

  detachVolume = async (slot: 0 | 1): Promise<void> => {
    this.requireVolumeConfiguration();
    this.volumes.detach(slot);
    this.refreshCapabilities();
  };

  private requireVolumeMaintenance(): void {
    if (this.volumeTaskBusy || this.evidenceBusy || this.checkpointBusy || this.controls.size || this.snapshot.operation)
      throw new Error("Wait for the current machine or disk operation to finish.");
    if (!this.worker || this.snapshot.status !== "running" || !this.snapshot.controlReady)
      throw new Error("Resume this machine and wait for its command channel before syncing data disks.");
  }

  syncVolumes = async (execute: EvidenceExecutor): Promise<void> => {
    if (!this.volumes.getAttachments().length) return;
    this.requireVolumeMaintenance();
    this.volumeTaskBusy = true;
    this.update({ volumeOperation: "syncing" });
    let paused = false;
    try {
      const result = await execute("sync");
      if (result.status !== "exited" || result.exitCode !== 0)
        throw new Error("The guest did not confirm its filesystem sync. " + (result.message ?? result.output.slice(-300)));
      this.update({ operation: "saving", controlReady: false });
      this.networkPort?.setReady(false);
      await this.control("pause");
      paused = true;
      await this.control("flush-disks");
      await this.volumes.flush();
    } catch (error) {
      if (paused) {
        this.storageFailure ??= errorOf(error);
        this.failWorker(new Error("Data-disk sync failed: " + errorOf(error).message), this.generation);
      }
      throw error;
    } finally {
      try {
        if (paused && this.worker && this.snapshot.status === "running") {
          await this.control("resume");
          this.update({ controlReady: true });
          this.networkPort?.setReady(true);
        }
      } catch (error) {
        this.failWorker(errorOf(error), this.generation);
        throw error;
      } finally {
        this.volumeTaskBusy = false;
        this.update({ operation: null, volumeOperation: null });
      }
    }
  };

  /** Refuse unsafe unmounts; successful preparation leaves the CPU stopped. */
  prepareVolumeShutdown = async (execute: EvidenceExecutor): Promise<void> => {
    const writable = this.volumes.getStates().filter((state) => !state.readOnly && state.status === "mounted").map((state) => state.slot);
    if (!writable.length) return;
    this.requireVolumeMaintenance();
    const slots = writable.join(" ");
    const shutdown = [
      "sync || { echo 'The guest could not sync its data disks'; exit 1; }",
      `for _trm_slot in ${slots}; do`,
      '  umount "/mnt/volumes/disk$_trm_slot" || { echo "Data disk $_trm_slot is still busy; shutdown was refused"; exit 1; }',
      "done",
    ].join("\n");
    const repair = [
      "_trm_mount_error=0",
      `for _trm_slot in ${slots}; do`,
      '  _trm_mount="/mnt/volumes/disk$_trm_slot"',
      '  if grep -q " $_trm_mount " /proc/mounts; then',
      '    grep -q " $_trm_mount ext2 rw[, ]" /proc/mounts || _trm_mount_error=1',
      "  else",
      '    mount -t ext2 -o rw,sync,nodev,nosuid "/dev/terrarium-volume$_trm_slot" "$_trm_mount" || _trm_mount_error=1',
      "  fi",
      "done",
      '[ "$_trm_mount_error" = 0 ]',
    ].join("\n");
    this.volumeTaskBusy = true;
    this.update({ volumeOperation: "syncing" });
    let stopping = false;
    try {
      const result = await execute(shutdown);
      if (result.status !== "exited" || result.exitCode !== 0)
        throw new Error("Data disk shutdown was not confirmed: " + (result.output.slice(-600) || result.message || result.status));
      stopping = true;
      this.update({ operation: "saving", controlReady: false });
      this.networkPort?.setReady(false);
      await this.control("pause");
      await this.control("flush-disks");
      await this.volumes.flush();
      this.volumeShutdownPrepared = true;
      this.update({ status: "paused", message: "Data disks are unmounted and committed. The CPU is stopped for shutdown." });
    } catch (error) {
      let repaired = false;
      if (!stopping && this.worker) {
        try { const result = await execute(repair); repaired = result.status === "exited" && result.exitCode === 0; }
        catch { /* A failed control channel cannot confirm rollback. */ }
      }
      if (repaired) this.update({ message: "Shutdown was refused. Close processes using the data disks before retrying." });
      else this.failWorker(new Error("Safe data-disk shutdown could not be confirmed. Disk bytes were preserved. " + errorOf(error).message), this.generation);
      throw error;
    } finally {
      if (!this.volumeShutdownPrepared) {
        this.volumeTaskBusy = false;
        this.update({ operation: null, volumeOperation: null });
      }
    }
  };

  attachEvidence = async (input: EvidenceArchive): Promise<void> => {
    this.requireVolumeConfiguration();
    this.evidenceBusy = true;
    this.update({ acquiringEvidence: true });
    try {
      const archive = await importEvidenceArchive(exportEvidenceArchive(input));
      const image = createQemuEvidenceImage(archive);
      this.evidenceArchive = archive;
      this.evidenceImage = image;
      this.refreshCapabilities();
      this.update({ evidenceAttachment: { id: archive.id, sha256: archive.sha256, mountPath: "/mnt/evidence" } });
    } finally { this.evidenceBusy = false; this.update({ acquiringEvidence: false }); }
  };

  captureEvidence = async (paths: string[], execute: EvidenceExecutor, options: EvidenceCaptureOptions = {}): Promise<EvidenceArchive> => {
    if (this.evidenceBusy || this.volumeTaskBusy || this.checkpointBusy || this.snapshot.operation || this.controls.size)
      throw new Error("Wait for the current evidence, disk or checkpoint operation to finish.");
    if (!this.worker || this.snapshot.status !== "running" || !this.snapshot.controlReady)
      throw new Error("Explicitly resume the quarantined clone and wait for its command channel before acquiring files.");
    if (!this.networkPort?.getSnapshot().quarantined)
      throw new Error("Acquire evidence from a host-quarantined investigation clone.");
    if (this.evidenceArchive) throw new Error("The analyst's attached evidence is already a logical capture.");
    if (options.checkpointSha256 && options.checkpointSha256 !== this.snapshot.sourceCheckpointSha256)
      throw new Error("This machine is no longer restored from the selected source checkpoint.");
    const generation = this.generation;
    this.evidenceBusy = true; this.update({ acquiringEvidence: true });
    const assertCurrent = () => {
      if (generation !== this.generation || !this.worker || this.snapshot.status !== "running")
        throw new Error("The investigation machine changed during acquisition.");
    };
    try {
      const files = await captureQemuEvidenceFiles(paths, execute, assertCurrent);
      assertCurrent();
      return await createEvidenceArchive(options.title ?? "Logical file capture", files, {
        method: "guest-assisted-logical", guestExecuted: true,
        ...(options.machineId ? { machineId: options.machineId } : {}),
        ...(options.machineName ? { machineName: options.machineName } : {}),
        ...(this.snapshot.sourceCheckpointSha256 ? { checkpointSha256: this.snapshot.sourceCheckpointSha256 } : {}),
      });
    } finally { this.evidenceBusy = false; this.update({ acquiringEvidence: false }); }
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
    this.outputListeners[port].add(listener);
    if (this.transcripts[port]) {
      try {
        listener(this.transcripts[port]);
      } catch {
        /* A view can detach independently. */
      }
    }
    return () => {
      this.outputListeners[port].delete(listener);
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
    if (!Number.isInteger(port) || port < 0 || port > 3)
      throw new Error("Choose x86_64 serial port 0, 1, 2 or 3.");
  }

  private update(patch: Partial<RuntimeSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch,
      runtimeBundle: Object.freeze({ defaultBootBundleId: this.defaultBootBundleId, activeBundleId: this.activeBundleId }),
      machineConfiguration: this.actualMachine,
    });
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot);
      } catch {
        /* Keep machine state independent of views. */
      }
    }
  }

  private receiveOutput(data: string, port: SerialPort = 0): void {
    this.transcripts[port] = (this.transcripts[port] + data).slice(-TRANSCRIPT_LIMIT);
    if (port === 0) {
      // ttyS0 has no interactive xterm owner. BusyBox can request its cursor
      // position after any prompt, and the four-byte query can cross events.
      // Reply before releasing a completed frame, so the next command cannot
      // overtake the terminal response. Paused/passive restores send no input.
      const terminal = this.controlQueryTail + data;
      const query = /\x1b\[6n/g;
      let replies = 0;
      while (replies < 16 && query.exec(terminal)) replies++;
      this.controlQueryTail = terminal.slice(-3);
      if (replies && this.controlQueriesEnabled && this.worker)
        this.worker.postMessage({ type: "input", port: 0, text: "\x1b[1;1R".repeat(replies) });
    }
    if (port !== 0) {
      this.sessionTails[port] = (this.sessionTails[port] + data).slice(-2_048);
      if (isSessionPrompt(this.sessionTails[port], port)
        && this.snapshot.sessions?.some((session) => session.port === port && session.status !== "ready"))
        this.update({ sessions: this.snapshot.sessions.map((session) => session.port === port ? { ...session, status: "ready" } : session) });
    }
    if (port === 0 && this.ready && !this.restoringCheckpoint) {
      this.promptTail = (this.promptTail + data).slice(-4_096);
      const plain = this.promptTail
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\r/g, "");
      if (!this.loginSent && /(?:^|\n)[^\n]{0,80}login: $/.test(plain)) {
        this.loginSent = true;
        this.worker?.postMessage({ type: "input", text: "root\n" });
      }
      if (/(?:^|\n)[^\n]{0,80}# ?$/.test(plain)) {
        const pending = this.ready;
        this.ready = null;
        pending.resolve();
      }
    }
    if (port === 0 && this.startup) {
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
    for (const listener of this.outputListeners[port]) {
      try {
        listener(data);
      } catch {
        /* A failed terminal does not halt emulation. */
      }
    }
  }

  private discardBootInputs(inputs = this.pendingBootInputs): void {
    if (!inputs) return;
    inputs.buffers = null;
    inputs.customImage = undefined;
    if (this.pendingBootInputs === inputs) this.pendingBootInputs = null;
  }

  private stopWorker(reason: Error, preserveResourceLease = false): void {
    this.controlQueriesEnabled = false;
    this.controlQueryTail = "";
    this.downloadController?.abort();
    this.downloadController = null;
    // A pending network attachment must not retain prepared payloads after
    // cancellation. Its late callback keeps only this emptied owner object.
    this.discardBootInputs();
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
    const worker = this.worker;
    this.worker = null;
    this.activeBundleId = null;
    this.activeMachine = null;
    let termination: Promise<void>;
    try {
      // Promise.resolve also accepts the browser's void result. Clearing the
      // active reference first fences callbacks even when termination throws.
      termination = Promise.resolve(worker?.terminate()).then(() => undefined);
    } catch (error) {
      termination = Promise.reject(error);
    }
    termination = termination.catch((error: unknown) => {
      this.workerTerminationFailure ??= errorOf(error);
      throw error;
    });
    // Never short-circuit disk settlement because native termination failed,
    // nor release native ownership because disk settlement finished first.
    const storage = this.storageDrain ?? this.volumes.close().catch((error: unknown) => {
      this.storageFailure ??= errorOf(error);
      throw error;
    });
    const lease = this.resourceLease;
    const inputs = this.inputSettlement ?? Promise.resolve();
    const drained = Promise.allSettled([storage, termination, inputs]).then((results) => {
      if (this.workerTerminationFailure) throw this.workerTerminationFailure;
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }).finally(() => {
      if (!preserveResourceLease && lease && !this.workerTerminationFailure) {
        lease.release();
        if (this.resourceLease === lease) this.resourceLease = null;
      }
      // Clear admission and its guard in the same reaction. A rejected native
      // termination retains its lease and latched failure for the page lifetime.
      if (this.storageDrain === drained) this.storageDrain = null;
    });
    this.storageDrain = drained;
    void drained.catch(() => undefined);
    try {
      this.networkPort?.setReady(false);
      this.networkPort?.detach();
    } catch {
      /* The owner may already have disposed this machine's network port. */
    }
    this.carrier = false;
  }

  boot = (): Promise<void> => {
    if (this.destroyPromise) return Promise.reject(new Error("Wait for the x86_64 machine to finish stopping."));
    if (this.workerTerminationFailure) return Promise.reject(new Error("The previous x86_64 worker termination was not confirmed. Its resource reservation is retained; reload this workspace before starting another execution. " + this.workerTerminationFailure.message));
    if (this.storageFailure) return Promise.reject(new Error("A prior data-disk operation failed. Stop this machine to review and finish its teardown before booting again. " + this.storageFailure.message));
    if (this.checkpointBusy || this.evidenceBusy) return Promise.reject(new Error("Wait for the current checkpoint or evidence operation to finish."));
    if (this.storageDrain || this.volumeTaskBusy) return Promise.reject(new Error("Wait for the current data-disk operation to finish."));
    if (this.bootPromise) return this.bootPromise;
    if (this.snapshot.status === "running") return Promise.resolve();
    if (this.snapshot.status === "paused") return this.resume();
    const generation = ++this.generation;
    this.stopWorker(new Error("Starting a fresh machine."));
    this.transcripts.fill("");
    this.sessionTails.fill("");
    this.promptTail = "";
    this.loginSent = false;
    this.bootFailure = null;
    this.restoringCheckpoint = false;
    this.restoredNeedsSetup = false;
    for (const port of this.capabilities.serialPorts) this.receiveOutput("\x1bc", port);
    const script = this.initScript;
    this.update({
      status: "loading",
      operation: null,
      message: `Downloading and verifying ${this.guestLabel}…`,
      downloadProgress: 0,
      startedAt: null,
      controlReady: false,
      guestCapabilities: undefined,
      guestCapabilityError: undefined,
      resourceObservation: undefined,
      passiveRestore: false,
      sourceCheckpointSha256: undefined,
      displayEpoch: (this.snapshot.displayEpoch ?? 0) + 1,
      sessions: INTERACTIVE_SERIAL_PORTS.map((port) => ({ port, title: `Shell ${port}`, status: "starting" })),
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
        const failure = this.bootFailure ?? errorOf(error);
        if (this.generation === generation) {
          this.stopWorker(failure);
          this.update({
            status: "error",
            message: failure.message,
            downloadProgress: null,
            controlReady: false,
            resourceObservation: undefined,
            sessions: INTERACTIVE_SERIAL_PORTS.map((port) => ({ port, title: `Shell ${port}`, status: "unavailable" })),
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

  private async start(generation: number, script: string, checkpoint?: QemuCheckpoint): Promise<void> {
    const bundle = getQemuBundle(checkpoint?.manifest.runtimeVersion ?? this.defaultBootBundleId);
    const machine = checkpoint ? checkpoint.manifest.machine ?? defaultX86MachineConfiguration({ runtimeBundleId: bundle.id, mac: checkpoint.manifest.mac }) : this.configuredMachine;
    const hardware = qemuPresetBootOptions(machine);
    if (typeof Worker === "undefined" || typeof WebAssembly === "undefined")
      throw new Error(
        "This browser needs Web Workers and WebAssembly to run x86_64.",
      );
    if (!globalThis.crypto?.subtle)
      throw new Error("Image verification requires HTTPS or localhost.");
    const support = getSharedMemorySupport();
    if (!support.ready) throw new Error(support.message + " Open Workspace & storage to enable the x86_64 runtime and reload safely.");
    this.resourceLease ??= this.resourceBudget.acquire(bundle.resources.reservedWasmMiB);
    this.activeMachine = machine; this.mac = machine.nic.mac;
    this.refreshCapabilities();
    this.activeBundleId = bundle.id;
    this.update({});
    const controller = new AbortController();
    this.downloadController = controller;
    this.bootTimer = setTimeout(() => {
      const error = new Error(
        "x86_64 boot timed out after 4 minutes. Check asset connectivity and available browser CPU/memory, then retry.",
      );
      this.bootFailure = error;
      controller.abort(error);
      this.failWorker(error, generation);
    }, BOOT_TIMEOUT_MS);
    const definitions = Object.fromEntries(Object.entries(bundle.assets).filter(([name]) => machine.image.kind !== "custom" || ["module", "wasm", "rom"].includes(name)));
    const received = new Map<string, number>();
    const total = Object.values(definitions).reduce(
      (sum, value) => sum + value.bytes,
      0,
    );
    let inputsSettled!: () => void;
    const inputSettlement = new Promise<void>((resolve) => { inputsSettled = resolve; });
    this.inputSettlement = inputSettlement;
    let pairs: (readonly [string, ArrayBuffer])[] = [];
    let customImage: RawMachineImage | undefined;
    try {
      let assetFailure: Error | null = null;
      const assets = await Promise.allSettled(Object.entries(definitions).map(async ([key, asset]) => {
        try {
          const bytes = await this.loadVerifiedAsset(asset, controller.signal, (amount) => {
            received.set(key, amount);
            if (this.generation === generation)
              this.update({ downloadProgress: Math.round([...received.values()].reduce((sum, n) => sum + n, 0) / total * 100) });
          });
          return [key, bytes] as const;
        } catch (error) {
          // Abort siblings promptly but wait for their actual settlement. A
          // fail-fast Promise.all alone could leave a hash/read still owning
          // buffers after the failed boot returned its reservation.
          assetFailure ??= errorOf(error);
          controller.abort(assetFailure);
          throw error;
        }
      }));
      if (assetFailure) throw assetFailure;
      pairs = assets.map((asset) => {
        if (asset.status === "rejected") throw asset.reason;
        return asset.value;
      });
      controller.signal.throwIfAborted();
      if (machine.image.kind === "custom") {
        const image = await readMachineImage(machine.image.id, { signal: controller.signal });
        if (image.manifest.boot.hostname !== (machine.kernelSettings.hostname ?? "terrarium"))
          throw new Error("The imported image hostname differs from the saved boot configuration. Select the verified image again before booting.");
        const components = {} as Record<"kernel" | "initramfs" | "rootfs", Uint8Array<ArrayBuffer>>;
        for (const name of ["kernel", "initramfs", "rootfs"] as const) {
          controller.signal.throwIfAborted();
          components[name] = new Uint8Array(await image.components[name].arrayBuffer());
        }
        controller.signal.throwIfAborted();
        customImage = { id: image.id, manifest: image.manifest, ...components };
        this.verifiedImageIdentity = { id: image.id, guest: image.manifest.guest };
        this.refreshCapabilities();
      }
    } finally {
      // Settlement is ownership information, not a successful boot or a disk
      // error. Do not wait for the entire start(), which later awaits teardown.
      inputsSettled();
      if (this.inputSettlement === inputSettlement) this.inputSettlement = null;
    }
    if (this.bootFailure) throw this.bootFailure;
    if (this.generation !== generation)
      throw new Error("Machine boot was cancelled.");
    this.downloadController = null;
    const pendingInputs: PendingBootInputs = { buffers: Object.fromEntries(pairs), customImage };
    pairs = []; customImage = undefined;
    this.pendingBootInputs = pendingInputs;
    if (this.storageDrain) await this.storageDrain;
    if (this.generation !== generation || controller.signal.aborted)
      throw new Error("Machine boot was cancelled.");
    const disks = await this.volumes.open();
    if (this.generation !== generation) {
      await this.volumes.close();
      throw new Error("Machine boot was cancelled.");
    }
    const worker = new Worker(assetUrl("worker.js"), {
      type: "module",
      name: "terrarium-x86_64",
    });
    this.worker = worker;
    const ready = new Promise<void>((resolve, reject) => {
      this.ready = { resolve, reject };
    });
    worker.onmessage = ({ data }) => {
      if (generation !== this.generation || worker !== this.worker) return;
      if (data.type === "output" && typeof data.data === "string") {
        const port = data.port ?? 0;
        if (Number.isInteger(port) && port >= 0 && port <= 3)
          this.receiveOutput(data.data, port as SerialPort);
      }
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
      } else if (data.type === "resource-observation") {
        const bytes = data.wasmMemoryBytes;
        if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes % 65_536 !== 0
          || bytes > bundle.resources.reservedWasmMiB * 1024 * 1024) {
          this.failWorker(new Error("The emulator reported memory outside its admitted x86_64 reservation."), generation);
          return;
        }
        this.update({ resourceObservation: Object.freeze({
          source: "emulator-memory-buffer", sampledAt: Date.now(), observedWasmMemoryBytes: bytes,
          configuredGuestMemoryMiB: hardware.memoryMiB,
          configuredTranslationCacheMiB: bundle.resources.translationCacheMiB,
          accountedWasmReservationMiB: bundle.resources.reservedWasmMiB,
          budgetId: this.resourceBudget.limits.id,
        }) });
      } else if (data.type === "initialized" && checkpoint && this.ready) {
        const pending = this.ready;
        this.ready = null;
        pending.resolve();
      } else if (data.type === "disk-request") {
        void this.volumes.handleRequest(data).catch((error: unknown) => {
          if (generation === this.generation && worker === this.worker)
            this.failWorker(errorOf(error), generation);
        });
      } else if (data.type === "ack") {
        const pending = this.controls.get(data.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.controls.delete(data.id);
          if (pending.type === "save-checkpoint" && (!(data.buffer instanceof ArrayBuffer) || data.buffer.byteLength > MAX_QEMU_CHECKPOINT_PAYLOAD_BYTES)) {
            const error = new Error("The emulator returned an invalid checkpoint payload.");
            pending.reject(error); this.failWorker(error, generation);
          } else if (pending.type === "inspect-registers" && (typeof data.registers !== "string" || data.registers.length > 8192 || /[^\x09\x0a\x0d\x20-\x7e]/.test(data.registers))) {
            const error = new Error("The emulator returned invalid register observations.");
            pending.reject(error); this.failWorker(error, generation);
          } else if (pending.type === "inspect-resources") {
            try { pending.resolve({ resources: resourceReply(data.resources, bundle) }); }
            catch (failure) {
              const error = errorOf(failure);
              pending.reject(error); this.failWorker(error, generation);
            }
          } else pending.resolve({ buffer: data.buffer, registers: data.registers });
        }
      } else if (data.type === "control-error") {
        const pending = this.controls.get(data.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.controls.delete(data.id);
          if (pending.type === "save-checkpoint" && data.code === "checkpoint_rejected" && typeof data.message === "string" && data.message.length <= 4096)
            pending.reject(new Error("The checkpoint could not be saved: " + data.message));
          else {
            const error = new Error("The x86_64 worker returned an invalid control rejection.");
            pending.reject(error); this.failWorker(error, generation);
          }
        }
      } else if (data.type === "error")
        this.failWorker(new Error(String(data.message)), generation);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.failWorker(
        new Error(event.message || "The x86_64 worker failed to load."),
        generation,
      );
    };
    // Observe worker errors before attaching the network, which can be async.
    // Race neither operation on its own: a boot timeout also rejects ready.
    const attached = (async () => {
      try {
        await this.networkPort?.attachEthernet(this);
        if (generation !== this.generation || worker !== this.worker)
          throw this.bootFailure ?? new Error("Machine boot was cancelled.");
        this.networkPort?.setReady(false);
        this.update({
          status: "booting",
          message: `Preparing ${this.guestDescription} · x86_64…`,
          downloadProgress: 100,
          startedAt: Date.now(),
        });
        const evidenceImage = this.evidenceImage?.slice(0);
        this.requireCurrentWorker(generation, worker);
        const buffers = pendingInputs.buffers, image = pendingInputs.customImage;
        if (!buffers) throw new Error("Machine boot input ownership was cancelled.");
        this.controlQueriesEnabled = !checkpoint;
        worker.postMessage(
          {
            type: "boot",
            ...buffers,
            runtimeBundleId: bundle.id,
            profileId: this.profileId,
            memoryMiB: hardware.memoryMiB,
            machine,
            mac: this.mac,
            network: !!this.networkPort,
            disks,
            ...(image ? { customImage: image } : {}),
            ...(evidenceImage ? { evidenceImage } : {}),
            ...(checkpoint ? { checkpoint: checkpoint.payload } : {}),
          },
          [...Object.values(buffers), ...(image ? [image.kernel.buffer, image.initramfs.buffer, image.rootfs.buffer] : []), ...(evidenceImage ? [evidenceImage] : []), ...(checkpoint ? [checkpoint.payload] : [])],
        );
      } finally { this.discardBootInputs(pendingInputs); }
    })();
    await Promise.all([ready, attached]);
    this.requireCurrentWorker(generation, worker);
    if (checkpoint) {
      if (this.bootTimer !== null) clearTimeout(this.bootTimer);
      this.bootTimer = null;
      this.restoringCheckpoint = false;
      this.restoredNeedsSetup = true;
      const sourceCheckpointSha256 = await sha256Bytes(checkpoint.buffer);
      this.requireCurrentWorker(generation, worker);
      this.update({
        status: "paused", downloadProgress: null, controlReady: false,
        message: "Checkpoint loaded with the CPU stopped. No guest setup or init script has run.",
        passiveRestore: true,
        sourceCheckpointSha256,
        init: { status: "skipped", output: "", exitCode: null, message: "Checkpoint restore preserves guest state and does not rerun init." },
        sessions: INTERACTIVE_SERIAL_PORTS.map((port) => ({ port, title: `Shell ${port}`, status: "ready" })),
      });
      return;
    }
    // Establish the control TTY before the first command frame saves its
    // settings. Configuring flow control only inside that frame is undone by
    // the wrapper's final stty restore, which can stall the next command.
    // The pinned upstream demonstration profile also used its own HTTP proxy.
    // ttyS0 is the framed control channel; only ports 1-3 are interactive.
    // Keep its baseline canonical/no-echo so each frame's exact restoration
    // cannot re-enter BusyBox editing. Delayed initial cursor queries must not
    // append response bytes behind the already queued bootstrap payload.
    this.controlQueriesEnabled = false;
    worker.postMessage({ type: "input", text: "stty -F /dev/ttyS0 sane -ixon -ixoff -echo rows 30 cols 100; unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY SSL_CERT_FILE; export TERM=dumb\n" });
    const networkScript = this.networkPort?.guestSetupCommand() ?? "";
    const helper = this.networkPort
      ? `printf '%s' ${shellQuote(webgetScript(this.networkPort.getSnapshot().gateway))} > /usr/bin/webget\nchmod 755 /usr/bin/webget`
      : ":";
    // The owned built-in boot service sets its historical hostname after the
    // kernel command line. Apply an explicitly validated setting before user init.
    // Custom images retain their independently checked image hostname; a cold
    // checkpoint restore never enters this fresh-boot setup path.
    const hostnameSetup = machine.image.kind === "builtin" && machine.kernelSettings.hostname
      ? `hostname ${shellQuote(machine.kernelSettings.hostname)}` : ":";
    const setup = await this.runStartupCommand(
      `set -e\n${CONTROL_CONSOLE_POLICY}\n${hostnameSetup}\nexport TERM=xterm-256color\nstty -F /dev/ttyS0 sane -ixon -ixoff rows 30 cols 100\nmkdir -p /sys\nmountpoint -q /sys || mount -t sysfs sysfs /sys\n${networkScript || ":"}\n${helper}\n${sessionBootstrapCommand({ configureFourthUart: false })}`,
      generation, worker,
    );
    if (setup.exitCode !== 0)
      throw new Error(
        `Guest console/network initialization failed (exit ${setup.exitCode}).`,
      );
    await this.waitForSessions(generation, worker);
    this.requireCurrentWorker(generation, worker);
    for (const disk of disks) {
      const device = `/dev/terrarium-volume${disk.slot}`;
      const mount = `/mnt/volumes/disk${disk.slot}`;
      const serial = `terrarium-volume${disk.slot}`;
      const result = await this.runStartupCommand([
        "set -e",
        "modprobe ext2 2>/dev/null || true",
        "rm -f " + shellQuote(device),
        "_trm_found=0",
        "for _trm_disk in /sys/class/block/vd*; do",
        `  [ -f "$_trm_disk/serial" ] && [ "$(cat "$_trm_disk/serial")" = ${shellQuote(serial)} ] || continue`,
        '  _trm_numbers=$(cat "$_trm_disk/dev")',
        `  mknod ${shellQuote(device)} b "\${_trm_numbers%:*}" "\${_trm_numbers#*:}"`,
        "  _trm_found=1; break",
        "done",
        `[ "$_trm_found" = 1 ] || { echo ${shellQuote(`The Linux VirtIO block driver did not expose the attached disk serial ${serial}. Discovered block devices:`)}; ls /sys/class/block 2>/dev/null || true; for _trm_seen in /sys/class/block/vd*; do [ -f "$_trm_seen/serial" ] && { printf '%s: ' "$_trm_seen"; cat "$_trm_seen/serial"; }; done; exit 1; }`,
        "mkdir -p " + shellQuote(mount),
        `mount -t ext2 -o ${disk.readOnly ? "ro,nodev,nosuid,noexec" : "rw,sync,nodev,nosuid"} ${shellQuote(device)} ${shellQuote(mount)}`,
      ].join("\n"), generation, worker);
      if (result.exitCode !== 0) throw new Error(`Could not mount data disk ${disk.slot}: ${result.output.slice(-600)}`);
      this.volumes.markMounted(disk.slot);
    }
    if (this.evidenceArchive) {
      const mounted = await this.runStartupCommand([
        "set -e", "modprobe ext2 2>/dev/null || true", "rm -f /dev/terrarium-evidence", "_trm_found=0",
        "for _trm_disk in /sys/class/block/vd*; do",
        '  [ -f "$_trm_disk/serial" ] && [ "$(cat "$_trm_disk/serial")" = terrarium-evidence ] || continue',
        '  _trm_numbers=$(cat "$_trm_disk/dev")',
        '  mknod /dev/terrarium-evidence b "${_trm_numbers%:*}" "${_trm_numbers#*:}"',
        "  _trm_found=1; break", "done",
        '[ "$_trm_found" = 1 ] || { echo "The evidence block device serial terrarium-evidence was not discovered. Discovered block devices:"; ls /sys/class/block 2>/dev/null || true; for _trm_seen in /sys/class/block/vd*; do [ -f "$_trm_seen/serial" ] && { printf \'%s: \' "$_trm_seen"; cat "$_trm_seen/serial"; }; done; exit 1; }',
        "mkdir -p /mnt/evidence",
        "mount -t ext2 -o ro,nodev,nosuid,noexec /dev/terrarium-evidence /mnt/evidence",
      ].join("\n"), generation, worker);
      if (mounted.exitCode !== 0) throw new Error("Could not mount the read-only evidence view: " + mounted.output.slice(-600));
    }
    this.requireCurrentWorker(generation, worker);
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
      const result = await this.runStartupCommand(script, generation, worker);
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
    // Observe the state left by init, which may mount cgroups or install tools.
    // Do not present pre-init facts as the completed machine's prerequisites.
    const probeToken = crypto.randomUUID().replace(/-/g, "");
    const measured = await this.runStartupCommand(buildGuestCapabilityProbe(probeToken), generation, worker);
    try {
      if (measured.exitCode !== 0) throw new Error(`Guest capability probe exited ${measured.exitCode}.`);
      this.update({ guestCapabilities: parseGuestCapabilityReport(measured.output, probeToken), guestCapabilityError: undefined });
    } catch (error) {
      this.update({ guestCapabilityError: errorOf(error).message });
    }
    this.requireCurrentWorker(generation, worker);
    if (this.bootTimer !== null) clearTimeout(this.bootTimer);
    this.bootTimer = null;
    this.update({
      status: "running",
      message: `${this.guestLabel} · x86_64 · ${this.hardware.memoryMiB} MiB`,
      downloadProgress: null,
      controlReady: true,
      sessions: INTERACTIVE_SERIAL_PORTS.map((port) => ({ port, title: `Shell ${port}`, status: "ready" })),
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
      resourceObservation: undefined,
      sessions: INTERACTIVE_SERIAL_PORTS.map((port) => ({ port, title: `Shell ${port}`, status: "unavailable" })),
    });
  }

  private requireCurrentWorker(generation: number, worker: Worker | null): asserts worker is Worker {
    if (generation !== this.generation || !worker || worker !== this.worker || this.destroyPromise || this.snapshot.status === "error")
      throw new Error("Machine startup was cancelled or its worker changed.");
  }

  private waitForSessions(generation: number, worker: Worker): Promise<void> {
    this.requireCurrentWorker(generation, worker);
    if (this.snapshot.sessions?.every((session) => session.status === "ready")) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe = () => {};
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error("The independent x86_64 shells did not become ready. Reset the machine to recover.")), 15_000);
      unsubscribe = this.subscribe((state) => {
        if (this.generation !== generation || state.status === "error" || state.status === "idle")
          finish(new Error("Machine startup was cancelled before the terminal sessions were ready."));
        else if (state.sessions?.every((session) => session.status === "ready")) finish();
      });
      if (settled) unsubscribe();
      else for (const port of INTERACTIVE_SERIAL_PORTS) this.worker?.postMessage({ type: "input", port, text: "\n" });
    });
  }

  private async runStartupCommand(
    command: string, generation: number, worker: Worker | null,
  ): Promise<{ output: string; exitCode: number }> {
    this.requireCurrentWorker(generation, worker);
    if (this.startup) throw new Error("Wait for the current guest setup command.");
    const token = crypto.randomUUID().replace(/-/g, "");
    const frame = commandFrame(command, token);
    const result = await new Promise<{ output: string; exitCode: number }>((resolve, reject) => {
      let pending: StartupCommand;
      const timer = setTimeout(() => {
        if (this.startup !== pending) return;
        this.startup = null;
        reject(
          new Error(
            "A guest setup or init command did not finish within 60 seconds. Reset the machine to recover.",
          ),
        );
      }, STARTUP_TIMEOUT_MS);
      pending = {
        reader: new CommandFrameReader(token),
        resolve,
        reject,
        timer,
      };
      this.startup = pending;
      worker.postMessage({ type: "input", text: frame });
    });
    this.requireCurrentWorker(generation, worker);
    return result;
  }

  send = (text: string, port: SerialPort = 0): void => {
    this.requirePort(port);
    if (
      !this.worker ||
      this.snapshot.status !== "running" ||
      this.controls.size ||
      this.snapshot.operation ||
      ((this.volumeTaskBusy || this.evidenceBusy) && port !== 0)
    )
      return;
    if (
      typeof text !== "string" ||
      new TextEncoder().encode(text).length > 32_768
    )
      throw new Error("Console input is limited to 32 KiB per send.");
    this.worker.postMessage({ type: "input", text, port });
  };

  private control(type: ControlType): Promise<ControlReply> {
    if (!this.worker)
      return Promise.reject(new Error("Boot this machine first."));
    if (this.controls.size)
      return Promise.reject(
        new Error("Wait for the current machine control operation."),
      );
    const worker = this.worker;
    if (type === "pause" || type === "destroy") this.controlQueriesEnabled = false;
    else if (type === "resume") this.controlQueriesEnabled = true;
    const id = this.nextControlId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(id);
        const error = new Error(
          "The x86_64 worker did not acknowledge the control request. Reset the machine.",
        );
        reject(error);
        this.failWorker(error, this.generation);
      }, type === "save-checkpoint" ? 120_000 : 20_000);
      this.controls.set(id, { type, resolve, reject, timer });
      worker.postMessage({ type, id });
    });
  }

  pause = async (): Promise<void> => {
    if (this.volumeTaskBusy || this.evidenceBusy || this.checkpointBusy || this.snapshot.operation)
      throw new Error("Wait for the current disk or checkpoint operation to finish.");
    if (this.controls.size)
      throw new Error("Wait for the current machine control operation.");
    if (this.snapshot.status === "paused") return;
    if (this.snapshot.status !== "running")
      throw new Error("Boot the machine before pausing it.");
    const generation = this.generation;
    this.networkPort?.setReady(false);
    this.update({
      message: "Pausing the x86_64 CPU…",
      controlReady: false,
    });
    await this.control("pause");
    if (generation === this.generation)
      this.update({ status: "paused", message: "QEMU confirms that x86_64 guest execution is paused." });
  };

  /** A one-shot paused sample. No live sample is retained after guest execution changes. */
  inspectResources = async (): Promise<QemuPausedResourceInspection> => {
    if (this.bootPromise || this.destroyPromise || this.storageDrain || this.volumeTaskBusy || this.evidenceBusy
      || this.checkpointBusy || this.snapshot.operation || this.controls.size)
      throw new Error("Wait for the current machine operation before observing translation resources.");
    if (!this.worker || this.snapshot.status !== "paused" || !this.activeBundleId)
      throw new Error("Pause the machine before observing translation resources.");
    const generation = this.generation, worker = this.worker, bundle = this.bundle;
    const observed = await this.control("inspect-resources");
    this.requireCurrentWorker(generation, worker);
    if (this.snapshot.status !== "paused" || this.controls.size || this.snapshot.operation || !observed.resources)
      throw new Error("Translation-resource inspection was cancelled by a machine operation.");
    return Object.freeze({ ...observed.resources, source: "qemu-hmp-info-jit", runtimeBundleId: bundle.id,
      sampledAt: Date.now(), cpuState: "paused", configuredTranslationCacheMiB: bundle.resources.translationCacheMiB,
      excludedMemory: "engine-native-compiled-wasm-and-process-overhead" });
  };

  resume = async (): Promise<void> => {
    if (this.volumeTaskBusy || this.evidenceBusy || this.checkpointBusy || this.snapshot.operation)
      throw new Error("Wait for the current disk or checkpoint operation to finish.");
    if (this.controls.size)
      throw new Error("Wait for the current machine control operation.");
    if (this.snapshot.status === "running") return;
    if (this.snapshot.status !== "paused")
      throw new Error("Pause the machine before resuming it.");
    await this.resumeExecution();
  };

  private async resumeExecution(): Promise<void> {
    const generation = this.generation;
    const worker = this.worker;
    this.requireCurrentWorker(generation, worker);
    try {
      await this.control("resume");
      if (generation !== this.generation) throw new Error("Machine resume was cancelled.");
      if (this.restoredNeedsSetup) {
        const network = this.networkPort?.guestSetupCommand() ?? ":";
        const helper = this.networkPort
          ? `printf '%s' ${shellQuote(webgetScript(this.networkPort.getSnapshot().gateway))} > /usr/bin/webget\nchmod 755 /usr/bin/webget`
          : ":";
        const setup = await this.runStartupCommand(`set -e\n${CONTROL_CONSOLE_POLICY}\n${network}\n${helper}`, generation, worker);
        if (setup.exitCode !== 0) throw new Error("The restored machine's network setup failed: " + setup.output.slice(-600));
        const token = crypto.randomUUID().replace(/-/g, "");
        const measured = await this.runStartupCommand(buildGuestCapabilityProbe(token), generation, worker);
        try {
          if (measured.exitCode !== 0) throw new Error(`Guest capability probe exited ${measured.exitCode}.`);
          this.update({ guestCapabilities: parseGuestCapabilityReport(measured.output, token), guestCapabilityError: undefined });
        } catch (error) { this.update({ guestCapabilityError: errorOf(error).message }); }
        this.restoredNeedsSetup = false;
      }
      if (generation !== this.generation) throw new Error("Machine resume was cancelled.");
      this.update({
        status: "running", passiveRestore: false,
        message: `${this.guestLabel} · x86_64 · ${this.hardware.memoryMiB} MiB`,
        controlReady: true,
      });
      this.networkPort?.setReady(true);
    } catch (error) {
      this.failWorker(errorOf(error), generation);
      throw error;
    }
  }

  reset = async (): Promise<void> => {
    if (this.checkpointBusy || this.evidenceBusy || this.volumeTaskBusy)
      throw new Error("Wait for the current disk, evidence or checkpoint operation before resetting.");
    const writable = this.volumes.getStates().some((state) => !state.readOnly);
    if (writable && this.snapshot.status === "paused")
      throw new Error("Resume writable data disks before resetting so their filesystems can be synced and unmounted.");
    if (writable && this.snapshot.status === "running") {
      const generation = this.generation, worker = this.worker;
      await this.prepareVolumeShutdown(async (command) => {
        const startedAt = Date.now();
        const result = await this.runStartupCommand(command, generation, worker);
        return {
          id: crypto.randomUUID(), command, ...result, status: "exited", startedAt,
          durationMs: Date.now() - startedAt, recovery: "not_needed",
        };
      });
    }
    await this.destroy();
    await this.boot();
  };
  save = async (): Promise<ArrayBuffer> => {
    if (!this.capabilities.snapshots)
      throw new Error("RAM checkpoints require a qualified small preset with a built-in image and no external data disks or evidence. Larger/custom machines use persistent mounts.");
    if (!this.worker || !["running", "paused"].includes(this.snapshot.status) || this.bootPromise)
      throw new Error("Boot the x86_64 machine and wait for its command channel before saving.");
    const runtimeBundleId = this.activeBundleId;
    if (!runtimeBundleId) throw new Error("The active x86_64 runtime identity is unavailable. No checkpoint was saved.");
    if (this.checkpointBusy || this.evidenceBusy || this.volumeTaskBusy || this.controls.size || this.snapshot.operation)
      throw new Error("Wait for the current machine operation before saving a checkpoint.");
    const wasRunning = this.snapshot.status === "running";
    const priorMessage = this.snapshot.message;
    if (wasRunning && !this.snapshot.controlReady) throw new Error("Wait for the command channel before saving a checkpoint.");
    this.checkpointBusy = true;
    this.update({ operation: "saving", controlReady: false, message: "Saving x86_64 CPU, devices and guest RAM…" });
    this.networkPort?.setReady(false);
    try {
      if (wasRunning) await this.control("pause");
      const observed = await this.control("inspect-registers");
      const saved = await this.control("save-checkpoint");
      if (!saved.buffer) throw new Error("The emulator returned no checkpoint bytes.");
      return await createQemuCheckpoint(saved.buffer, { runtimeBundleId, mac: this.mac, machine: this.actualMachine, registers: observed.registers ?? null });
    } finally {
      try {
        if (wasRunning && this.worker && this.snapshot.status === "running") {
          await this.control("resume");
          this.update({ controlReady: true, message: `${this.guestLabel} · x86_64 · ${this.hardware.memoryMiB} MiB` });
          this.networkPort?.setReady(true);
        }
      } finally {
        this.checkpointBusy = false;
        this.update({ operation: null, ...(this.snapshot.status === "paused" ? { message: priorMessage } : {}) });
      }
    }
  };

  restore = async (buffer: ArrayBuffer, options: RestoreOptions = {}): Promise<void> => {
    if (!qemuPresetBootOptions(this.configuredMachine).checkpointSupported)
      throw new Error("This configured preset/image has no qualified RAM restore path. Keep or export the checkpoint, or inspect it through a compatible small quarantine machine.");
    if (this.workerTerminationFailure)
      throw new Error("The previous x86_64 worker termination was not confirmed. Its resource reservation is retained; reload this workspace before restoring execution. " + this.workerTerminationFailure.message);
    if (this.volumes.getAttachments().length || this.evidenceArchive)
      throw new Error("Restore a VM checkpoint into a machine without external data disks or evidence attachments.");
    if (this.bootPromise || this.destroyPromise || this.storageDrain || this.checkpointBusy || this.evidenceBusy || this.volumeTaskBusy || this.controls.size || this.snapshot.operation)
      throw new Error("Wait for the current machine operation before restoring a checkpoint.");
    this.checkpointBusy = true;
    this.update({ operation: "restoring" });
    let replacing = false;
    try {
      // Compatibility, bounds and hashes are checked before disturbing the live VM.
      const checkpoint = await parseQemuCheckpoint(buffer);
      // Preserve the existing reservation while replacing an active machine.
      // An idle restore must obtain capacity before changing machine state.
      this.resourceLease ??= this.resourceBudget.acquire(getQemuBundle(checkpoint.manifest.runtimeVersion).resources.reservedWasmMiB);
      replacing = true;
      if (this.worker) {
        try { await this.control("destroy"); } catch { /* The old worker is forcibly terminated below. */ }
      }
      const generation = ++this.generation;
      this.stopWorker(new Error("Replacing the machine with a checkpoint."), true);
      if (this.storageDrain) await this.storageDrain;
      this.mac = checkpoint.manifest.mac;
      this.bootFailure = null;
      this.restoringCheckpoint = true;
      this.restoredNeedsSetup = false;
      this.transcripts.fill(""); this.sessionTails.fill(""); this.promptTail = ""; this.loginSent = false;
      for (const port of this.capabilities.serialPorts) this.receiveOutput("\x1bc", port);
      this.update({
        status: "loading", operation: "restoring", downloadProgress: 0, startedAt: null,
        controlReady: false, passiveRestore: false, sourceCheckpointSha256: undefined,
        guestCapabilities: undefined, guestCapabilityError: undefined, resourceObservation: undefined,
        displayEpoch: (this.snapshot.displayEpoch ?? 0) + 1,
        message: "Verifying boot assets for the preserved x86_64 machine…",
        sessions: INTERACTIVE_SERIAL_PORTS.map((port) => ({ port, title: `Shell ${port}`, status: "starting" })),
        init: { status: "skipped", output: "", exitCode: null, message: "Checkpoint restore does not rerun init." },
      });
      await this.start(generation, "", checkpoint);
      if (!options.paused) await this.resumeExecution();
    } catch (error) {
      if (replacing) this.failWorker(errorOf(error), this.generation);
      throw error;
    } finally {
      this.restoringCheckpoint = false;
      this.checkpointBusy = false;
      this.update({ operation: null });
    }
  };

  destroy = (): Promise<void> => {
    if (this.destroyPromise) return this.destroyPromise;
    if (this.checkpointBusy || this.evidenceBusy)
      return Promise.reject(new Error("Wait for the current checkpoint or evidence operation to finish."));
    if (this.volumeTaskBusy && !this.volumeShutdownPrepared)
      return Promise.reject(new Error("Wait for the current data-disk operation to finish."));
    const task = Promise.resolve().then(async () => {
      if (this.worker && !this.controls.size && ["running", "paused"].includes(this.snapshot.status)) {
        // Let the owning worker explicitly terminate QEMU's pthreads first.
        // A failed acknowledgement still ends the dedicated worker below.
        try { await this.control("destroy"); } catch { /* Forced teardown below. */ }
      }
      ++this.generation;
      this.stopWorker(new Error("Machine was stopped."));
      this.bootPromise = null;
      if (this.storageDrain) await this.storageDrain;
      if (this.storageFailure) throw this.storageFailure;
      this.update({
        status: "idle",
        operation: null,
        message: "x86_64 machine stopped.",
        downloadProgress: null,
        startedAt: null,
        controlReady: false,
        guestCapabilities: undefined,
        guestCapabilityError: undefined,
        resourceObservation: undefined,
        passiveRestore: false,
        sourceCheckpointSha256: undefined,
        sessions: INTERACTIVE_SERIAL_PORTS.map((port) => ({ port, title: `Shell ${port}`, status: "starting" })),
      });
    }).catch((error: unknown) => {
      const failure = errorOf(error);
      if (this.workerTerminationFailure) {
        this.update({ status: "error", controlReady: false, downloadProgress: null, resourceObservation: undefined,
          message: "Machine worker teardown was not confirmed; its resource reservation remains held. Reload this workspace before starting another execution. " + this.workerTerminationFailure.message
            + (this.storageFailure ? " Disk teardown also failed: " + this.storageFailure.message : "") });
        throw failure;
      }
      // An explicit stop reports the failed commit. A later deliberate retry
      // can remove the stopped definition while the stored disk remains intact.
      this.storageFailure = null;
      this.update({ status: "error", controlReady: false, downloadProgress: null, resourceObservation: undefined,
        message: "Machine execution stopped, but disk teardown failed: " + failure.message });
      throw failure;
    }).finally(() => {
      if (this.destroyPromise === task) this.destroyPromise = null;
      this.volumeTaskBusy = false;
      this.volumeShutdownPrepared = false;
      this.restoringCheckpoint = false;
      this.restoredNeedsSetup = false;
      this.update({ operation: null, volumeOperation: null });
    });
    this.destroyPromise = task;
    this.volumeTaskBusy = true;
    this.update({ volumeOperation: "detaching", controlReady: false });
    return task;
  };
}
