// SPDX-License-Identifier: Apache-2.0
import { LinuxRuntime } from "./linux-runtime";
import { TinyEmuRuntime } from "./tinyemu-runtime";
import { QemuRuntime } from "./qemu-runtime";
import { DEFAULT_QEMU_BUNDLE_ID } from "./qemu-assets";
import { defaultX86MachineConfiguration, validateX86MachineConfiguration, type X86MachineConfiguration } from "./x86-machine-config";
import { withMachineImageLease, readMachineImage } from "./machine-image-store";
import { CommandRunner, type RunnerState } from "./agent-bridge";
import type {
  MachineRuntime,
  RuntimeSnapshot,
  SerialPort,
} from "./runtime-types";
import { MAX_CHECKPOINT_BYTES, inspectCheckpoint } from "./checkpoint-format";
import {
  VirtualNetwork,
  type NetworkMode,
  type NetworkTransport,
} from "./network";
import {
  validateInitScript,
  validateMachineName,
  type MachineConfig,
  type MachineProfile,
} from "./machine-config";
import { RUNTIME_PROFILES, isQemuProfileId, isTinyEmuProfileId } from "./runtime-profiles";
import {
  firstAvailableIp,
  type VpcConfig,
  type SubnetConfig,
  type NetworkAttachment,
} from "./vpc-config";
import { ALLOW_ALL_POLICY, type NetworkPolicy } from "./network-policy";
import type { EvidenceArchive } from "./evidence";
import type { SnapshotMeta } from "./snapshots";
import type { VolumeAttachment } from "./volume-types";
import { registerVolumeDeletionGuard, recoverVolumeCopies } from "./volume-store";
import { acquireResourceReloadGuard } from "./resource-events";
import { commitWorkspaceManifest, loadWorkspaceManifest, WORKSPACE_LOCK, WORKSPACE_STORAGE_KEY, type MachineActivity, type PersistenceState, type WorkspaceManifest } from "./workspace-persistence";

type VolumeRuntime = MachineRuntime & Required<Pick<MachineRuntime,
  "attachVolume" | "detachVolume" | "getVolumeAttachments" | "syncVolumes" | "prepareVolumeShutdown"
>>;
function requireVolumeRuntime(runtime: MachineRuntime): VolumeRuntime {
  if (!runtime.capabilities.volumes || !runtime.attachVolume || !runtime.detachVolume ||
      !runtime.getVolumeAttachments || !runtime.syncVolumes || !runtime.prepareVolumeShutdown)
    throw new Error("This machine profile does not support durable data disks.");
  return runtime as VolumeRuntime;
}

export const PROFILES = Object.fromEntries(
  Object.entries(RUNTIME_PROFILES).map(([id, profile]) => [
    id,
    {
      title: profile.label,
      architecture: `${profile.architecture} · ${profile.bits}-bit`,
      description: profile.description,
      memory: profile.memoryMiB,
      download: profile.downloadLabel,
    },
  ]),
) as Record<
  MachineProfile,
  {
    title: string;
    architecture: string;
    description: string;
    memory: number;
    download: string;
  }
>;

export interface InvestigationSource {
  snapshotId?: string;
  title: string;
  sha256: string;
}
interface MountOptions {
  investigation?: InvestigationSource;
  evidence?: EvidenceArchive;
}

export interface ManagedMachine {
  id: string;
  name: string;
  config: MachineConfig;
  runtime: MachineRuntime;
  runner: CommandRunner;
  setInitScript(script: string): void;
  resizeTerminal(port: SerialPort, columns: number, rows: number): void;
  cancelBoot(): Promise<void>;
  port: ReturnType<VirtualNetwork["createPort"]>;
  unsubscribe: (() => void)[];
  ephemeral: boolean;
  lifecycle: "ready" | "stopping" | "deleting";
  assertAvailable(): void;
  investigation?: InvestigationSource;
  evidence?: EvidenceArchive;
}

export interface MachineSummary {
  id: string;
  name: string;
  config: MachineConfig;
  state: RuntimeSnapshot;
  capabilities: MachineRuntime["capabilities"];
  runner: RunnerState;
  network: ReturnType<ManagedMachine["port"]["getSnapshot"]>;
  terminalResizeError: string | null;
  ephemeral: boolean;
  lifecycle: ManagedMachine["lifecycle"];
  investigation?: InvestigationSource;
  evidenceTitle?: string;
}

export interface WorkspaceSnapshot {
  activeId: string;
  machines: MachineSummary[];
  storageAvailable: boolean;
  vpcs: VpcConfig[];
  persistence: PersistenceState;
  recovery: MachineActivity[];
  preparingReload: boolean;
}

/** Machines outlive panels. Selecting another tab never recreates a guest. */
export class MachineWorkspace {
  private readonly network: VirtualNetwork;
  private entries = new Map<string, ManagedMachine>();
  private listeners = new Set<(state: WorkspaceSnapshot) => void>();
  private activeId = "";
  private storageAvailable = true;
  private terminalSizes = new Map<
    string,
    Map<SerialPort, { columns: number; rows: number }>
  >();
  private appliedSizes = new Map<string, Map<SerialPort, string>>();
  private resizeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private resizeErrors = new Map<string, string>();
  private readonly storage = {
    getItem: (key: string) => globalThis.localStorage.getItem(key),
    setItem: (key: string, value: string) => globalThis.localStorage.setItem(key, value),
  };
  private manifest: WorkspaceManifest;
  private persistence: PersistenceState;
  private activity = new Map<string, MachineActivity>();
  private recovery = new Map<string, MachineActivity>();
  private initializing = true;
  private preparingReload = false;
  private ownershipAttempt: Promise<void> | null = null;
  private releaseOwnership: (() => void) | null = null;
  private pendingAttachments = new Map<string, Set<string>>();
  private deletingVolumes = new Set<string>();
  private reloadGuards = new Set<() => void>();

  constructor() {
    const loaded = loadWorkspaceManifest(this.storage);
    this.manifest = loaded.manifest;
    this.persistence = { mode: loaded.error ? "error" : "opening", error: loaded.error, revision: loaded.manifest.revision, updatedAt: loaded.manifest.updatedAt || null };
    this.storageAvailable = !loaded.error;
    this.network = new VirtualNetwork({ vpcs: loaded.manifest.vpcs });
    this.activity = new Map(loaded.manifest.activity.map((item) => [item.id, item]));
    this.recovery = new Map(this.activity);
    for (const config of loaded.manifest.machines) this.mount(config);
    this.activeId = loaded.manifest.activeId || this.entries.keys().next().value || "";
    this.initializing = false;
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      void this.takeControl().catch(() => {});
    } else if (!loaded.error) {
      // The headless integration harness has no page lifecycle. Browser pages
      // always acquire the cross-tab owner lock before permitting mutations.
      this.persistence.mode = "writable";
    }
  }

  assertWritable = (): void => {
    if (this.persistence.mode !== "writable") throw new Error(this.persistence.error || "This tab is opening the workspace. Wait for ownership before changing resources.");
    if (this.preparingReload) throw new Error("The workspace is preparing a safe reload. Wait for it to finish.");
  };

  private assertEntryAvailable(entry: ManagedMachine): void {
    this.assertWritable();
    if (this.entries.get(entry.id) !== entry) throw new Error("This machine was deleted. Create or select an existing machine.");
    if (entry.lifecycle !== "ready") throw new Error(`Wait for ${entry.name} to finish ${entry.lifecycle === "deleting" ? "deleting" : "stopping or updating"}.`);
  }

  takeControl = (): Promise<void> => {
    if (this.ownershipAttempt) return this.ownershipAttempt;
    if (this.persistence.mode === "writable") return Promise.resolve();
    const adopt = () => {
      const loaded = loadWorkspaceManifest(this.storage);
      if (loaded.error) throw new Error(loaded.error);
      if (loaded.manifest.revision !== this.manifest.revision) {
        if (this.list().some((entry) => entry.runtime.getSnapshot().status !== "idle" || entry.lifecycle !== "ready"))
          throw new Error("A newer workspace is saved. Stop the machines in this tab before taking control.");
        this.initializing = true;
        for (const entry of this.list()) this.forget(entry);
        for (const vpc of this.network.listVpcs()) {
          for (const subnet of vpc.subnets) this.network.removeSubnet(vpc.id, subnet.id);
          this.network.removeVpc(vpc.id);
        }
        for (const vpc of loaded.manifest.vpcs) this.network.addVpc(vpc);
        this.manifest = loaded.manifest;
        this.activity = new Map(loaded.manifest.activity.map((item) => [item.id, item]));
        this.recovery = new Map(this.activity);
        for (const config of loaded.manifest.machines) this.mount(config);
        this.activeId = loaded.manifest.activeId;
        this.initializing = false;
      }
      this.persistence.mode = "writable";
      this.persistence.error = null;
      this.persist();
    };
    if (this.releaseOwnership) {
      return recoverVolumeCopies().then(adopt).catch(error => { this.persistenceError(error); throw error; });
    }
    if (!globalThis.navigator?.locks) {
      const error = new Error("This browser cannot safely coordinate workspace ownership. Use a current browser over HTTPS with Web Locks support.");
      this.persistenceError(error);
      return Promise.reject(error);
    }
    this.persistence = { ...this.persistence, mode: "opening", error: null };
    this.publish();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.ownershipAttempt = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void navigator.locks.request(WORKSPACE_LOCK, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        this.persistence = { ...this.persistence, mode: "read-only", error: "Another Terrarium tab owns this workspace. Close that tab, then choose Take control here." };
        this.publish();
        reject(new Error(this.persistence.error!));
        return;
      }
      const held = new Promise<void>((release) => { this.releaseOwnership = release; });
      try { await recoverVolumeCopies(); adopt(); resolve(); } catch (error) { this.persistenceError(error); reject(error); }
      await held;
      this.releaseOwnership = null;
    }).catch((error) => { this.persistenceError(error); reject(error); });
    const attempt = this.ownershipAttempt;
    void attempt.finally(() => { this.ownershipAttempt = null; }).catch(() => {});
    return attempt;
  };

  private persistenceError(error: unknown): void {
    this.storageAvailable = false;
    this.persistence = { ...this.persistence, mode: "error", error: error instanceof Error ? error.message : String(error) };
    this.publish();
  }

  exportManifest = (): string => this.storage.getItem(WORKSPACE_STORAGE_KEY) ?? JSON.stringify(this.manifest, null, 2);

  acknowledgeRecovery = (id: string): void => {
    this.assertWritable(); this.get(id);
    const previous = this.activity.get(id);
    this.activity.delete(id);
    try { this.persist(); this.recovery.delete(id); this.publish(); }
    catch (error) { if (previous) this.activity.set(id, previous); throw error; }
  };

  guardVolumeDeletion = (id: string): (() => void) => {
    this.assertWritable();
    const attached = this.list().filter((entry) => entry.config.volumes.some((volume) => volume.id === id));
    if (attached.length) throw new Error(`Detach this disk from ${attached.map((entry) => entry.name).join(", ")} before deleting it. Stopped machines still retain their attachments.`);
    if (this.pendingAttachments.has(id) || this.deletingVolumes.has(id)) throw new Error("This disk already has a pending attachment or deletion. Wait for it to finish.");
    this.deletingVolumes.add(id);
    return () => { this.deletingVolumes.delete(id); };
  };

  registerReloadGuard = (guard: () => void): (() => void) => {
    this.reloadGuards.add(guard);
    return () => { this.reloadGuards.delete(guard); };
  };

  prepareReload = async (): Promise<void> => {
    this.assertWritable();
    if (this.pendingAttachments.size || this.deletingVolumes.size) throw new Error("Wait for pending disk attachment or deletion operations before reloading.");
    for (const guard of this.reloadGuards) guard();
    for (const entry of this.list()) this.checkStop(entry);
    const releaseResourceGuard = acquireResourceReloadGuard();
    this.preparingReload = true; this.publish();
    try {
      for (const entry of this.list()) await this.stopEntry(entry);
      this.persist();
    } finally { releaseResourceGuard(); this.preparingReload = false; this.publish(); }
  };

  private mount(
    config: MachineConfig,
    options: MountOptions = {},
  ): ManagedMachine {
    const port = this.network.createPort(config.id, config.ip, {
      hostname: config.name,
      vpcId: config.vpcId,
      subnetId: config.subnetId,
      quarantined: Boolean(options.investigation),
    });
    let runtime: MachineRuntime;
    try {
      if (config.profile === "x86") {
        runtime = new LinuxRuntime({
          initScript: config.initScript,
          networkPort: port,
          volumes: config.volumes,
        });
      } else if (isTinyEmuProfileId(config.profile)) {
        runtime = new TinyEmuRuntime({
          profileId: config.profile,
          initScript: config.initScript,
          networkPort: port,
        });
      } else if (isQemuProfileId(config.profile)) {
        runtime = new QemuRuntime({
          profileId: config.profile,
          initScript: config.initScript,
          networkPort: port,
          volumes: config.volumes,
          machine: config.x86,
        });
      } else {
        throw new Error("This machine profile has no runtime implementation.");
      }
      if (!options.investigation && config.networkTransport === "wisp")
        port.configureTransport({ kind: "wisp", relayUrl: config.relayUrl });
      if (!options.investigation) {
        port.setPolicy(config.policy);
        port.setMode(config.network);
      }
    } catch (error) {
      // Constructors have not booted a guest. Release the reserved attachment
      // if profile or network configuration rejects this mount.
      port.dispose();
      throw error;
    }
    const entry: ManagedMachine = {
      id: config.id,
      name: config.name,
      config: { ...config },
      runtime,
      runner: new CommandRunner(runtime),
      setInitScript: (script) =>
        this.configure(config.id, { initScript: script }),
      resizeTerminal: (port, columns, rows) =>
        this.resizeTerminal(config.id, port, columns, rows),
      cancelBoot: () => this.stop(config.id),
      port,
      unsubscribe: [],
      ephemeral: Boolean(options.investigation || options.evidence),
      lifecycle: "ready",
      assertAvailable: () => this.assertEntryAvailable(entry),
      ...options,
    };
    this.entries.set(entry.id, entry);
    // A retained facade must never resurrect a deleted guest or race teardown.
    const boot = runtime.boot, reset = runtime.reset, pause = runtime.pause, resume = runtime.resume, save = runtime.save, restore = runtime.restore;
    runtime.boot = () => { entry.assertAvailable(); return boot(); };
    runtime.reset = () => { entry.assertAvailable(); return reset(); };
    runtime.pause = () => { entry.assertAvailable(); return pause(); };
    runtime.resume = () => { entry.assertAvailable(); return resume(); };
    runtime.save = () => { entry.assertAvailable(); return save(); };
    runtime.restore = (buffer, options) => { entry.assertAvailable(); return restore(buffer, options); };
    const send = runtime.send;
    runtime.send = (text, serial = 0) => {
      if (this.entries.get(entry.id) !== entry || (serial !== 0 && (entry.lifecycle !== "ready" || this.preparingReload))) return;
      send(text, serial);
    };
    entry.unsubscribe = [
      runtime.subscribe((state) => {
        if (
          state.status === "idle" ||
          state.status === "loading" ||
          state.operation === "restoring"
        )
          this.appliedSizes.delete(entry.id);
        if (!this.initializing && !entry.ephemeral && this.persistence.mode === "writable" && state.status !== "idle") {
          const previous = this.activity.get(entry.id);
          if (state.status !== (previous?.status ?? "idle")) {
            this.activity.set(entry.id, { id: entry.id, status: state.status, updatedAt: Date.now() });
            this.recovery.delete(entry.id);
            try { this.persist(); } catch { /* The durable warning remains visible. */ }
          }
        }
        this.publish();
        this.scheduleResize(entry.id);
      }),
      entry.runner.subscribe(() => {
        this.publish();
        this.scheduleResize(entry.id);
      }),
      port.subscribe(() => this.publish()),
    ];
    return entry;
  }

  get = (id: string): ManagedMachine => {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("That machine is no longer in this workspace.");
    return entry;
  };
  active = (): ManagedMachine => {
    if (!this.activeId) throw new Error("The workspace has no machine. Create one before using the active-machine API.");
    return this.get(this.activeId);
  };
  list = (): ManagedMachine[] => [...this.entries.values()];
  getSnapshot = (): WorkspaceSnapshot => ({
    activeId: this.activeId,
    storageAvailable: this.storageAvailable,
    persistence: { ...this.persistence },
    recovery: [...this.recovery.values()].map((entry) => ({ ...entry })),
    preparingReload: this.preparingReload,
    vpcs: this.network.listVpcs(),
    machines: this.list().map((entry) => ({
      id: entry.id,
      name: entry.name,
      config: { ...entry.config },
      capabilities: entry.runtime.capabilities,
      state: entry.runtime.getSnapshot(),
      runner: entry.runner.getState(),
      network: entry.port.getSnapshot(),
      terminalResizeError: this.resizeErrors.get(entry.id) ?? null,
      ephemeral: entry.ephemeral,
      lifecycle: entry.lifecycle,
      investigation: entry.investigation,
      evidenceTitle: entry.evidence?.title,
    })),
  });
  subscribe = (listener: (state: WorkspaceSnapshot) => void): (() => void) => {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(): void {
    if (!this.listeners.size) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        /* UI observers cannot interrupt guests. */
      }
    }
  }
  private persist(options: { excludeMachine?: string; vpcs?: VpcConfig[] } = {}): void {
    const machines = this.list().filter((entry) => !entry.ephemeral && entry.id !== options.excludeMachine).map((entry) => entry.config);
    try {
      this.manifest = commitWorkspaceManifest(this.storage, this.manifest, {
        machines,
        vpcs: options.vpcs ?? this.network.listVpcs(),
        activeId: machines.some((entry) => entry.id === this.activeId) ? this.activeId : machines[0]?.id ?? "",
        activity: [...this.activity.values()].filter((activity) => machines.some((entry) => entry.id === activity.id)),
      });
      this.storageAvailable = true;
      this.persistence = { mode: "writable", error: null, revision: this.manifest.revision, updatedAt: this.manifest.updatedAt };
      this.publish();
    } catch (error) { this.persistenceError(error); throw error; }
  }
  select = (id: string): void => {
    this.get(id);
    this.activeId = id;
    if (this.persistence.mode === "writable") { try { this.persist(); } catch { /* Selection can remain local when storage is full. */ } }
    else this.publish();
  };

  add = (
    name: string,
    profile: MachineProfile,
    initScript = "",
    attachment?: Omit<NetworkAttachment, "ip"> & { ip?: string },
    options: MountOptions = {},
  ): ManagedMachine => {
    return this.addDefinition(name, profile, initScript, attachment, options);
  };

  private addDefinition(
    name: string, profile: MachineProfile, initScript = "", attachment?: Omit<NetworkAttachment, "ip"> & { ip?: string },
    options: MountOptions = {}, machine?: X86MachineConfiguration,
  ): ManagedMachine {
    this.assertWritable();
    const cleanName = validateMachineName(name);
    if (this.list().some((entry) => entry.name === cleanName))
      throw new Error("Choose a unique machine name.");
    if (machine && !options.investigation && this.list().some(entry => !entry.investigation && entry.config.x86?.nic.mac === machine.nic.mac))
      throw new Error("Another saved x86_64 machine already owns this NIC identity.");
    const vpcs = this.network.listVpcs();
    const vpc = attachment
      ? vpcs.find((item) => item.id === attachment.vpcId)
      : vpcs.find((candidate) => candidate.subnets.length > 0);
    if (!vpc || !vpc.subnets.length) throw new Error("Create a VPC and a subnet in Connections before creating a machine.");
    const subnetId = attachment?.subnetId ?? vpc.subnets[0].id;
    const ip =
      attachment?.ip ||
      firstAvailableIp(
        vpc,
        subnetId,
        this.list()
          .filter(
            (entry) => entry.config.vpcId === vpc.id && !entry.investigation,
          )
          .map((entry) => entry.config.ip),
      );
    const entry = this.mount(
      {
        id: crypto.randomUUID(),
        name: cleanName,
        profile,
        ip,
        vpcId: vpc.id,
        subnetId,
        policy: structuredClone(ALLOW_ALL_POLICY),
        initScript: validateInitScript(initScript),
        network: "isolated",
        networkTransport: "web",
        relayUrl: "",
        volumes: [],
        ...(isQemuProfileId(profile) ? { x86: machine ?? defaultX86MachineConfiguration({ runtimeBundleId: DEFAULT_QEMU_BUNDLE_ID }) } : {}),
      },
      options,
    );
    const priorActiveId = this.activeId;
    this.activeId = entry.id;
    try { this.persist(); }
    catch (error) { this.forget(entry); this.activeId = priorActiveId; this.publish(); throw error; }
    return entry;
  }

  private async withVerifiedMachine<T>(configuration: X86MachineConfiguration, commit: (configuration: X86MachineConfiguration) => T): Promise<T> {
    this.assertWritable();
    const next = validateX86MachineConfiguration(configuration);
    if (next.image.kind === "builtin") return commit(next);
    return withMachineImageLease(next.image.id, async () => {
      const image = await readMachineImage(next.image.id);
      if ((next.kernelSettings.hostname ?? "terrarium") !== image.manifest.boot.hostname)
        throw new Error("The configuration hostname must match the verified custom image manifest.");
      this.assertWritable();
      return commit(next);
    });
  }

  addConfigured = async (
    name: string, profile: MachineProfile, initScript = "", attachment?: Omit<NetworkAttachment, "ip"> & { ip?: string }, machine?: X86MachineConfiguration,
  ): Promise<ManagedMachine> => {
    if (!machine) return this.add(name, profile, initScript, attachment);
    if (!isQemuProfileId(profile)) throw new Error("Hardware presets and custom Linux images require the x86_64 profile.");
    return this.withVerifiedMachine(machine, next => this.addDefinition(name, profile, initScript, attachment, {}, next));
  };

  configureMachine = async (id: string, patch: { machine: X86MachineConfiguration; name?: string; initScript?: string }): Promise<void> => {
    // Capture the instance identity before asynchronous image validation. A
    // retained request cannot update a replacement definition with the same ID.
    const original = this.get(id); original.assertAvailable();
    if (!(original.runtime instanceof QemuRuntime)) throw new Error("Only x86_64 machines have this hardware configuration.");
    original.runtime.assertMachineConfigurationMutable();
    await this.withVerifiedMachine(patch.machine, next => {
      original.assertAvailable();
      if (this.get(id) !== original || !(original.runtime instanceof QemuRuntime)) throw new Error("The destination machine changed during image validation.");
      original.runtime.assertMachineConfigurationMutable();
      if (original.runner.isBusy()) throw new Error("Wait for the machine's command before changing its definition.");
      const name = patch.name === undefined ? original.name : validateMachineName(patch.name);
      if (this.list().some(entry => entry.id !== id && entry.name === name)) throw new Error("Choose a unique machine name.");
      if (this.list().some(entry => entry.id !== id && !entry.investigation && entry.config.x86?.nic.mac === next.nic.mac))
        throw new Error("Another saved x86_64 machine already owns this NIC identity.");
      const initScript = patch.initScript === undefined ? original.config.initScript : validateInitScript(patch.initScript);
      const previous = original.config;
      const replacement = { ...previous, name, initScript, x86: next };
      // No runtime mutation or notification occurs before this atomic saved write.
      original.lifecycle = "stopping";
      original.config = replacement;
      try {
        try { this.persist(); }
        catch (error) { original.config = previous; throw error; }
        original.runtime.setMachineConfiguration(next);
        original.runtime.setInitScript(initScript); original.port.setHostname(name); original.name = name;
      } finally { original.lifecycle = "ready"; this.publish(); }
    });
  };

  assertImageUnreferenced = (id: string): void => {
    this.assertWritable();
    const saved = loadWorkspaceManifest(this.storage);
    if (saved.error) throw new Error(`Cannot delete an image while workspace metadata is invalid: ${saved.error}`);
    const references = [...this.list().map(entry => entry.config), ...saved.manifest.machines]
      .filter(config => config.x86?.image.kind === "custom" && config.x86.image.id === id);
    if (references.length) throw new Error(`This image is referenced by ${[...new Set(references.map(config => config.name))].join(", ")}. Change or delete those definitions first; stopped machines retain image dependencies.`);
  };

  addVpc = (config: VpcConfig): void => {
    this.assertWritable();
    this.network.addVpc(config);
    try { this.persist(); } catch (error) {
      for (const subnet of config.subnets) this.network.removeSubnet(config.id, subnet.id);
      this.network.removeVpc(config.id); this.publish(); throw error;
    }
  };
  removeVpc = (id: string): void => {
    this.assertWritable();
    const before = this.network.listVpcs().find((vpc) => vpc.id === id);
    this.network.removeVpc(id);
    try { this.persist(); } catch (error) { if (before) this.network.addVpc(before); this.publish(); throw error; }
  };

  updateVpc = (id: string, patch: { name: string }): void => {
    this.assertWritable();
    this.network.updateVpc(id, patch); this.persist();
  };
  addSubnet = (vpcId: string, subnet: SubnetConfig): void => {
    this.assertWritable();
    this.network.addSubnet(vpcId, subnet); this.persist();
  };
  updateSubnet = (vpcId: string, subnetId: string, patch: Partial<Pick<SubnetConfig, "name" | "cidr">>): void => {
    this.assertWritable();
    this.network.updateSubnet(vpcId, subnetId, patch); this.persist();
  };
  removeSubnet = (vpcId: string, subnetId: string): void => {
    this.assertWritable();
    const before = this.network.listVpcs().find((vpc) => vpc.id === vpcId)?.subnets.find((subnet) => subnet.id === subnetId);
    this.network.removeSubnet(vpcId, subnetId);
    try { this.persist(); } catch (error) { if (before) this.network.addSubnet(vpcId, before); this.publish(); throw error; }
  };

  attachVolume = async (id: string, attachment: VolumeAttachment): Promise<void> => {
    const entry = this.get(id);
    entry.assertAvailable();
    const runtime = requireVolumeRuntime(entry.runtime);
    if (this.deletingVolumes.has(attachment.id)) throw new Error("This disk is being deleted. Wait for that operation to finish.");
    const claims = this.pendingAttachments.get(attachment.id) ?? new Set<string>();
    claims.add(id); this.pendingAttachments.set(attachment.id, claims);
    entry.lifecycle = "stopping"; this.publish();
    const oldConfig = entry.config;
    try {
      await runtime.attachVolume(attachment);
      entry.config = { ...entry.config, volumes: [...runtime.getVolumeAttachments()] };
      try { this.persist(); } catch (error) { await runtime.detachVolume(attachment.slot); entry.config = oldConfig; throw error; }
    } finally {
      claims.delete(id); if (!claims.size) this.pendingAttachments.delete(attachment.id);
      entry.lifecycle = "ready"; this.publish();
    }
  };
  detachVolume = async (id: string, slot: 0 | 1): Promise<void> => {
    const entry = this.get(id);
    entry.assertAvailable();
    const runtime = requireVolumeRuntime(entry.runtime);
    entry.lifecycle = "stopping"; this.publish();
    const oldConfig = entry.config;
    const oldAttachment = oldConfig.volumes.find((attachment) => attachment.slot === slot);
    try {
      await runtime.detachVolume(slot);
      entry.config = { ...entry.config, volumes: [...runtime.getVolumeAttachments()] };
      try { this.persist(); } catch (error) { if (oldAttachment) await runtime.attachVolume(oldAttachment); entry.config = oldConfig; throw error; }
    } finally { entry.lifecycle = "ready"; this.publish(); }
  };
  syncVolumes = async (id: string): Promise<void> => {
    const entry = this.get(id);
    entry.assertAvailable();
    const runtime = requireVolumeRuntime(entry.runtime);
    if (entry.runner.isBusy()) throw new Error("Wait for this machine's command to finish before syncing volumes.");
    await runtime.syncVolumes((command) => entry.runner.executeInternal(command, { timeoutMs: 60_000 }));
  };
  stop = async (id: string): Promise<void> => {
    const entry = this.get(id);
    entry.assertAvailable();
    this.checkStop(entry);
    entry.lifecycle = "stopping"; this.publish();
    try { await this.stopEntry(entry); }
    finally { entry.lifecycle = "ready"; this.publish(); }
  };
  private checkStop(entry: ManagedMachine): void {
    const state = entry.runtime.getSnapshot();
    const booting = ["loading", "booting"].includes(state.status);
    if (entry.lifecycle !== "ready" || entry.runner.isBusy() || state.operation || state.acquiringEvidence || state.volumeOperation || (booting && !entry.runtime.capabilities.cancelBoot))
      throw new Error(`Wait for ${entry.name}'s command, boot, checkpoint, evidence, or disk operation to finish.`);
    if (entry.config.volumes.some((attachment) => !attachment.readOnly) && state.status === "paused")
      throw new Error(`Resume ${entry.name} before stopping or deleting it so its writable disks can be synced.`);
  }
  private async stopEntry(entry: ManagedMachine): Promise<void> {
    const state = entry.runtime.getSnapshot();
    if (entry.config.volumes.some((attachment) => !attachment.readOnly)) {
      if (state.status === "running")
        await requireVolumeRuntime(entry.runtime).prepareVolumeShutdown((command) => entry.runner.executeInternal(command, { timeoutMs: 60_000 }));
    }
    await entry.runtime.destroy();
    this.appliedSizes.delete(entry.id);
    this.activity.delete(entry.id); this.recovery.delete(entry.id);
    this.persist();
    this.publish();
  }

  configureAttachment = (id: string, attachment: NetworkAttachment): void => {
    const entry = this.get(id);
    entry.assertAvailable();
    if (
      !["idle", "error"].includes(entry.runtime.getSnapshot().status) ||
      entry.runner.isBusy()
    )
      throw new Error(
        "Choose the network before booting. Create another machine to move a running guest.",
      );
    entry.port.configureAttachment(attachment);
    entry.config = { ...entry.config, ...attachment, network: "isolated" };
    this.persist();
  };

  setPolicy = (id: string, policy: NetworkPolicy): void => {
    const entry = this.get(id);
    entry.assertAvailable();
    entry.port.setPolicy(policy);
    entry.config = { ...entry.config, policy: entry.port.getSnapshot().policy };
    this.persist();
  };

  private availableName(prefix: string): string {
    let number = 1;
    while (this.list().some((entry) => entry.name === `${prefix}-${number}`))
      number++;
    return `${prefix}-${number}`;
  }

  createInvestigation = async (
    buffer: ArrayBuffer,
    meta: Pick<SnapshotMeta, "title"> & { id?: string },
  ): Promise<ManagedMachine> => {
    if (
      !(buffer instanceof ArrayBuffer) ||
      buffer.byteLength === 0 ||
      buffer.byteLength > MAX_CHECKPOINT_BYTES
    )
      throw new Error(
        "Choose a complete checkpoint within its runtime's supported import limit.",
      );
    // Hash and restore the same bounded, private copy. The caller cannot alter
    // the recorded source state while hashing or asynchronous restore runs.
    const preserved = buffer.slice(0);
    const inspection = await inspectCheckpoint(preserved);
    const sha256 = inspection.sha256;
    const entry = this.add(
      this.availableName("quarantine"),
      inspection.profileId,
      "",
      undefined,
      { investigation: { snapshotId: meta.id, title: meta.title, sha256 } },
    );
    try {
      await entry.runtime.restore(preserved, { paused: true });
      this.publish();
      return entry;
    } catch (error) {
      await this.remove(entry.id);
      throw error;
    }
  };

  createAnalyst = async (archive: EvidenceArchive, profile: MachineProfile = "x86"): Promise<ManagedMachine> => {
    const entry = this.add(
      this.availableName("analyst"),
      profile,
      "",
      undefined,
      { evidence: archive },
    );
    try {
      if (!entry.runtime.capabilities.evidenceMount || !entry.runtime.attachEvidence)
        throw new Error("This profile does not support a host-protected evidence mount.");
      await entry.runtime.attachEvidence(archive);
      await entry.runtime.boot();
      this.publish();
      return entry;
    } catch (error) {
      await this.remove(entry.id);
      throw error;
    }
  };

  configure = (
    id: string,
    patch: { name?: string; initScript?: string },
  ): void => {
    const entry = this.get(id);
    entry.assertAvailable();
    const name =
      patch.name === undefined ? entry.name : validateMachineName(patch.name);
    if (this.list().some((other) => other.id !== id && other.name === name))
      throw new Error("Choose a unique machine name.");
    const initScript =
      patch.initScript === undefined
        ? entry.config.initScript
        : validateInitScript(patch.initScript);
    const previous = entry.config;
    entry.lifecycle = "stopping";
    entry.config = { ...previous, name, initScript };
    try {
      try { this.persist(); } catch (error) { entry.config = previous; throw error; }
      entry.runtime.setInitScript(initScript);
      entry.port.setHostname(name); entry.name = name;
    } finally { entry.lifecycle = "ready"; this.publish(); }
  };

  setNetwork = (id: string, mode: NetworkMode): void => {
    const entry = this.get(id);
    entry.assertAvailable();
    if (entry.runtime.capabilities.network === "none")
      throw new Error("This profile has no connected network adapter.");
    entry.port.setMode(mode);
    // Web access is an explicit decision each time the page opens.
    entry.config = {
      ...entry.config,
      network: mode === "isolated" ? "isolated" : "local",
    };
    this.persist();
  };

  configureNetworkTransport = (
    id: string,
    transport: NetworkTransport,
  ): void => {
    const entry = this.get(id);
    entry.assertAvailable();
    entry.port.configureTransport(transport);
    const selected = entry.port.getSnapshot();
    entry.config = {
      ...entry.config,
      networkTransport: selected.transport,
      relayUrl: selected.relayUrl ?? "",
    };
    this.persist();
  };

  private resizeTerminal(
    id: string,
    port: SerialPort,
    columns: number,
    rows: number,
  ): void {
    const entry = this.entries.get(id);
    // Resize only independent interactive shells, through their dedicated control channel.
    if (
      !entry ||
      entry.lifecycle !== "ready" || this.preparingReload || this.persistence.mode !== "writable" ||
      entry.runtime.capabilities.interactivePorts.includes(0) ||
      !entry.runtime.capabilities.interactivePorts.includes(port) ||
      port === 0 ||
      !Number.isFinite(columns) ||
      !Number.isFinite(rows)
    )
      return;
    const desired =
      this.terminalSizes.get(id) ??
      new Map<SerialPort, { columns: number; rows: number }>();
    desired.set(port, {
      columns: Math.max(10, Math.min(1000, Math.floor(columns))),
      rows: Math.max(3, Math.min(500, Math.floor(rows))),
    });
    this.terminalSizes.set(id, desired);
    this.scheduleResize(id);
  }

  private scheduleResize(id: string): void {
    const entry = this.entries.get(id);
    if (
      !entry ||
      entry.lifecycle !== "ready" || this.preparingReload || this.persistence.mode !== "writable" ||
      !this.terminalSizes.has(id) ||
      this.resizeTimers.has(id) ||
      entry.runtime.getSnapshot().acquiringEvidence ||
      !entry.runner.getState().ready
    )
      return;
    const desired = this.terminalSizes.get(id)!;
    const applied = this.appliedSizes.get(id);
    if (
      ![...desired].some(
        ([port, size]) => applied?.get(port) !== `${size.columns}:${size.rows}`,
      )
    )
      return;
    this.resizeTimers.set(
      id,
      setTimeout(() => {
        this.resizeTimers.delete(id);
        void this.applyTerminalSizes(id);
      }, 120),
    );
  }

  private async applyTerminalSizes(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (
      !entry ||
      !entry.runner.getState().ready ||
      entry.runtime.getSnapshot().acquiringEvidence
    )
      return;
    const desired = this.terminalSizes.get(id);
    if (!desired) return;
    const applied = this.appliedSizes.get(id) ?? new Map<SerialPort, string>();
    const commands: string[] = [];
    for (const [port, size] of desired) {
      const key = `${size.columns}:${size.rows}`;
      if (applied.get(port) === key) continue;
      commands.push(
        `stty -F /dev/ttyS${port} rows ${size.rows} cols ${size.columns} && printf '%s\\n' '${size.rows} ${size.columns}' > /run/terrarium/ttyS${port}.size`,
      );
      // A failure should not cause an endless background retry loop.
      applied.set(port, key);
    }
    if (!commands.length) return;
    this.appliedSizes.set(id, applied);
    try {
      const result = await entry.runner.executeInternal(commands.join(" && "), {
        timeoutMs: 5_000,
      });
      if (result.status !== "exited" || result.exitCode !== 0)
        throw new Error(
          result.message || "Guest terminal dimensions could not be updated.",
        );
      this.resizeErrors.delete(id);
    } catch (error) {
      this.resizeErrors.set(
        id,
        error instanceof Error ? error.message : String(error),
      );
    }
    this.publish();
    this.scheduleResize(id);
  }

  remove = async (id: string): Promise<void> => {
    const entry = this.get(id);
    entry.assertAvailable();
    this.checkStop(entry);
    entry.lifecycle = "deleting"; this.publish();
    try {
      await this.stopEntry(entry);
      // Commit the deletion before removing its in-memory definition. A quota
      // or revision failure leaves a stopped, visible machine to retry safely.
      this.persist({ excludeMachine: id });
      this.forget(entry);
      if (this.activeId === id) this.activeId = this.entries.keys().next().value || "";
      this.publish();
    } catch (error) { entry.lifecycle = "ready"; this.publish(); throw error; }
  };

  private forget(entry: ManagedMachine): void {
    const id = entry.id;
    for (const unsubscribe of entry.unsubscribe) unsubscribe();
    entry.runner.dispose();
    entry.port.dispose();
    clearTimeout(this.resizeTimers.get(id));
    this.resizeTimers.delete(id);
    this.terminalSizes.delete(id);
    this.appliedSizes.delete(id);
    this.resizeErrors.delete(id);
    this.activity.delete(id); this.recovery.delete(id);
    this.entries.delete(id);
  }
}

export const workspace = new MachineWorkspace();
registerVolumeDeletionGuard(workspace.guardVolumeDeletion);
