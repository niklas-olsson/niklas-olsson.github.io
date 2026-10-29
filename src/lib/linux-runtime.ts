// SPDX-License-Identifier: Apache-2.0

import type { V86, V86Options } from "v86";
import {
  RUNTIME_MEMORY_MIB,
  type OutputListener,
  type RuntimeListener,
  type RuntimeSnapshot,
  type MachineRuntime,
  type RuntimeCapabilities,
  type SerialPort,
  type RestoreOptions,
  type EvidenceExecutor,
  type EvidenceCaptureOptions,
} from "./runtime-types.ts";
import { validateSnapshot } from "./snapshot-format.ts";
import { CommandRunner, type RunResult } from "./command-runner.ts";
import {
  INTERACTIVE_SERIAL_PORTS,
  isSessionPrompt,
  sessionBootstrapCommand,
  validateInitScript,
} from "./guest-startup.ts";
import type { NetworkPort } from "./network.ts";
import { shellQuote } from "./command-protocol.ts";
import {
  createEvidenceArchive,
  exportEvidenceArchive,
  importEvidenceArchive,
  sha256Bytes,
  validateEvidencePaths,
  MAX_EVIDENCE_FILE_BYTES,
  MAX_EVIDENCE_TOTAL_BYTES,
  type EvidenceArchive,
  type EvidenceInputFile,
} from "./evidence.ts";
import { ReadonlyEvidence9p } from "./evidence-9p.ts";
import { readBounded9pFile } from "./evidence-transfer.ts";
import { getVolume, openVolume, type VolumeSession } from "./volume-store.ts";
import { PersistentVirtioBlock } from "./volume-device.ts";
import { validateVolumeAttachments, type VolumeAttachment, type VolumeAttachmentState } from "./volume-types.ts";

type V86Constructor = new (options: V86Options) => V86;

declare global {
  interface Window {
    V86?: V86Constructor;
  }
}

const BOOT_TIMEOUT_MS = 120_000;
const TRANSCRIPT_LIMIT = 256 * 1024;
let libraryPromise: Promise<V86Constructor> | null = null;

interface GuestAsset {
  name: string;
  url: string;
  bytes: number;
  sha256: string;
}

// Fetch upstream guest binaries only on an explicit Boot action. Their source
// distribution is not included in this project, so we do not rehost the binaries.
const GUEST_ASSETS = {
  kernel: {
    name: "Linux image",
    url: "https://i.copy.sh/buildroot-bzimage68.bin",
    bytes: 10_068_480,
    sha256: "507a759c70ab7a490a233be454d0b5b88bc667956a410b531cb4edc091e2eb1c",
  },
  bios: {
    name: "SeaBIOS",
    url: "https://raw.githubusercontent.com/copy/v86/cc37f35c43bf14865d74ad76879ecf9410f69eb1/bios/seabios.bin",
    bytes: 131_072,
    sha256: "73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98",
  },
  vgaBios: {
    name: "VGA BIOS",
    url: "https://raw.githubusercontent.com/copy/v86/cc37f35c43bf14865d74ad76879ecf9410f69eb1/bios/vgabios.bin",
    bytes: 36_352,
    sha256: "a4bc0d80cc3ca028c73dafa8fee396b8d054ce87ebd8abfbd31b06b437607880",
  },
} satisfies Record<string, GuestAsset>;

async function fetchVerifiedAsset(
  asset: GuestAsset,
  signal: AbortSignal,
  onProgress?: (percentage: number) => void,
): Promise<ArrayBuffer> {
  const response = await fetch(asset.url, {
    signal,
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok)
    throw new Error(
      `${asset.name} download failed (HTTP ${response.status}). Try again when the upstream host is available.`,
    );
  const buffer = new Uint8Array(asset.bytes);
  let received = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (received + value.byteLength > asset.bytes)
          throw new Error(
            `${asset.name} has an unexpected size. The image has not been executed.`,
          );
        buffer.set(value, received);
        received += value.byteLength;
        onProgress?.(Math.round((received / asset.bytes) * 100));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } else {
    const bytes = new Uint8Array(await response.arrayBuffer());
    received = bytes.byteLength;
    if (received > asset.bytes)
      throw new Error(
        `${asset.name} has an unexpected size. The image has not been executed.`,
      );
    buffer.set(bytes);
  }
  if (received !== asset.bytes)
    throw new Error(`${asset.name} download was incomplete. Please try again.`);
  if (!globalThis.crypto?.subtle)
    throw new Error(
      "Image verification requires HTTPS or localhost. Open this playground over a secure connection.",
    );
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const actualHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (actualHash !== asset.sha256)
    throw new Error(
      `${asset.name} failed its integrity check. The image has not been executed.`,
    );
  onProgress?.(100);
  return buffer.buffer;
}

function assetUrl(file: string): string {
  // BASE_URL includes a project repository path on GitHub Pages.
  return new URL(
    `${import.meta.env?.BASE_URL ?? "./"}runtime/${file}`,
    document.baseURI,
  ).href;
}

function loadEmulatorLibrary(): Promise<V86Constructor> {
  if (window.V86) return Promise.resolve(window.V86);
  if (libraryPromise) return libraryPromise;

  libraryPromise = new Promise<V86Constructor>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = assetUrl("libv86.js");
    script.async = true;
    const timeout = window.setTimeout(
      () =>
        finish(
          new Error(
            "The emulator library timed out. Check the connection and retry.",
          ),
        ),
      30_000,
    );

    function finish(error?: Error) {
      window.clearTimeout(timeout);
      script.onload = null;
      script.onerror = null;
      if (error || !window.V86) {
        script.remove();
        reject(
          error ??
            new Error("The emulator library did not expose its public API."),
        );
      } else {
        resolve(window.V86);
      }
    }

    script.onload = () => finish();
    script.onerror = () =>
      finish(
        new Error(
          "Could not load the emulator. Check that the runtime assets were deployed.",
        ),
      );
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    libraryPromise = null;
    throw error;
  });

  return libraryPromise;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A machine owner retains the runtime independently of mounted terminal views. */
export interface LinuxRuntimeOptions {
  initScript?: string;
  networkPort?: NetworkPort;
  volumes?: readonly VolumeAttachment[];
}

export class LinuxRuntime implements MachineRuntime {
  private runtimeCapabilities: RuntimeCapabilities = Object.freeze({
    label: "Linux / x86",
    architecture: "i686",
    serialPorts: Object.freeze([0, 1, 2, 3] as SerialPort[]),
    interactivePorts: Object.freeze([1, 2, 3] as SerialPort[]),
    snapshots: true,
    initScripts: true,
    network: "web",
    evidenceCapture: true,
    evidenceMount: true,
    volumes: true,
  });
  get capabilities(): RuntimeCapabilities {
    return this.runtimeCapabilities;
  }
  private emulator: V86 | null = null;
  private listeners = new Set<RuntimeListener>();
  private outputListeners = [0, 1, 2, 3].map(() => new Set<OutputListener>());
  private snapshot: RuntimeSnapshot = Object.freeze<RuntimeSnapshot>({
    status: "idle",
    operation: null,
    message: "Ready to boot a local Linux kernel.",
    downloadProgress: null,
    startedAt: null,
    controlReady: false,
    displayEpoch: 0,
    init: {
      status: "idle",
      output: "",
      exitCode: null,
      message: "No init script has run.",
    },
    sessions: INTERACTIVE_SERIAL_PORTS.map((port) => ({
      port,
      title: `Shell ${port}`,
      status: "unavailable",
    })),
  });
  private transcripts = ["", "", "", ""];
  private outputBytes: number[][] = [[], [], [], []];
  private outputTimer: number | null = null;
  private decoders = [0, 1, 2, 3].map(() => new TextDecoder());
  private promptTail = "";
  private sessionTails = ["", "", "", ""];
  private generation = 0;
  private bootPromise: Promise<void> | null = null;
  private cancelBoot: (() => void) | null = null;
  private detachEmulatorListeners: (() => void) | null = null;
  private bootTimer: number | null = null;
  private downloadController: AbortController | null = null;
  private checkpointBusy = false;
  private initScript: string;
  private readonly networkPort?: NetworkPort;
  private restoredNeedsSetup = false;
  private evidenceBusy = false;
  private evidenceArchive: EvidenceArchive | null = null;
  private evidenceServer: ReadonlyEvidence9p | null = null;
  private volumeAttachments: VolumeAttachment[] = [];
  private volumeShutdownPrepared = false;
  private volumeSessions = new Map<number, VolumeSession>();
  private volumeDevices = new Map<number, PersistentVirtioBlock>();
  private volumeUnsubscribe: (() => void)[] = [];
  private volumeTaskBusy = false;
  private destroyPromise: Promise<void> | null = null;

  constructor(options: LinuxRuntimeOptions = {}) {
    this.initScript = validateInitScript(options.initScript ?? "");
    this.networkPort = options.networkPort;
    this.volumeAttachments = validateVolumeAttachments([...(options.volumes ?? [])]);
    this.refreshVolumeCapabilities();
    this.update({ volumes: this.volumeAttachments.map((attachment) => this.volumeState(attachment)) });
  }

  setInitScript = (script: string): void => {
    this.initScript = validateInitScript(script);
  };
  getInitScript = (): string => this.initScript;

  private requireNoEvidenceTask(): void {
    if (this.volumeTaskBusy)
      throw new Error("Wait for the current volume operation to finish.");
    if (this.evidenceBusy)
      throw new Error("Wait for evidence acquisition or attachment to finish.");
  }

  private refreshVolumeCapabilities(): void {
    this.runtimeCapabilities = Object.freeze({ ...this.runtimeCapabilities, snapshots: !this.evidenceArchive && this.volumeAttachments.length === 0 });
  }

  private volumeState(attachment: VolumeAttachment): VolumeAttachmentState {
    return {
      ...attachment, name: attachment.id, bytes: 0, kind: "volume", readOnly: attachment.readOnly === true,
      device: `/dev/terrarium-volume${attachment.slot}`, mountPath: `/mnt/volumes/disk${attachment.slot}`,
      status: "configured", pendingWrites: 0, lastPersistedAt: null,
    };
  }
  private updateVolume(slot: number, patch: Partial<VolumeAttachmentState>): void {
    this.update({ volumes: (this.snapshot.volumes ?? []).map((state) => state.slot === slot ? Object.freeze({ ...state, ...patch }) : state) });
  }
  getVolumeAttachments = (): readonly VolumeAttachment[] => this.volumeAttachments.map((attachment) => Object.freeze({ ...attachment }));

  private requireVolumeConfiguration(): void {
    this.requireNoEvidenceTask();
    if (this.emulator || this.bootPromise || this.snapshot.status !== "idle" || this.checkpointBusy)
      throw new Error("Stop this machine before attaching or detaching a volume. Disk hotplug is not supported.");
  }
  attachVolume = async (input: VolumeAttachment): Promise<void> => {
    this.requireVolumeConfiguration();
    const attachments = validateVolumeAttachments([...this.volumeAttachments, input]);
    this.volumeTaskBusy = true; this.update({ volumeOperation: "attaching" });
    try {
      const metadata = await getVolume(input.id);
      const attachment = attachments.find((entry) => entry.id === input.id)!;
      attachment.readOnly = attachment.readOnly || metadata.kind === "snapshot";
      this.volumeAttachments = attachments;
      this.refreshVolumeCapabilities();
      this.update({ volumes: [...(this.snapshot.volumes ?? []), { ...this.volumeState(attachment), name: metadata.name, bytes: metadata.bytes, kind: metadata.kind }].sort((a, b) => a.slot - b.slot) });
    } finally { this.volumeTaskBusy = false; this.update({ volumeOperation: null }); }
  };
  detachVolume = async (slot: 0 | 1): Promise<void> => {
    this.requireVolumeConfiguration();
    if (slot !== 0 && slot !== 1) throw new Error("Choose VirtIO disk slot 0 or 1.");
    this.volumeAttachments = this.volumeAttachments.filter((attachment) => attachment.slot !== slot);
    this.refreshVolumeCapabilities();
    this.update({ volumes: (this.snapshot.volumes ?? []).filter((attachment) => attachment.slot !== slot) });
  };

  private async openVolumes(generation: number): Promise<void> {
    for (const attachment of this.volumeAttachments) {
      this.updateVolume(attachment.slot, { status: "opening", error: undefined });
      const session = await openVolume(attachment.id, { readOnly: attachment.readOnly });
      if (generation !== this.generation) { await session.close(); throw new DOMException("Boot cancelled.", "AbortError"); }
      this.volumeSessions.set(attachment.slot, session);
      const metadata = session.getMetadata();
      this.updateVolume(attachment.slot, { name: metadata.name, bytes: metadata.bytes, kind: metadata.kind, readOnly: session.readOnly });
      this.volumeUnsubscribe.push(session.subscribe((state) => {
        if (generation === this.generation) this.updateVolume(attachment.slot, { pendingWrites: state.pendingWrites, lastPersistedAt: state.lastPersistedAt, ...(state.error ? { error: state.error, status: "error" } : {}) });
      }));
    }
  }
  private installVolumeDevices(emulator: V86, generation: number): void {
    for (const attachment of this.volumeAttachments) {
      const session = this.volumeSessions.get(attachment.slot)!;
      const device = new PersistentVirtioBlock(emulator, session, attachment.slot, (error) => {
        if (generation !== this.generation) return;
        this.networkPort?.setReady(false);
        this.updateVolume(attachment.slot, { status: "error", error: error.message });
        this.update({ status: "error", controlReady: false, message: `Volume I/O stopped: ${error.message}` });
        void emulator.stop().catch(() => undefined);
      });
      this.volumeDevices.set(attachment.slot, device);
    }
  }
  private async closeVolumes(): Promise<void> {
    const devices = [...this.volumeDevices.values()];
    const sessions = [...this.volumeSessions.values()];
    this.volumeDevices.clear(); this.volumeSessions.clear();
    const results = await Promise.allSettled(devices.map((device) => device.drain()));
    devices.forEach((device) => device.dispose());
    this.volumeUnsubscribe.forEach((unsubscribe) => unsubscribe()); this.volumeUnsubscribe = [];
    results.push(...await Promise.allSettled(sessions.map((session) => session.close())));
    const failed = results.find((result) => result.status === "rejected");
    const failure = failed?.status === "rejected" ? errorMessage(failed.reason) : undefined;
    this.update({ volumes: (this.snapshot.volumes ?? []).map((state) => ({ ...state, status: state.error || failure ? "error" : "closed", pendingWrites: 0, ...(failure ? { error: state.error ?? failure } : {}) })) });
    if (failed?.status === "rejected") throw failed.reason;
  }

  syncVolumes = async (execute: EvidenceExecutor): Promise<void> => {
    this.requireNoEvidenceTask();
    if (!this.volumeAttachments.length) return;
    const emulator = this.emulator;
    if (!emulator || this.snapshot.status !== "running" || !this.snapshot.controlReady || this.checkpointBusy)
      throw new Error("Resume the machine and wait for its command channel before syncing volumes.");
    this.volumeTaskBusy = true; this.update({ volumeOperation: "syncing" });
    let stopped = false;
    try {
      const result = await execute("sync");
      if (result.status !== "exited" || result.exitCode !== 0)
        throw new Error("The guest did not confirm its filesystem sync. " + (result.message ?? result.output.slice(-300)));
      this.update({ operation: "saving" });
      this.networkPort?.setReady(false);
      await emulator.stop(); stopped = true;
      await Promise.all([...this.volumeDevices.values()].map((device) => device.drain()));
      await Promise.all([...this.volumeSessions.values()].map((session) => session.flush()));
    } finally {
      try {
        if (stopped && this.snapshot.status === "running") { await emulator.run(); this.networkPort?.setReady(true); }
      } catch (error) {
        this.update({ status: "error", controlReady: false, message: "The machine could not resume after volume sync: " + errorMessage(error) });
        throw error;
      } finally { this.volumeTaskBusy = false; this.update({ operation: null, volumeOperation: null }); }
    }
  };

  /** Cleanly unmount data disks, then keep the CPU and input gated until destroy. */
  prepareVolumeShutdown = async (execute: EvidenceExecutor): Promise<void> => {
    this.requireNoEvidenceTask();
    const writable = [...this.volumeSessions.entries()].filter(([, session]) => !session.readOnly).map(([slot]) => slot).sort();
    if (!writable.length) return;
    const emulator = this.emulator;
    if (!emulator || this.snapshot.status !== "running" || !this.snapshot.controlReady || this.checkpointBusy)
      throw new Error("Resume the machine and wait for its command channel before shutting down writable volumes.");
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
      this.update({ operation: "saving" });
      this.networkPort?.setReady(false);
      await emulator.stop();
      await Promise.all([...this.volumeDevices.values()].map((device) => device.drain()));
      await Promise.all([...this.volumeSessions.values()].map((session) => session.flush()));
      this.volumeShutdownPrepared = true;
      this.update({ status: "paused", controlReady: false, message: "Data disks are unmounted and committed. The CPU is stopped for shutdown." });
    } catch (error) {
      let restored = false;
      if (!stopping) {
        try {
          const result = await execute(repair);
          restored = result.status === "exited" && result.exitCode === 0;
        } catch { /* An unavailable command channel cannot confirm a safe rollback. */ }
      }
      if (restored) {
        this.update({ message: "Shutdown was refused. Writable data disks remain mounted; close processes using them before retrying." });
      } else {
        this.networkPort?.setReady(false);
        await emulator.stop().catch(() => undefined);
        this.update({ status: "error", controlReady: false, message: "Shutdown stopped the CPU, but writable mounts or storage completion could not be confirmed. Disk bytes were preserved. " + errorMessage(error) });
      }
      throw error;
    } finally {
      if (!this.volumeShutdownPrepared) {
        this.volumeTaskBusy = false;
        this.update({ operation: null, volumeOperation: null });
      }
    }
  };

  attachEvidence = async (input: EvidenceArchive): Promise<void> => {
    this.requireNoEvidenceTask();
    if (
      this.emulator ||
      this.bootPromise ||
      this.snapshot.status !== "idle" ||
      this.checkpointBusy
    )
      throw new Error("Attach evidence to a new, unbooted analyst machine.");
    this.evidenceBusy = true;
    this.update({ acquiringEvidence: true });
    try {
      const archive = await importEvidenceArchive(exportEvidenceArchive(input));
      this.evidenceArchive = archive;
      this.evidenceServer = new ReadonlyEvidence9p(archive);
      this.runtimeCapabilities = Object.freeze({
        ...this.runtimeCapabilities,
        snapshots: false,
        evidenceCapture: false,
      });
      this.update({
        evidenceAttachment: {
          id: archive.id,
          sha256: archive.sha256,
          mountPath: "/mnt/evidence",
        },
      });
    } finally {
      this.evidenceBusy = false;
      this.update({ acquiringEvidence: false });
    }
  };

  captureEvidence = async (
    paths: string[],
    execute: EvidenceExecutor,
    options: EvidenceCaptureOptions = {},
  ): Promise<EvidenceArchive> => {
    this.requireNoEvidenceTask();
    const selected = validateEvidencePaths(paths);
    const emulator = this.emulator;
    if (
      !emulator ||
      this.snapshot.status !== "running" ||
      !this.snapshot.controlReady ||
      this.checkpointBusy
    )
      throw new Error(
        "Explicitly resume the quarantined clone and wait for its command channel before acquiring files.",
      );
    if (!this.networkPort?.getSnapshot().quarantined)
      throw new Error(
        "Acquire evidence from a host-quarantined investigation clone.",
      );
    if (this.evidenceArchive)
      throw new Error(
        "The analyst's attached evidence is already a logical capture.",
      );
    if (
      options.checkpointSha256 &&
      options.checkpointSha256 !== this.snapshot.sourceCheckpointSha256
    )
      throw new Error(
        "This machine is no longer restored from the selected source checkpoint.",
      );
    const generation = this.generation;
    const token = crypto.randomUUID().replaceAll("-", "");
    const mount = "/tmp/terrarium-capture-" + token;
    const transferNames: string[] = [];
    const captured: EvidenceInputFile[] = [];
    let total = 0;
    this.evidenceBusy = true;
    this.update({ acquiringEvidence: true });
    const run = async (command: string) => {
      if (generation !== this.generation)
        throw new Error(
          "The investigation machine changed during acquisition.",
        );
      const result = await execute(command);
      if (result.status !== "exited" || result.exitCode !== 0)
        throw new Error(
          result.message ||
            "Guest-assisted acquisition failed: " +
              (result.output.slice(-600) || result.status),
        );
    };
    try {
      await run(
        [
          "set -e",
          "mkdir -p " + shellQuote(mount),
          '_trm_host=$(awk \'$1 == "host9p" && $3 == "9p" { print $2; exit }\' /proc/mounts)',
          'if [ -n "$_trm_host" ]; then mount -o bind "$_trm_host" ' +
            shellQuote(mount) +
            "; else mount -t 9p -o trans=virtio,version=9p2000.L,msize=65536 host9p " +
            shellQuote(mount) +
            "; fi",
        ].join("\n"),
      );
      for (const [index, path] of selected.entries()) {
        const name = "capture-" + token + "-" + index + ".bin";
        transferNames.push(name);
        const destination = mount + "/" + name;
        await run(
          [
            "set -e",
            "_trm_source=" + shellQuote(path),
            '[ -f "$_trm_source" ] && [ ! -L "$_trm_source" ] || { echo "Select a regular file, not a directory or symlink"; exit 1; }',
            '_trm_size=$(wc -c < "$_trm_source")',
            'case "$_trm_size" in ""|*[!0-9]*) echo "Cannot determine file size"; exit 1;; esac',
            '[ "$_trm_size" -le ' +
              MAX_EVIDENCE_FILE_BYTES +
              ' ] || { echo "File exceeds 1 MiB"; exit 1; }',
            'dd if="$_trm_source" of=' +
              shellQuote(destination) +
              " bs=65536 count=17 2>/dev/null",
          ].join("\n"),
        );
        const bytes = await readBounded9pFile(emulator, name);
        total += bytes.byteLength;
        if (total > MAX_EVIDENCE_TOTAL_BYTES)
          throw new Error(
            "The selected files exceed the 8 MiB evidence limit.",
          );
        captured.push({ path, bytes });
        await run("rm -f " + shellQuote(destination));
      }
      return await createEvidenceArchive(
        options.title ?? "Logical file capture",
        captured,
        {
          method: "guest-assisted-logical",
          guestExecuted: true,
          ...(options.machineId ? { machineId: options.machineId } : {}),
          ...(options.machineName ? { machineName: options.machineName } : {}),
          ...(this.snapshot.sourceCheckpointSha256
            ? { checkpointSha256: this.snapshot.sourceCheckpointSha256 }
            : {}),
        },
      );
    } finally {
      if (
        generation === this.generation &&
        this.snapshot.status === "running"
      ) {
        const files = transferNames
          .map((name) => shellQuote(mount + "/" + name))
          .join(" ");
        await execute(
          "rm -f " +
            files +
            "; umount " +
            shellQuote(mount) +
            "; rmdir " +
            shellQuote(mount),
        ).catch(() => undefined);
      }
      this.evidenceBusy = false;
      this.update({ acquiringEvidence: false });
    }
  };

  getSnapshot = (): RuntimeSnapshot => this.snapshot;

  subscribe = (listener: RuntimeListener): (() => void) => {
    this.listeners.add(listener);
    try {
      listener(this.snapshot);
    } catch {
      /* An observer must not break the machine lifecycle. */
    }
    return () => {
      this.listeners.delete(listener);
    };
  };

  onOutput = (listener: OutputListener, port: SerialPort = 0): (() => void) => {
    this.assertPort(port);
    this.outputListeners[port].add(listener);
    if (this.transcripts[port]) {
      try {
        listener(this.transcripts[port]);
      } catch {
        /* A detached display must not break the serial stream. */
      }
    }
    return () => {
      this.outputListeners[port].delete(listener);
    };
  };

  private assertPort(port: number): asserts port is SerialPort {
    if (!Number.isInteger(port) || port < 0 || port > 3)
      throw new Error("Choose a serial port from 0 to 3.");
  }

  private update(patch: Partial<RuntimeSnapshot>): void {
    this.snapshot = Object.freeze({
      ...this.snapshot,
      ...patch,
      ...(patch.init ? { init: Object.freeze({ ...patch.init }) } : {}),
      ...(patch.sessions
        ? {
            sessions: Object.freeze(
              patch.sessions.map((session) => Object.freeze({ ...session })),
            ),
          }
        : {}),
    });
    this.listeners.forEach((listener) => {
      try {
        listener(this.snapshot);
      } catch {
        /* Keep lifecycle operations independent of UI observers. */
      }
    });
  }

  private flushOutput = (): void => {
    if (this.outputTimer !== null) window.clearTimeout(this.outputTimer);
    this.outputTimer = null;
    for (const port of [0, 1, 2, 3] as const) {
      if (!this.outputBytes[port].length) continue;
      const output = this.decoders[port].decode(
        new Uint8Array(this.outputBytes[port]),
        { stream: true },
      );
      this.outputBytes[port] = [];
      this.transcripts[port] = (this.transcripts[port] + output).slice(
        -TRANSCRIPT_LIMIT,
      );
      this.outputListeners[port].forEach((listener) => {
        try {
          listener(output);
        } catch {
          /* Keep one observer from breaking other consumers. */
        }
      });
    }
  };

  private clearDisplay(): void {
    if (this.outputTimer !== null) window.clearTimeout(this.outputTimer);
    this.outputTimer = null;
    this.outputBytes = [[], [], [], []];
    this.transcripts = ["", "", "", ""];
    this.decoders = [0, 1, 2, 3].map(() => new TextDecoder());
    this.sessionTails = ["", "", "", ""];
    this.promptTail = "";
    this.update({ displayEpoch: (this.snapshot.displayEpoch ?? 0) + 1 });
  }

  private clearBootTimer(): void {
    if (this.bootTimer !== null) window.clearTimeout(this.bootTimer);
    this.bootTimer = null;
  }

  boot = (): Promise<void> => {
    if (this.volumeTaskBusy)
      return Promise.reject(new Error("Wait for the current volume operation to finish."));
    if (this.evidenceBusy)
      return Promise.reject(
        new Error("Wait for evidence acquisition or attachment to finish."),
      );
    if (this.checkpointBusy)
      return Promise.reject(
        new Error("Wait for the current checkpoint operation to finish."),
      );
    return this.bootMachine();
  };

  private bootMachine = (
    forRestore = false,
    pausedState?: ArrayBuffer,
  ): Promise<void> => {
    if (this.bootPromise) return this.bootPromise;
    if (!pausedState && this.snapshot.status === "running")
      return Promise.resolve();
    if (!pausedState && this.snapshot.status === "paused") return this.resume();

    const generation = ++this.generation;
    const script = forRestore ? "" : this.initScript;
    this.restoredNeedsSetup = false;
    this.networkPort?.setReady(false);
    this.clearDisplay();
    this.update({
      status: "loading",
      message: "Loading the emulator and Linux image…",
      downloadProgress: null,
      startedAt: null,
      controlReady: false,
      passiveRestore: false,
      ...(!forRestore ? { sourceCheckpointSha256: undefined } : {}),
      init: {
        status: script.trim() ? "pending" : "skipped",
        output: "",
        exitCode: null,
        message: forRestore
          ? "Snapshot restore does not replay the init script."
          : script.trim()
            ? "The init script will run after Linux boots."
            : "No init script configured.",
      },
      sessions: INTERACTIVE_SERIAL_PORTS.map((port) => ({
        port,
        title: `Shell ${port}`,
        status: "starting",
      })),
    });

    const task = this.startMachine(generation, forRestore, script, pausedState)
      .catch(async (error: unknown) => {
        if (generation !== this.generation) throw error;
        this.downloadController?.abort();
        this.downloadController = null;
        this.clearBootTimer();
        this.flushOutput();
        this.detachEmulatorListeners?.();
        this.detachEmulatorListeners = null;
        this.networkPort?.detach();
        const failedEmulator = this.emulator;
        this.emulator = null;
        if (failedEmulator) await failedEmulator.stop().catch(() => undefined);
        await this.closeVolumes().catch(() => undefined);
        if (failedEmulator)
          await failedEmulator.destroy().catch(() => undefined);
        if (generation !== this.generation) throw error;
        this.update({
          status: "error",
          controlReady: false,
          message: errorMessage(error),
          downloadProgress: null,
        });
        throw error;
      })
      .finally(() => {
        if (generation === this.generation) {
          this.bootPromise = null;
          this.cancelBoot = null;
        }
      });
    this.bootPromise = task;
    return task;
  };

  private async startMachine(
    generation: number,
    forRestore: boolean,
    script: string,
    pausedState?: ArrayBuffer,
  ): Promise<void> {
    if (typeof WebAssembly === "undefined")
      throw new Error(
        "This browser does not support WebAssembly. Use a current desktop browser.",
      );
    if (!globalThis.crypto?.subtle)
      throw new Error(
        "Image verification requires HTTPS or localhost. Open this playground over a secure connection.",
      );
    // A failed resume may leave a stopped instance behind. Retire it before
    // installing a new one, including when retrying through the agent API.
    if (this.emulator) {
      const previous = this.emulator;
      this.emulator = null;
      this.detachEmulatorListeners?.();
      this.detachEmulatorListeners = null;
      this.networkPort?.detach();
      await previous.stop().catch(() => undefined);
      await this.closeVolumes();
      await previous.destroy().catch(() => undefined);
      if (generation !== this.generation)
        throw new DOMException("Boot cancelled.", "AbortError");
    }
    const controller = new AbortController();
    this.downloadController = controller;
    const downloadTimeout = window.setTimeout(
      () =>
        controller.abort(
          new Error(
            "Runtime download timed out. Check the connection and retry.",
          ),
        ),
      90_000,
    );
    let assets: [V86Constructor, ArrayBuffer, ArrayBuffer, ArrayBuffer];
    try {
      assets = await Promise.all([
        loadEmulatorLibrary(),
        pausedState
          ? Promise.resolve(new ArrayBuffer(0))
          : fetchVerifiedAsset(
              GUEST_ASSETS.kernel,
              controller.signal,
              (downloadProgress) => {
                if (generation === this.generation)
                  this.update({ downloadProgress });
              },
            ),
        fetchVerifiedAsset(GUEST_ASSETS.bios, controller.signal),
        fetchVerifiedAsset(GUEST_ASSETS.vgaBios, controller.signal),
      ]);
    } finally {
      window.clearTimeout(downloadTimeout);
    }
    if (generation !== this.generation)
      throw new DOMException("Boot cancelled.", "AbortError");
    this.downloadController = null;
    const [Constructor, kernel, bios, vgaBios] = assets;
    await this.openVolumes(generation);
    if (generation !== this.generation)
      throw new DOMException("Boot cancelled.", "AbortError");

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let machineReady = false;
      let disposed = false;
      let kernelReady = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        this.clearBootTimer();
        if (error) reject(error);
        else resolve();
      };
      this.cancelBoot = () =>
        settle(new DOMException("Boot cancelled.", "AbortError"));
      this.bootTimer = window.setTimeout(() => {
        settle(
          new Error(
            "Linux did not reach a shell within two minutes. Reset the machine to retry.",
          ),
        );
      }, BOOT_TIMEOUT_MS);

      const emulatorOptions: V86Options & {
        mac_address_translation: boolean;
        preserve_mac_from_state_image: boolean;
      } = {
        wasm_path: assetUrl("v86.wasm"),
        memory_size: RUNTIME_MEMORY_MIB * 1024 * 1024,
        vga_memory_size: 2 * 1024 * 1024,
        bios: { buffer: bios },
        vga_bios: { buffer: vgaBios },
        ...(pausedState
          ? { initial_state: { buffer: pausedState } }
          : { bzimage: { buffer: kernel } }),
        filesystem: this.evidenceServer
          ? { handle9p: this.evidenceServer.handle }
          : {},
        cmdline: "console=ttyS0,115200 tsc=reliable random.trust_cpu=on",
        // Start only from our readiness callback. A cancelled boot must never
        // become a detached machine when a slow WebAssembly download finishes.
        autostart: false,
        disable_keyboard: true,
        disable_mouse: true,
        disable_speaker: true,
        uart1: true,
        uart2: true,
        uart3: true,
        net_device: this.networkPort?.v86Options(),
        mac_address_translation: true,
        preserve_mac_from_state_image: false,
        // No host directory or credentials are mounted. Network policy is
        // enforced by the separately owned port before the CPU can run.
      };
      const emulator = new Constructor(emulatorOptions);
      this.emulator = emulator;

      const onReady = () => {
        machineReady = true;
        if (disposed || generation !== this.generation) {
          emulator.remove_listener("emulator-ready", onReady);
          void emulator.destroy().catch(() => undefined);
          return;
        }
        this.update({
          status: "booting",
          message: "Linux is booting. Waiting for the shell…",
          downloadProgress: 100,
          startedAt: Date.now(),
        });
        try {
          this.installVolumeDevices(emulator, generation);
          this.networkPort?.attach(emulator);
          if (pausedState) {
            this.restoredNeedsSetup = true;
            this.update({
              status: "paused",
              passiveRestore: true,
              controlReady: false,
              startedAt: null,
              message:
                "Checkpoint loaded with the CPU stopped. No guest instructions, setup commands, or init scripts have run.",
            });
            settle();
            return;
          }
          for (const port of INTERACTIVE_SERIAL_PORTS)
            emulator.serial_set_carrier_detect(port, true);
          void emulator
            .run()
            .catch((error: unknown) => settle(new Error(errorMessage(error))));
        } catch (error) {
          settle(new Error(errorMessage(error)));
        }
      };
      const onProgress = (event: {
        file_index: number;
        file_count: number;
        total: number;
        loaded: number;
        lengthComputable: boolean;
      }) => {
        if (
          generation !== this.generation ||
          this.snapshot.status !== "loading"
        )
          return;
        const fraction =
          event.lengthComputable && event.total > 0
            ? event.loaded / event.total
            : 0;
        const percentage =
          event.file_count > 0
            ? Math.round(
                ((event.file_index + fraction) / event.file_count) * 100,
              )
            : null;
        this.update({
          downloadProgress:
            percentage === null
              ? null
              : Math.min(
                  100,
                  Math.max(this.snapshot.downloadProgress ?? 0, percentage),
                ),
        });
      };
      const onDownloadError = () =>
        settle(
          new Error(
            "A runtime asset could not be downloaded. Check the deployment and try again.",
          ),
        );
      const onByte = (port: SerialPort, byte: number) => {
        if (generation !== this.generation) return;
        this.outputBytes[port].push(byte);
        if (this.outputTimer === null)
          this.outputTimer = window.setTimeout(this.flushOutput, 16);
        if (this.outputBytes[port].length >= 32_768) this.flushOutput();
        if (port !== 0) {
          this.sessionTails[port] = (
            this.sessionTails[port] + String.fromCharCode(byte)
          ).slice(-512);
          if (
            isSessionPrompt(this.sessionTails[port], port) &&
            this.snapshot.sessions?.some(
              (session) => session.port === port && session.status !== "ready",
            )
          ) {
            this.flushOutput();
            this.update({
              sessions: this.snapshot.sessions.map((session) =>
                session.port === port
                  ? { ...session, status: "ready" }
                  : session,
              ),
            });
          }
          return;
        }
        if (settled || kernelReady) return;
        this.promptTail = (this.promptTail + String.fromCharCode(byte)).slice(
          -2048,
        );

        // Only mark the machine ready after observing its actual serial shell.
        const plainTail = this.promptTail
          .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
          .replace(/\r/g, "");
        if (
          /(?:^|\n)(?:~|\/[^\n]*|[^\n]*@[^\n]*|[^\n]*:~)\s*[%#$] $/.test(
            plainTail,
          )
        ) {
          kernelReady = true;
          this.flushOutput();
          void this.initializeGuest(generation, forRestore, script)
            .then(() => {
              if (generation !== this.generation || disposed) return;
              this.update({
                status: "running",
                message:
                  this.snapshot.init?.status === "failed"
                    ? "Linux is running. The init script needs attention."
                    : "Linux is running with three independent shells.",
                downloadProgress: 100,
                startedAt: this.snapshot.startedAt ?? Date.now(),
              });
              settle();
            })
            .catch((error: unknown) => settle(new Error(errorMessage(error))));
        }
      };

      emulator.add_listener("emulator-ready", onReady);
      emulator.add_listener("download-progress", onProgress);
      emulator.add_listener("download-error", onDownloadError);
      const byteListeners = ([0, 1, 2, 3] as const).map((port) => {
        const listener = (byte: number) => onByte(port, byte);
        emulator.add_listener(`serial${port}-output-byte`, listener);
        return { port, listener };
      });
      this.detachEmulatorListeners = () => {
        disposed = true;
        // Before initialization, destroy() cannot reach the CPU. Retain one
        // callback to dispose it as soon as initialization eventually completes.
        if (machineReady) emulator.remove_listener("emulator-ready", onReady);
        emulator.remove_listener("download-progress", onProgress);
        emulator.remove_listener("download-error", onDownloadError);
        for (const { port, listener } of byteListeners)
          emulator.remove_listener(`serial${port}-output-byte`, listener);
      };
    });
  }

  private async controlCommand(
    command: string,
    generation: number,
    timeoutMs = 15_000,
  ): Promise<RunResult> {
    const controlState = (): RuntimeSnapshot => {
      if (generation !== this.generation)
        return { ...this.snapshot, status: "idle", operation: null };
      return {
        ...this.snapshot,
        status: this.snapshot.status === "error" ? "error" : "running",
        operation: null,
        volumeOperation: null,
        controlReady: true,
      };
    };
    // Startup owns ttyS0 before the public machine is ready. This private
    // adapter also permits host configuration while restore holds its lock.
    const runner = new CommandRunner({
      getSnapshot: controlState,
      subscribe: (listener) => this.subscribe(() => listener(controlState())),
      onOutput: (listener) => this.onOutput(listener, 0),
      send: (text) => {
        if (generation !== this.generation || !this.emulator)
          throw new Error("Machine startup was cancelled.");
        this.emulator.serial_send_bytes(0, new TextEncoder().encode(text));
      },
    });
    try {
      return await runner.execute(command, { timeoutMs });
    } finally {
      runner.dispose();
    }
  }

  private async prepareGuestServices(
    generation: number,
    restoring: boolean,
  ): Promise<void> {
    if (this.networkPort) {
      this.networkPort.setReady(false);
      const network = await this.controlCommand(
        this.networkPort.guestSetupCommand(),
        generation,
      );
      if (network.status !== "exited" || network.exitCode !== 0)
        throw new Error(
          `Could not configure this machine's network address: ${network.output.slice(-600) || network.message || network.status}`,
        );
      if (generation !== this.generation)
        throw new DOMException("Boot cancelled.", "AbortError");
    }
    const setup = await this.controlCommand(
      sessionBootstrapCommand(),
      generation,
    );
    if (setup.status !== "exited" || setup.exitCode !== 0)
      throw new Error(
        `Could not prepare the independent terminal sessions: ${setup.output.slice(-600) || setup.message || setup.status}`,
      );
    if (generation !== this.generation)
      throw new DOMException("Boot cancelled.", "AbortError");
    if (restoring) {
      // A saved shell may be running a foreground job, so do not inject Enter
      // or wait for a prompt on interactive ports after restoration.
      this.update({
        sessions: INTERACTIVE_SERIAL_PORTS.map((port) => ({
          port,
          title: `Shell ${port}`,
          status: "ready",
        })),
      });
    } else {
      await this.waitForSessions(generation);
    }
    if (this.evidenceArchive) {
      // The stock initramfs mounts host9p at /mnt during boot. On a clean
      // analyst, move that single transport to the clearly labeled view.
      const mounted = await this.controlCommand(
        [
          "set -e",
          '_trm_host=$(awk \'$1 == "host9p" && $3 == "9p" { print $2; exit }\' /proc/mounts)',
          'if [ -n "$_trm_host" ]; then umount "$_trm_host"; fi',
          "mkdir -p /mnt/evidence",
          "mount -t 9p -o trans=virtio,version=9p2000.L,msize=65536,ro,nodev,nosuid,noexec host9p /mnt/evidence",
        ].join("\n"),
        generation,
      );
      if (mounted.status !== "exited" || mounted.exitCode !== 0)
        throw new Error(
          "Could not mount the read-only evidence view: " +
            (mounted.output.slice(-600) || mounted.message || mounted.status),
        );
    }
    for (const attachment of this.volumeAttachments) {
      const session = this.volumeSessions.get(attachment.slot)!;
      const device = `/dev/terrarium-volume${attachment.slot}`;
      const mount = `/mnt/volumes/disk${attachment.slot}`;
      const pci = (14 + attachment.slot).toString(16).padStart(2, "0");
      const result = await this.controlCommand([
        "set -e",
        "rm -f " + shellQuote(device),
        "_trm_found=0",
        `for _trm_disk in /sys/bus/pci/devices/0000:00:${pci}.0/virtio*/block/*; do`,
        '  [ -f "$_trm_disk/dev" ] || continue',
        '  _trm_numbers=$(cat "$_trm_disk/dev")',
        `  mknod ${shellQuote(device)} b "\${_trm_numbers%:*}" "\${_trm_numbers#*:}"`,
        "  _trm_found=1; break",
        "done",
        '[ "$_trm_found" = 1 ] || { echo "The Linux VirtIO block driver did not discover the attached disk"; exit 1; }',
        "mkdir -p " + shellQuote(mount),
        `mount -t ext2 -o ${session.readOnly ? "ro,nodev,nosuid,noexec" : "rw,sync,nodev,nosuid"} ${shellQuote(device)} ${shellQuote(mount)}`,
      ].join("\n"), generation);
      if (result.status !== "exited" || result.exitCode !== 0)
        throw new Error(`Could not mount volume ${session.getMetadata().name}: ${result.output.slice(-600) || result.message || result.status}`);
      this.updateVolume(attachment.slot, { status: "mounted" });
    }
    this.networkPort?.setReady(true);
  }

  private waitForSessions(generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe = () => {};
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        unsubscribe();
        if (error) reject(error);
        else resolve();
      };
      const timer = window.setTimeout(
        () =>
          finish(
            new Error(
              "The three independent shells did not become ready. Reset the machine to retry.",
            ),
          ),
        10_000,
      );
      unsubscribe = this.subscribe((state) => {
        if (
          generation !== this.generation ||
          state.status === "error" ||
          state.status === "idle"
        )
          finish(new DOMException("Boot cancelled.", "AbortError"));
        else if (
          INTERACTIVE_SERIAL_PORTS.every((port) =>
            state.sessions?.some(
              (session) => session.port === port && session.status === "ready",
            ),
          )
        )
          finish();
      });
      if (settled) unsubscribe();
    });
  }

  private async initializeGuest(
    generation: number,
    forRestore: boolean,
    script: string,
  ): Promise<void> {
    if (forRestore) return;
    this.update({ message: "Preparing three independent terminal sessions…" });
    await this.prepareGuestServices(generation, false);
    if (generation !== this.generation)
      throw new DOMException("Boot cancelled.", "AbortError");
    if (!script.trim()) {
      this.update({
        controlReady: true,
        init: {
          status: "skipped",
          output: "",
          exitCode: null,
          message: "No init script configured.",
        },
      });
      return;
    }
    this.update({
      message: "Running the configured init script…",
      init: {
        status: "running",
        output: "",
        exitCode: null,
        message:
          "Running once for this fresh boot. Limit: 60 seconds and 64 KiB of output.",
      },
    });
    const result = await this.controlCommand(script, generation, 60_000);
    if (generation !== this.generation)
      throw new DOMException("Boot cancelled.", "AbortError");
    const succeeded = result.status === "exited" && result.exitCode === 0;
    this.update({
      controlReady: result.recovery !== "reset_required",
      init: {
        status: succeeded ? "succeeded" : "failed",
        output: result.output,
        exitCode: result.exitCode,
        message: succeeded
          ? "Init script completed for this boot."
          : (result.message ??
            (result.status === "exited"
              ? `Init script exited with code ${result.exitCode}. The machine remains available.`
              : `Init script ${result.status.replace(/_/g, " ")}. Its full completion is not confirmed.`)),
      },
    });
  }

  send = (text: string, port: SerialPort = 0): void => {
    this.assertPort(port);
    if (this.checkpointBusy || this.snapshot.operation)
      throw new Error("Wait for the current checkpoint or volume operation to finish.");
    if (this.volumeTaskBusy && (port !== 0 || this.snapshot.volumeOperation !== "syncing"))
      throw new Error("Wait for the volume sync before sending terminal input.");
    if (!this.emulator || this.snapshot.status !== "running") return;
    if (port === 0 && this.snapshot.controlReady === false)
      throw new Error(
        "The command channel needs a reset. Interactive shells remain separate.",
      );
    // Unlike serial0_send, this preserves UTF-8 input rather than truncating codepoints.
    this.emulator.serial_send_bytes(port, new TextEncoder().encode(text));
  };

  pause = async (): Promise<void> => {
    this.requireNoEvidenceTask();
    if (this.checkpointBusy)
      throw new Error("Wait for the current checkpoint operation to finish.");
    if (
      this.bootPromise ||
      ["loading", "booting"].includes(this.snapshot.status)
    )
      throw new Error("Wait for Linux to finish booting before pausing.");
    if (!this.emulator || this.snapshot.status !== "running") return;
    const generation = this.generation;
    this.networkPort?.setReady(false);
    // Publish the input gate before awaiting the CPU stop acknowledgment.
    this.update({
      status: "paused",
      message: "Machine paused. Memory is retained in this tab.",
    });
    try {
      await this.emulator.stop();
      if (generation !== this.generation) return;
      this.flushOutput();
    } catch (error: unknown) {
      if (generation === this.generation)
        this.update({
          status: "error",
          controlReady: false,
          message: `Could not pause the machine: ${errorMessage(error)}. Reset to retry.`,
        });
      throw error;
    }
  };

  resume = async (): Promise<void> => {
    this.requireNoEvidenceTask();
    if (this.checkpointBusy)
      throw new Error("Wait for the current checkpoint operation to finish.");
    if (
      this.bootPromise ||
      ["loading", "booting"].includes(this.snapshot.status)
    )
      throw new Error("Wait for Linux to finish booting before resuming.");
    if (!this.emulator || this.snapshot.status !== "paused") return;
    const generation = this.generation;
    try {
      if (this.restoredNeedsSetup)
        this.update({
          status: "booting",
          passiveRestore: false,
          controlReady: false,
          message:
            "Explicitly resuming the restored guest. Preparing its command channel under the existing network quarantine.",
        });
      await this.emulator.run();
      if (generation !== this.generation) return;
      if (this.restoredNeedsSetup) {
        for (const port of INTERACTIVE_SERIAL_PORTS)
          this.emulator.serial_set_carrier_detect(port, true);
        await this.prepareGuestServices(generation, true);
        if (generation !== this.generation) return;
        this.restoredNeedsSetup = false;
        this.update({ controlReady: true });
      }
      this.networkPort?.setReady(true);
      this.update({
        status: "running",
        message: "Linux is running locally in this tab.",
      });
    } catch (error: unknown) {
      if (generation === this.generation)
        this.update({
          status: "error",
          controlReady: false,
          message: `Could not resume the machine: ${errorMessage(error)}. Reset to retry.`,
        });
      throw error;
    }
  };

  reset = async (): Promise<void> => {
    this.requireNoEvidenceTask();
    if (this.checkpointBusy)
      throw new Error("Wait for the current checkpoint operation to finish.");
    const writable = (this.snapshot.volumes ?? []).some((volume) => !volume.readOnly);
    if (writable && this.snapshot.status === "paused")
      throw new Error("Resume and sync writable volumes before resetting this machine.");
    if (writable && this.snapshot.status === "running" && this.snapshot.controlReady) {
      const generation = this.generation;
      await this.syncVolumes((command) => this.controlCommand(command, generation, 30_000));
    }
    await this.destroy();
    await this.boot();
  };

  save = async (): Promise<ArrayBuffer> => {
    this.requireNoEvidenceTask();
    if (this.volumeAttachments.length)
      throw new Error("VM checkpoints do not include external durable disks. Stop the machine and preserve independent volume snapshots instead.");
    if (this.evidenceArchive)
      throw new Error(
        "Analyst attachments are external read-only views. Export their evidence archive; this machine cannot produce a complete checkpoint.",
      );
    const emulator = this.emulator;
    if (!emulator || !["running", "paused"].includes(this.snapshot.status))
      throw new Error("Boot Linux before creating a checkpoint.");
    if (this.checkpointBusy)
      throw new Error("Another checkpoint operation is already running.");
    this.checkpointBusy = true;
    this.networkPort?.setReady(false);
    this.update({ operation: "saving" });
    const generation = this.generation;
    const wasRunning = this.snapshot.status === "running";
    try {
      await emulator.stop();
      return await emulator.save_state();
    } finally {
      try {
        if (wasRunning && generation === this.generation) {
          await emulator.run();
          this.networkPort?.setReady(true);
        }
      } catch (error: unknown) {
        if (generation === this.generation)
          this.update({
            status: "error",
            message: `The machine could not resume after saving: ${errorMessage(error)}. Reset to retry.`,
          });
        throw error;
      } finally {
        this.checkpointBusy = false;
        this.update({ operation: null });
      }
    }
  };

  restore = async (
    buffer: ArrayBuffer,
    options: RestoreOptions = {},
  ): Promise<void> => {
    this.requireNoEvidenceTask();
    if (this.volumeAttachments.length)
      throw new Error("Detach external volumes before restoring a VM checkpoint. Memory rollback must not be combined with a different disk state.");
    if (this.evidenceArchive)
      throw new Error(
        "Restore checkpoints into a separate machine. This analyst has an external evidence attachment.",
      );
    // Invalid files are rejected before stopping or replacing the live guest.
    validateSnapshot(buffer);
    const original = buffer.slice(0);
    if (this.checkpointBusy)
      throw new Error("Another checkpoint operation is already running.");
    if (
      this.bootPromise ||
      ["loading", "booting"].includes(this.snapshot.status)
    )
      throw new Error("Wait for Linux to finish booting before restoring.");
    this.checkpointBusy = true;
    this.networkPort?.setReady(false);
    this.update({
      operation: "restoring",
      controlReady: false,
      init: {
        status: "skipped",
        output: "",
        exitCode: null,
        message: "Snapshot restore does not replay the init script.",
      },
    });
    let emulator: V86 | null = null;
    let generation = this.generation;
    try {
      const sourceCheckpointSha256 = await sha256Bytes(original);
      if (options.paused) {
        await this.bootMachine(true, original);
        generation = this.generation;
        this.update({ sourceCheckpointSha256 });
        return;
      }
      if (!this.emulator || this.snapshot.status === "error")
        await this.bootMachine(true);
      generation = this.generation;
      emulator = this.emulator;
      if (!emulator || !["running", "paused"].includes(this.snapshot.status))
        throw new Error("Wait for Linux to finish booting before restoring.");
      await emulator.stop();
      await emulator.restore_state(original);
      if (generation !== this.generation)
        throw new DOMException("Restore cancelled.", "AbortError");
      // Terminal display history is not part of the machine checkpoint. Do not
      // replay output from the discarded future into a newly mounted console.
      this.clearDisplay();
      await emulator.run();
      await this.prepareGuestServices(generation, true);
      this.update({
        status: "running",
        controlReady: true,
        passiveRestore: false,
        sourceCheckpointSha256,
        message:
          "Checkpoint restored. Machine addressing is repaired; the init script was not replayed.",
        startedAt: Date.now(),
      });
      emulator.serial0_send("\n");
    } catch (error: unknown) {
      if (generation === this.generation) {
        this.detachEmulatorListeners?.();
        this.detachEmulatorListeners = null;
        this.networkPort?.detach();
        this.emulator = null;
        if (emulator) await emulator.destroy().catch(() => undefined);
        this.update({
          status: "error",
          controlReady: false,
          message: `Could not restore this checkpoint: ${errorMessage(error)}. Reset to boot a fresh machine.`,
        });
      }
      throw error;
    } finally {
      this.checkpointBusy = false;
      this.update({ operation: null });
    }
  };

  destroy = async (): Promise<void> => {
    if (this.destroyPromise) return this.destroyPromise;
    if (!this.volumeShutdownPrepared) this.requireNoEvidenceTask();
    if (this.checkpointBusy)
      throw new Error("Wait for the current checkpoint operation to finish.");
    // Publish a lifecycle gate before any idle event. A newly mounted display
    // or bridge observer must not boot another VM while the old disk session
    // is draining. Repeated destroy calls join the same teardown.
    const task = Promise.resolve().then(() => this.destroyMachine()).finally(() => {
      this.destroyPromise = null;
      this.volumeShutdownPrepared = false;
      this.volumeTaskBusy = false;
      this.update({ operation: null, volumeOperation: null });
    });
    this.destroyPromise = task;
    this.volumeTaskBusy = true;
    this.update({ operation: null, volumeOperation: "detaching" });
    return task;
  };

  private destroyMachine = async (): Promise<void> => {
    const wasLoading = this.snapshot.status === "loading";
    const generation = ++this.generation;
    this.downloadController?.abort();
    this.downloadController = null;
    this.cancelBoot?.();
    this.cancelBoot = null;
    this.bootPromise = null;
    this.clearBootTimer();
    this.detachEmulatorListeners?.();
    this.detachEmulatorListeners = null;
    this.networkPort?.detach();
    this.clearDisplay();
    const emulator = this.emulator;
    this.emulator = null;
    this.restoredNeedsSetup = false;
    this.update({
      status: "idle",
      controlReady: false,
      passiveRestore: false,
      sourceCheckpointSha256: undefined,
      message: "Ready to boot a local Linux kernel.",
      downloadProgress: null,
      startedAt: null,
      sessions: INTERACTIVE_SERIAL_PORTS.map((port) => ({
        port,
        title: `Shell ${port}`,
        status: "unavailable",
      })),
    });
    try {
      if (emulator) {
        await emulator.stop().catch(() => undefined);
        try { await this.closeVolumes(); }
        finally {
          await emulator.destroy().catch((error: unknown) => {
            // The retained readiness callback will finish disposal in this case.
            if (!wasLoading) throw error;
          });
        }
      } else {
        await this.closeVolumes();
      }
    } finally {
      if (generation === this.generation)
        this.update({
          status: "idle",
          message: "Ready to boot a local Linux kernel.",
          downloadProgress: null,
          startedAt: null,
        });
    }
  };
}

export const runtime = new LinuxRuntime();
