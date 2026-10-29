// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Box, Braces, CheckCircle2, Cloud, Copy, Database, HardDrive, Layers3, LoaderCircle, Network, Pause, Play, Plus, RefreshCw, Square, Terminal, Trash2, Upload, ShieldCheck, Zap } from "lucide-react";
import type { CloudControlPlane, CloudOperation, CloudVolumeRecord } from "../lib/cloud";
import type { CloudBucket, CloudObjectMetadata } from "../lib/cloud-object-store";
import type { SimulatedFault, SimulatedIdentity } from "../lib/cloud-simulation";
import { MAX_OBJECT_BYTES } from "../lib/cloud-object-store";
import type { MachineSummary, WorkspaceSnapshot } from "../lib/machines";
import { RUNTIME_PROFILES } from "../lib/runtime-profiles";
import { DEFAULT_VOLUME_MIB, MAX_VOLUME_MIB, MIN_VOLUME_MIB } from "../lib/volume-types";
import { subscribeVolumeChanges } from "../lib/volume-store";
import { downloadVolume } from "../lib/volume-download";
import { X86_MACHINE_PRESETS } from "../lib/x86-machine-config";
import { downloadFile } from "../lib/snapshots";
import { Modal } from "./Modal";
import { DeleteResourceDialog, type DeleteResourceRequest } from "./DeleteResourceDialog";

type Tab = "instances" | "volumes" | "objects" | "simulation" | "activity" | "api";
type Notice = { message: string; error: boolean } | null;
type VolumeDialog = { action: "create" | "snapshot" | "clone" | "attach"; source?: CloudVolumeRecord };
const tabs = [
  { id: "instances", label: "Instances", icon: Box },
  { id: "volumes", label: "Volumes", icon: HardDrive },
  { id: "objects", label: "Object storage", icon: Database },
  { id: "simulation", label: "Failure injection", icon: Zap },
  { id: "activity", label: "Activity", icon: Layers3 },
  { id: "api", label: "API", icon: Braces },
] as const;
function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB`;
  return `${bytes} B`;
}
function machineBusy(machine: MachineSummary): boolean {
  return Boolean(machine.lifecycle && machine.lifecycle !== "ready") || machine.runner.busy || Boolean(machine.state.operation || machine.state.acquiringEvidence || machine.state.volumeOperation) || ["loading", "booting"].includes(machine.state.status);
}
function filename(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 100) || "terrarium-data"; }

const cloudExample = `const cloud = window.terrarium.cloud;
const images = await cloud.images.list();

const instance = await cloud.instances.create({
  name: 'worker-01', imageId: 'x86',
  initScript: 'mkdir -p /root/agent-work'
}, { idempotencyKey: 'create-worker-01' }).wait();

await cloud.instances.start(instance.id).wait();
const vm = window.terrarium.get(instance.id);
await vm.exec('uname -a')`;
const volumeExample = `const cloud = window.terrarium.cloud;
const disk = await cloud.volumes.create({
  name: 'case-work', sizeMiB: 16
}).wait();

// Stop discards guest RAM and syncs any data disks.
await cloud.instances.stop(instance.id).wait();
await cloud.instances.attachVolume(instance.id, {
  volumeId: disk.id, slot: 0
}).wait();
await cloud.instances.start(instance.id).wait();
await window.terrarium.get(instance.id).exec(
  'echo evidence > /mnt/volumes/disk0/note.txt; sync'
);

// Stop syncs the writable disk and discards guest RAM.
await cloud.instances.stop(instance.id).wait();
const snapshot = await cloud.volumes.snapshot(disk.id, {
  name: 'case-001'
}).wait();
snapshot`;
const objectExample = `const store = window.terrarium.cloud.objectStore;
await store.buckets.create({ name: 'artifacts' });
const stored = await store.objects.put(
  'artifacts', 'agent/report.txt', 'hello from the agent',
  { contentType: 'text/plain', ifNoneMatch: true }
);
const object = await store.objects.get('artifacts', 'agent/report.txt');
new TextDecoder().decode(object.body)`;
const simulationExample = `const cloud = window.terrarium.cloud;
cloud.simulation.identities.set({
  id: 'agent', allow: ['instances.*'],
  deny: ['instances.delete']
});

// The next matching start fails before the VM boots.
cloud.simulation.faults.next({
  action: 'instances.start', delayMs: 1000, fail: true,
  message: 'Injected capacity failure'
});
const operation = cloud.instances.start(instance.id, {
  identity: 'agent'
});
try { await operation.wait(); } catch (error) {
  console.log(error.code, error.message);
}
operation.get()`;

export function CloudPanel({ cloud, work, onSelect, onNewMachine, onConnections, onCancelBoot, cancellingBoots }: {
  cloud: CloudControlPlane; work: WorkspaceSnapshot;
  onSelect: (id: string) => void; onNewMachine: () => void; onConnections: () => void;
  onCancelBoot: (id: string) => Promise<void>; cancellingBoots: ReadonlySet<string>;
}) {
  const [tab, setTab] = useState<Tab>("instances");
  const [volumes, setVolumes] = useState<CloudVolumeRecord[]>([]);
  const [operations, setOperations] = useState<CloudOperation[]>(() => cloud.operations.list());
  const [refresh, setRefresh] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const tasks = useRef(new Set<string>());
  const cancelledStarts = useRef(new Set<string>());
  const startingInstances = useRef(new Set<string>());
  const [filter, setFilter] = useState("");
  const [volumeDialog, setVolumeDialog] = useState<VolumeDialog | null>(null);
  const [volumeName, setVolumeName] = useState("");
  const [volumeSize, setVolumeSize] = useState(DEFAULT_VOLUME_MIB);
  const [targetMachine, setTargetMachine] = useState("");
  const [targetSlot, setTargetSlot] = useState<0 | 1>(0);
  const [readOnly, setReadOnly] = useState(false);
  const [deletion, setDeletion] = useState<DeleteResourceRequest | null>(null);
  const [identities, setIdentities] = useState<SimulatedIdentity[]>(() => cloud.simulation.identities.list());
  const [faults, setFaults] = useState<SimulatedFault[]>(() => cloud.simulation.faults.list());
  const [confirmation, setConfirmation] = useState<{ title: string; body: string; label: string; key: string; run: () => Promise<unknown> } | null>(null);
  const [buckets, setBuckets] = useState<CloudBucket[]>([]);
  const [bucket, setBucket] = useState("");
  const [bucketName, setBucketName] = useState("");
  const [objectListing, setObjectListing] = useState<{ bucket: string; prefix: string; items: CloudObjectMetadata[] }>({ bucket: "", prefix: "", items: [] });
  const [objectsLoading, setObjectsLoading] = useState(false);
  const [prefix, setPrefix] = useState("");
  const [objectKey, setObjectKey] = useState("");
  const [objectBody, setObjectBody] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => cloud.subscribe((event) => {
    setOperations(cloud.operations.list());
    if (event.type === "operation.succeeded" || event.type === "operation.failed" || event.type === "resource.changed") setRefresh((value) => value + 1);
    setIdentities(cloud.simulation.identities.list());
    setFaults(cloud.simulation.faults.list());
  }), [cloud]);
  useEffect(() => subscribeVolumeChanges(() => setRefresh((value) => value + 1)), []);
  useEffect(() => {
    let active = true;
    void cloud.volumes.list().then((value) => { if (active) setVolumes(value); }).catch((error) => { if (active) setNotice({ message: error.message, error: true }); });
    return () => { active = false; };
  }, [cloud, refresh]);
  useEffect(() => {
    if (tab !== "objects") return;
    let active = true;
    void cloud.objectStore.buckets.list().then((value) => {
      if (!active) return;
      setBuckets(value);
      setBucket((old) => value.some((item) => item.name === old) ? old : value[0]?.name ?? "");
    }).catch((error) => { if (active) setNotice({ message: error.message, error: true }); });
    return () => { active = false; };
  }, [cloud, refresh, tab]);
  useEffect(() => {
    if (!bucket || tab !== "objects") return;
    let active = true;
    setObjectsLoading(true);
    void cloud.objectStore.objects.list(bucket, { prefix }).then((value) => {
      if (active) setObjectListing({ bucket, prefix, items: value });
    }).catch((error) => {
      if (active) { setObjectListing({ bucket, prefix, items: [] }); setNotice({ message: error.message, error: true }); }
    }).finally(() => { if (active) setObjectsLoading(false); });
    return () => { active = false; };
  }, [cloud, bucket, prefix, refresh, tab]);

  async function perform(key: string, task: () => Promise<unknown>, success?: string): Promise<boolean> {
    if (tasks.current.has(key)) return false;
    tasks.current.add(key); setBusy(new Set(tasks.current)); setNotice(null);
    try {
      await task();
      if (success) setNotice({ message: success, error: false });
      setRefresh((value) => value + 1);
      return true;
    } catch (error) {
      const expectedCancellation = key.startsWith("instance:") && startingInstances.current.has(key.slice("instance:".length)) && cancelledStarts.current.has(key.slice("instance:".length)) &&
        error instanceof Error && /stopped|cancelled|interrupted/i.test(error.message);
      if (!expectedCancellation) setNotice({ message: error instanceof Error ? error.message : String(error), error: true });
      return false;
    } finally { tasks.current.delete(key); setBusy(new Set(tasks.current)); }
  }
  async function startInstance(id: string) {
    cancelledStarts.current.delete(id); startingInstances.current.add(id);
    try { await perform(`instance:${id}`, () => cloud.instances.start(id).wait()); }
    finally { startingInstances.current.delete(id); }
  }
  const workspaceWritable = (!work.persistence || work.persistence.mode === "writable") && !work.preparingReload;
  const deletionRevision = `${refresh}:${work.persistence?.mode}:${work.preparingReload}:${JSON.stringify(work.machines.map((entry) => [entry.id, entry.name, entry.state.status, entry.runner.busy, entry.state.operation, entry.state.acquiringEvidence, entry.state.volumeOperation, entry.lifecycle, entry.config.volumes]))}:${JSON.stringify(work.vpcs)}`;
  function openDelete(target: Parameters<CloudControlPlane["deletions"]["preview"]>[0], name: string, kind: string, description: string, remove: () => Promise<unknown>, expected?: { revision?: number; sha256?: string; generation?: string }) {
    setNotice(null);
    setDeletion({ key: `${target.type}:${target.vpcId ?? target.bucket ?? ""}:${target.id}`, name, kind, description, preview: async () => {
      const value = await cloud.deletions.preview(target);
      const changed = value.exists && expected && ((expected.revision !== undefined && value.revision !== expected.revision) || (expected.sha256 !== undefined && value.sha256 !== expected.sha256) || (expected.generation !== undefined && value.generation !== expected.generation));
      return changed ? { ...value, allowed: false, blockers: [...value.blockers, { type: target.type, id: target.id, name: value.name, message: "This resource changed after it was selected. Close this dialog and review the current resource before deleting it." }] } : value;
    }, remove });
  }
  const stoppedVolumeMachines = work.machines.filter((machine) => machine.capabilities.volumes && machine.state.status === "idle" && !machine.investigation && !machineBusy(machine));
  const selectedTarget = stoppedVolumeMachines.find((machine) => machine.id === targetMachine && machine.config.volumes.length < 2 && !machine.config.volumes.some((attachment) => attachment.id === volumeDialog?.source?.id));
  const selectedSlotUsed = selectedTarget?.config.volumes.some((attachment) => attachment.slot === targetSlot);
  const visibleMachines = work.machines.filter((machine) => `${machine.name} ${machine.config.profile} ${machine.config.ip}`.toLowerCase().includes(filter.toLowerCase()));
  const selectedBucket = buckets.find((item) => item.name === bucket);
  const listingCurrent = objectListing.bucket === bucket && objectListing.prefix === prefix;
  const objects = listingCurrent ? objectListing.items : [];
  function openVolume(action: VolumeDialog["action"], source?: CloudVolumeRecord) {
    setNotice(null); setVolumeDialog({ action, source });
    setVolumeName(action === "create" ? "data-01" : `${source?.name ?? "disk"}-${action}`);
    setVolumeSize(DEFAULT_VOLUME_MIB); setReadOnly(source?.kind === "snapshot");
    const candidate = stoppedVolumeMachines.find((machine) => machine.config.volumes.length < 2 && !machine.config.volumes.some((attachment) => attachment.id === source?.id));
    setTargetMachine(candidate?.id ?? "");
    setTargetSlot(candidate?.config.volumes.some((attachment) => attachment.slot === 0) ? 1 : 0);
  }
  async function submitVolume() {
    if (!volumeDialog) return;
    const { action, source } = volumeDialog;
    const done = await perform("volume-dialog", async () => {
      if (action === "create") await cloud.volumes.create({ name: volumeName, sizeMiB: volumeSize }).wait();
      else if (action === "attach") await cloud.instances.attachVolume(targetMachine, { volumeId: source!.id, slot: targetSlot, readOnly: readOnly || source!.kind === "snapshot" }).wait();
      else await cloud.volumes[action](source!.id, { name: volumeName }).wait();
    }, action === "attach" ? "Volume configured. Boot the instance to mount it." : "Volume saved in this browser.");
    if (done) setVolumeDialog(null);
  }
  async function exportDisk(volume: CloudVolumeRecord) {
    await perform(`volume:${volume.id}`, async () => {
      let shown = -1;
      await downloadVolume(volume, cloud, { onProgress(written, total) {
        const percent = Math.floor(written / total * 100);
        if (percent !== shown) { shown = percent; setNotice({ message: `Exporting ${volume.name}: ${percent}%. Keep this page open until the file and integrity manifest are saved.`, error: false }); }
      } });
    }, "Downloaded the disk image and its integrity manifest.");
  }

  return <section className="cloud-page">
    <header className="page-heading workspace-heading">
      <div><div className="eyebrow"><Cloud size={14} /> YOUR LOCAL CLOUD</div><h1>Resources, <span>under glass.</span></h1><p>Manage real guests, persistent storage, and isolated networks in this browser.</p></div>
      <div className="heading-actions"><button className="button secondary" onClick={onConnections}><Network size={15} />Connections</button><button className="button primary" disabled={!workspaceWritable} onClick={onNewMachine}><Plus size={15} />New instance</button></div>
    </header>
    <div className="cloud-summary"><span><Box size={14} /><strong>{work.machines.length}</strong> instances</span><span><Network size={14} /><strong>{work.vpcs.length}</strong> VPCs</span><span><HardDrive size={14} /><strong>{volumes.length}</strong> disks & snapshots</span><span className="cloud-local">{cloud.apiVersion}</span></div>
    <nav className="cloud-tabs" aria-label="Cloud resource views">{tabs.map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? "active" : ""} onClick={() => { setTab(id); setNotice(null); }} aria-current={tab === id ? "page" : undefined}><Icon size={15} />{label}{id === "activity" && operations.some((operation) => operation.status === "running" || operation.status === "queued") && <span className="status-dot" />}</button>)}</nav>
    {!workspaceWritable && <p className="cloud-notice" role="status">Workspace changes are temporarily unavailable. Check the workspace storage status; reading and exporting remain available.</p>}
    {notice && <p className={`cloud-notice ${notice.error ? "error" : ""}`} role={notice.error ? "alert" : "status"}>{notice.error ? null : <CheckCircle2 size={15} />}{notice.message}</p>}

    {tab === "instances" && <>
      <div className="cloud-section-heading"><div><h2>Instance inventory</h2><p>Definitions stay lightweight. RAM and CPU are allocated when an instance boots.</p></div><input className="cloud-search" type="search" aria-label="Filter instances" placeholder="Filter by name, image, or IP…" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
      <div className="cloud-instance-list">{visibleMachines.map((machine) => {
        const state = machine.state.status;
        const cancelling = cancellingBoots.has(machine.id);
        const booting = state === "loading" || state === "booting";
        const canCancel = workspaceWritable && machine.capabilities.cancelBoot && booting && !cancelling &&
          machine.lifecycle === "ready" && !machine.runner.busy && !machine.state.operation && !machine.state.acquiringEvidence && !machine.state.volumeOperation;
        const locked = !workspaceWritable || machineBusy(machine) || busy.has(`instance:${machine.id}`) || cancelling;
        const profile = RUNTIME_PROFILES[machine.config.profile];
        return <article className="cloud-instance glass" id={`cloud-instance-${machine.id}`} key={machine.id}>
          <div className="cloud-instance-main"><div className="cloud-resource-icon"><Box size={20} /></div><div><button className="cloud-name" onClick={() => onSelect(machine.id)}>{machine.name}</button><p>{profile.label} · {profile.bits}-bit · {machine.config.x86 ? X86_MACHINE_PRESETS[machine.config.x86.presetId].memoryMiB : profile.memoryMiB} MiB{machine.config.x86 ? ` · ${X86_MACHINE_PRESETS[machine.config.x86.presetId].virtualCpus} vCPU` : ""}</p></div><span className={`cloud-state ${state}`}>{state}</span></div>
          <div className="cloud-instance-network"><code>{machine.config.ip}</code><span>{work.vpcs.find((vpc) => vpc.id === machine.config.vpcId)?.name}</span><span>{machine.investigation ? "permanent quarantine" : machine.network.mode}</span></div>
          <div className="cloud-instance-actions">
            {state === "idle" || state === "error" ? <button className="button small secondary" disabled={locked} onClick={() => void startInstance(machine.id)}><Play size={13} />Boot</button> : state === "paused" ? <button className="button small secondary" disabled={locked} onClick={() => void perform(`instance:${machine.id}`, () => cloud.instances.resume(machine.id).wait())}><Play size={13} />Resume</button> : <button className="button small secondary" disabled={locked || state !== "running"} onClick={() => void perform(`instance:${machine.id}`, () => cloud.instances.pause(machine.id).wait())}><Pause size={13} />Pause</button>}
            {booting && machine.capabilities.cancelBoot ? <button className="button small ghost" disabled={!canCancel} onClick={() => { cancelledStarts.current.add(machine.id); void perform(`cancel-boot:${machine.id}`, () => onCancelBoot(machine.id)); }}>{cancelling ? <LoaderCircle size={12} className="spin" /> : <Square size={12} />}Cancel boot</button> : <button className="button small ghost" disabled={locked || state === "idle"} onClick={() => { setNotice(null); setConfirmation({ title: `Stop ${machine.name}?`, body: "Stopping discards this guest’s RAM, processes, and temporary root filesystem. Writable data volumes are synced and kept. Resume a paused guest before stopping it if it has writable volumes.", label: "Stop instance", key: `instance:${machine.id}`, run: () => cloud.instances.stop(machine.id).wait() }); }}><Square size={12} />Stop</button>}
            <button className="button small ghost" onClick={() => onSelect(machine.id)}><Terminal size={13} />Open</button>
            <button className="icon-button danger-hover" title={`Review deletion of ${machine.name}`} aria-label={`Delete ${machine.name}`} disabled={!workspaceWritable || busy.has(`instance:${machine.id}`) || booting || cancelling} onClick={() => openDelete({ type: "instance", id: machine.id }, machine.name, "instance", "This syncs writable data disks, stops the guest, and removes its saved definition, boot script, RAM, and temporary root files. Resume a paused guest with writable disks first. Stored disks, checkpoints, and evidence are separate resources and are kept.", () => cloud.instances.delete(machine.id).wait())}><Trash2 size={14} /></button>
          </div>
          {machine.config.volumes.length > 0 && <div className="cloud-attachments">{machine.config.volumes.map((attachment) => {
            const disk = volumes.find((volume) => volume.id === attachment.id);
            const mounted = machine.state.volumes?.find((volume) => volume.slot === attachment.slot);
            return <div key={attachment.slot}><HardDrive size={13} /><strong>{disk?.name ?? attachment.id}</strong><code>/mnt/volumes/disk{attachment.slot}</code><span>{mounted?.status ?? "configured"} · {attachment.readOnly || disk?.kind === "snapshot" ? "read-only" : "writable"}</span>{mounted?.error && <span className="error-text">{mounted.error}</span>}<button className="button small ghost" disabled={state !== "idle" || locked || Boolean(machine.investigation)} onClick={() => void perform(`instance:${machine.id}`, () => cloud.instances.detachVolume(machine.id, attachment.id).wait(), "Volume detached; the stored disk remains available.")}>Detach</button></div>;
          })}{state === "running" && <button className="button small secondary" disabled={locked} onClick={() => void perform(`instance:${machine.id}`, () => cloud.instances.syncVolumes(machine.id).wait(), "Guest filesystem synced and browser writes committed.")}><RefreshCw size={13} />Sync disks</button>}</div>}
        </article>;
      })}</div>
      {!visibleMachines.length && <div className="empty-state glass"><Box size={30} /><h3>{work.machines.length ? "No matching instances" : "No instances in this workspace"}</h3><p>{work.machines.length ? "Try a different name, image, or IP filter." : "Your disks, objects, checkpoints, and evidence remain available. Create an instance when you want to run a guest."}</p>{!work.machines.length && <button className="button secondary" disabled={!workspaceWritable} onClick={onNewMachine}><Plus size={14} />New instance</button>}</div>}
      <p className="small-print cloud-footnote">Stopped definitions are lightweight. Active x86_64 guests share a limit of two runtimes and 4,600 MiB of Wasm reservation; a server reserves 3,584 MiB and occupies that budget alone. Paused guests retain their reservation. Browser, disk cache, checkpoint and display memory require additional host capacity.</p>
    </>}

    {tab === "volumes" && <>
      <div className="cloud-section-heading"><div><h2>Persistent block volumes</h2><p>Persistent ext2 data disks, with immutable snapshots and writable clones.</p></div><button className="button primary" disabled={!workspaceWritable} onClick={() => openVolume("create")}><Plus size={15} />Create volume</button></div>
      <p className="cloud-context">Attach to a stopped instance with volume support, then boot to mount at <code>/mnt/volumes/disk0</code> or <code>disk1</code>. Stop every attached guest before copying a disk. Mount a snapshot read-only on a clean analyst guest to inspect files without executing the source system.</p>
      <div className="cloud-volume-grid">{volumes.map((volume) => {
        const attached = work.machines.filter((machine) => machine.config.volumes.some((attachment) => attachment.id === volume.id));
        const inUse = attached.some((machine) => !["idle", "error"].includes(machine.state.status));
        const locked = busy.has(`volume:${volume.id}`);
        return <article key={volume.id} className="cloud-volume glass"><header><div className="cloud-resource-icon">{volume.kind === "snapshot" ? <Layers3 size={21} /> : <HardDrive size={21} />}</div><div><h3>{volume.name}</h3><p>{size(volume.bytes)} · ext2 · {volume.kind === "snapshot" ? "immutable snapshot" : "writable volume"}</p></div></header><dl><div><dt>Created</dt><dd>{new Date(volume.createdAt).toLocaleString()}</dd></div><div><dt>Attached to</dt><dd>{attached.map((machine) => machine.name).join(", ") || "No instances"}</dd></div>{volume.sha256 && <div><dt>SHA-256</dt><dd><code className="cloud-digest" title={volume.sha256}>{volume.sha256}</code></dd></div>}</dl><footer>
          <button className="button small secondary" disabled={!workspaceWritable || locked || !stoppedVolumeMachines.some((machine) => machine.config.volumes.length < 2 && !machine.config.volumes.some((attachment) => attachment.id === volume.id))} onClick={() => openVolume("attach", volume)}><Plus size={13} />Attach</button>
          {volume.kind === "volume" && <button className="button small secondary" disabled={!workspaceWritable || locked || inUse} title={inUse ? "Stop attached instances first" : "Capture an immutable disk snapshot"} onClick={() => openVolume("snapshot", volume)}><Layers3 size={13} />Snapshot</button>}
          <button className="button small ghost" disabled={!workspaceWritable || locked || inUse} onClick={() => openVolume("clone", volume)}><Copy size={13} />Clone</button>
          <button className="icon-button" disabled={locked || inUse} title="Download disk and manifest" aria-label={`Download ${volume.name}`} onClick={() => void exportDisk(volume)}><ArrowDownToLine size={15} /></button>
          <button className="icon-button danger-hover" disabled={locked} title="Review deletion and attachments" aria-label={`Delete ${volume.name}`} onClick={() => openDelete({ type: "volume", id: volume.id }, volume.name, volume.kind === "snapshot" ? "disk snapshot" : "volume", "This permanently removes this stored disk and its bytes from this browser. Detach it from every instance first. Snapshots and clones are independent copies and are kept.", () => cloud.volumes.delete(volume.id, { ifRevision: volume.revision, ...(volume.sha256 ? { ifSha256: volume.sha256 } : {}) }).wait(), { revision: volume.revision, ...(volume.sha256 ? { sha256: volume.sha256 } : {}) })}><Trash2 size={14} /></button>
        </footer></article>;
      })}</div>
      {!volumes.length && <div className="empty-state glass"><HardDrive size={30} /><h3>A place for files to survive a reboot</h3><p>Create a data volume, attach it to a compatible guest, and write under its mount path.</p><button className="button secondary" disabled={!workspaceWritable} onClick={() => openVolume("create")}>Create your first volume</button></div>}
      <p className="small-print cloud-footnote">Volumes live in this browser’s site storage. Each disk is {MIN_VOLUME_MIB}–{MAX_VOLUME_MIB} MiB; two VirtIO slots are available per compatible guest. External disks and full VM checkpoints cannot be combined. Read-only snapshots protect stored evidence from writes, but a writable clone lets you experiment freely.</p>
    </>}

    {tab === "objects" && <>
      <div className="cloud-section-heading"><div><h2>Object storage</h2><p>Persistent buckets and keys, with SHA-256 integrity and conditional writes.</p></div><button className="button secondary" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={14} />Refresh</button></div>
      <div className="cloud-object-layout">
        <aside className="cloud-buckets glass"><h3>Buckets</h3><form onSubmit={(event) => { event.preventDefault(); void perform("bucket-create", async () => { const created = await cloud.objectStore.buckets.create({ name: bucketName }); setBucket(created.name); setBucketName(""); }, "Bucket created."); }}><label htmlFor="cloud-bucket-name" className="sr-only">New bucket name</label><input id="cloud-bucket-name" disabled={!workspaceWritable || busy.has("bucket-create")} placeholder="new-bucket" value={bucketName} maxLength={63} onChange={(event) => setBucketName(event.target.value)} required /><button className="icon-button" aria-label="Create bucket" disabled={!workspaceWritable || busy.has("bucket-create") || !bucketName}><Plus size={17} /></button></form><nav aria-label="Object buckets">{buckets.map((item) => <button key={item.name} className={bucket === item.name ? "selected" : ""} onClick={() => setBucket(item.name)}><Database size={14} />{item.name}</button>)}</nav>{!buckets.length && <p className="small-print">Create a bucket to store agent artifacts.</p>}</aside>
        <div className="cloud-objects glass">{bucket ? <><header><h3>{bucket}</h3><button className="icon-button danger-hover" title="Delete empty bucket" aria-label={`Delete bucket ${bucket}`} disabled={!selectedBucket || busy.has(`bucket:${bucket}`)} onClick={() => { const target = selectedBucket; if (!target) return; openDelete({ type: "bucket", id: target.name }, target.name, "bucket", "This permanently removes this empty bucket. Delete or export each object first; this action never cascades to objects.", () => cloud.objectStore.buckets.delete(target.name, { ifGeneration: target.generation }), { generation: target.generation }); }}><Trash2 size={14} /></button></header><div className="cloud-object-toolbar"><input type="search" aria-label="Filter keys by prefix" placeholder="Filter by key prefix…" value={prefix} onChange={(event) => setPrefix(event.target.value)} /><button className="button secondary" disabled={!workspaceWritable || busy.has("object-upload")} onClick={() => fileInput.current?.click()}><Upload size={14} />Upload file</button><input type="file" hidden ref={fileInput} onChange={(event) => {
          const file = event.target.files?.[0]; event.target.value = "";
          if (!file) return;
          const targetBucket = bucket;
          void perform("object-upload", async () => { if (file.size > MAX_OBJECT_BYTES) throw new Error("Choose a file no larger than 64 MiB."); await cloud.objectStore.objects.put(targetBucket, file.name, await file.arrayBuffer(), { contentType: file.type || "application/octet-stream", ifNoneMatch: true }); }, "File saved. Existing keys are never overwritten by this uploader.");
        }} /></div><div className="cloud-object-list">{objects.map((object) => <div key={object.key} className="cloud-object-row"><div><strong>{object.key}</strong><span>{size(object.bytes)} · revision {object.revision} · {object.contentType}</span><code title={object.sha256}>{object.sha256.slice(0, 16)}…</code></div><button className="icon-button" aria-label={`Download ${object.key}`} disabled={busy.has(`object:${object.bucket}:${object.key}`)} onClick={() => void perform(`object:${object.bucket}:${object.key}`, async () => { const value = await cloud.objectStore.objects.get(object.bucket, object.key); if (value.generation !== object.generation || value.revision !== object.revision) throw new Error("This object changed. Review its updated row before downloading it."); downloadFile(filename(object.key.split("/").pop() || object.key), value.body.slice().buffer as ArrayBuffer, value.contentType); })}><ArrowDownToLine size={15} /></button><button className="icon-button danger-hover" aria-label={`Delete ${object.key}`} disabled={busy.has(`object:${object.bucket}:${object.key}`)} onClick={() => openDelete({ type: "object", id: object.key, bucket: object.bucket }, `${object.bucket} / ${object.key}`, "object", `This permanently removes revision ${object.revision} of this object. If its revision changes before deletion, this action stops so you can review the newer object.`, () => cloud.objectStore.objects.delete(object.bucket, object.key, { ifRevision: object.revision, ifGeneration: object.generation, ifMatch: object.sha256 }), { revision: object.revision, generation: object.generation, sha256: object.sha256 })}><Trash2 size={14} /></button></div>)}</div>{(objectsLoading || !listingCurrent) ? <p className="small-print" role="status">Loading objects…</p> : !objects.length && <p className="small-print">No objects{prefix ? " match this prefix" : " in this bucket yet"}.</p>}<details className="cloud-text-object"><summary>Create a text object</summary><form className="resource-form" onSubmit={(event) => { event.preventDefault(); void perform("object-text", async () => { await cloud.objectStore.objects.put(bucket, objectKey, objectBody, { contentType: "text/plain;charset=utf-8", ifNoneMatch: true }); setObjectKey(""); setObjectBody(""); }, "Text object saved."); }}><label htmlFor="cloud-object-key">Key</label><input id="cloud-object-key" disabled={!workspaceWritable || busy.has("object-text")} placeholder="agent/report.txt" value={objectKey} onChange={(event) => setObjectKey(event.target.value)} required /><label htmlFor="cloud-object-body">Contents</label><textarea id="cloud-object-body" disabled={!workspaceWritable || busy.has("object-text")} rows={5} value={objectBody} onChange={(event) => setObjectBody(event.target.value)} /><button className="button secondary" disabled={!workspaceWritable || !objectKey || busy.has("object-text")}><Plus size={14} />Save new object</button></form></details></> : <div className="cloud-object-empty"><Database size={30} /><h3>Select a bucket</h3><p>Your objects stay in this browser across page reloads.</p></div>}</div>
      </div><p className="small-print cloud-footnote">This store is available through the JavaScript API. It has no guest HTTP endpoint or S3 compatibility layer. Objects are limited to 64 MiB each; browser storage quota still applies. Export data before clearing site storage.</p>
    </>}

    {tab === "simulation" && <>
      <div className="cloud-section-heading"><div><h2>Failure injection &amp; policies</h2><p>Review one-shot failures, delays, and simulated mutation permissions.</p></div><span className="pill subtle">This open page</span></div>
      <p className="cloud-context">These rules simulate control-plane permissions and failures. They do not authenticate users or restrict reads, object storage, or direct guest commands. The local page owner remains unrestricted.</p>
      <div className="cloud-failure-grid">
        <section className="cloud-failure-card glass"><header><ShieldCheck size={19} /><h3>Simulated identities</h3></header><ul className="cloud-rule-list">{identities.map((identity) => <li key={identity.id}><div><strong>{identity.id}</strong><p><span>Allow</span> <code>{identity.allow.join(", ") || "No mutations"}</code></p><p><span>Deny</span> <code>{identity.deny.join(", ") || "No explicit denials"}</code></p>{identity.id === "local" && <small>Built-in page owner; this identity is not a user-created resource.</small>}</div>{identity.id !== "local" && <button className="icon-button danger-hover" aria-label={`Delete simulated identity ${identity.id}`} onClick={() => openDelete({ type: "identity", id: identity.id }, identity.id, "simulated identity", "Remove this simulated permission policy. Future mutations using this identity will be denied until it is created again. Existing guests and stored data remain available.", async () => cloud.simulation.identities.delete(identity.id, { ifRevision: identity.revision }), { revision: identity.revision })}><Trash2 size={15} /></button>}</li>)}</ul></section>
        <section className="cloud-failure-card glass"><header><Zap size={19} /><h3>Queued one-shot faults</h3></header><ul className="cloud-rule-list">{faults.map((fault) => <li key={fault.id}><div><strong>{fault.action}</strong><p>{fault.delayMs ? `${fault.delayMs.toLocaleString()} ms delay` : "No delay"} · {fault.fail ? "Injected failure" : "Continue after delay"}</p><p>{fault.message}</p><small><code>{fault.id}</code></small></div><button className="icon-button danger-hover" aria-label={`Delete queued fault for ${fault.action}`} onClick={() => openDelete({ type: "fault", id: fault.id }, `${fault.action} · ${fault.id}`, "queued fault", "Remove this queued fault before another matching mutation consumes it. A fault already consumed by a running operation cannot be cancelled by deleting its former queue entry.", async () => cloud.simulation.faults.delete(fault.id))}><Trash2 size={15} /></button></li>)}</ul>{!faults.length && <p className="small-print">No faults are queued. Normal operations proceed without injected failures or delays.</p>}</section>
      </div>
      <p className="small-print cloud-footnote">Use the API examples to queue failures or delays and configure identity policies. This view updates when rules are created, changed, deleted, or consumed; a page reload is not needed.</p>
    </>}

    {tab === "activity" && <><div className="cloud-section-heading"><div><h2>Operation history</h2><p>Each operation records the result of its actual resource change.</p></div><span className="pill subtle">This open page</span></div><div className="cloud-activity glass">{operations.map((operation) => <details key={operation.id} className="cloud-operation"><summary><span className={`cloud-state ${operation.status}`}>{operation.status === "running" ? <LoaderCircle size={13} className="spin" /> : null}{operation.status}</span><strong>{operation.action}</strong><time dateTime={new Date(operation.submittedAt).toISOString()}>{new Date(operation.submittedAt).toLocaleTimeString()}</time></summary><div><code>{operation.id}</code>{operation.error && <p className="error-text">{operation.error.code}: {operation.error.message}</p>}<pre>{JSON.stringify(operation.result ?? { resourceId: operation.resourceId, submittedAt: operation.submittedAt, startedAt: operation.startedAt, finishedAt: operation.finishedAt }, null, 2)}</pre></div></details>)}{!operations.length && <div className="empty-state"><Layers3 size={28} /><h3>No API operations yet</h3><p>Boot an instance from this view or use the cloud API to populate this history.</p></div>}</div><p className="small-print cloud-footnote">The most recent 200 completed operations and 500 events are retained in this page. Idempotency keys replay a matching retained request; they do not survive a page reload. Direct terminal commands and object-store data operations have their own results and are not control-plane operations.</p></>}

    {tab === "api" && <div className="cloud-api-grid"><ApiExample title="Create and run an instance" description="Mutations return an operation handle. Await .wait() to get the real resource result; .get() reports its current status." code={cloudExample} /><ApiExample title="Create, attach, and snapshot a disk" description="Use a stopped instance with volume support and a free disk slot. A snapshot can be attached read-only to a clean analyst guest, or cloned into a writable disk." code={volumeExample} /><ApiExample title="Store agent artifacts" description="The object store returns promises directly. Conditional writes make collisions explicit, and reads verify the stored SHA-256 digest." code={objectExample} /><ApiExample title="Inject failures and test policies" description="Queue a one-shot mutation failure or delay and configure simulated permissions. These rules apply to control-plane mutations; the page owner remains unrestricted, and reads and object storage are outside this policy simulation." code={simulationExample} /><section className="cloud-api-notes glass"><h3>One workspace, one registry</h3><p><code>cloud.images.list()</code> lists the real bootable profiles. <code>cloud.metadata.describe(id)</code> reads live instance and image metadata.</p><p><code>cloud.vpcs</code> and <code>cloud.subnets</code> create and manage the same networks shown in Connections. The host enforces quarantine across all entry points.</p><p>This is a local cloud control plane. Its compute and storage execute in the visitor’s browser. It does not provision an external cloud account.</p></section></div>}

    {volumeDialog && <Modal title={volumeDialog.action === "create" ? "Create a persistent volume" : `${volumeDialog.action === "attach" ? "Attach" : volumeDialog.action === "snapshot" ? "Snapshot" : "Clone"} ${volumeDialog.source?.name}`} onClose={() => { if (!busy.has("volume-dialog")) setVolumeDialog(null); }} notice={notice}>
      <form className="resource-form" onSubmit={(event) => { event.preventDefault(); void submitVolume(); }}>
        {volumeDialog.action !== "attach" ? <><label htmlFor="volume-name">Name</label><input id="volume-name" value={volumeName} onChange={(event) => setVolumeName(event.target.value)} maxLength={64} required />{volumeDialog.action === "create" && <><label htmlFor="volume-size">Capacity in MiB</label><input id="volume-size" type="number" value={volumeSize} min={MIN_VOLUME_MIB} max={MAX_VOLUME_MIB} step={1} onChange={(event) => setVolumeSize(Number(event.target.value))} required /><p className="small-print">A sparse ext2 data filesystem with a 64 MiB cache per open disk. Logical capacity does not preallocate the full image; committed pages consume browser storage. Large raw exports stream to a supported Save file picker.</p></>}{volumeDialog.action === "snapshot" && <p className="small-print">The source is copied and hashed. This immutable disk snapshot can be mounted read-only on a clean analyst machine. Stop all attached guests first so filesystem caches are committed.</p>}{volumeDialog.action === "clone" && <p className="small-print">Create a separate writable copy. The source stays available with its existing contents.</p>}</> : <><label htmlFor="volume-target">Stopped instance with volume support</label><select id="volume-target" value={selectedTarget ? targetMachine : ""} onChange={(event) => { const target = stoppedVolumeMachines.find((machine) => machine.id === event.target.value); setTargetMachine(event.target.value); setTargetSlot(target?.config.volumes.some((attachment) => attachment.slot === 0) ? 1 : 0); }} required><option value="">Select an instance</option>{stoppedVolumeMachines.filter((machine) => machine.config.volumes.length < 2 && !machine.config.volumes.some((attachment) => attachment.id === volumeDialog.source!.id)).map((machine) => <option key={machine.id} value={machine.id}>{machine.name}</option>)}</select><label htmlFor="volume-slot">Disk slot</label><select id="volume-slot" value={targetSlot} onChange={(event) => setTargetSlot(Number(event.target.value) as 0 | 1)}><option value={0} disabled={selectedTarget?.config.volumes.some((attachment) => attachment.slot === 0)}>0 · /mnt/volumes/disk0</option><option value={1} disabled={selectedTarget?.config.volumes.some((attachment) => attachment.slot === 1)}>1 · /mnt/volumes/disk1</option></select><label className="cloud-checkbox"><input type="checkbox" checked={readOnly || volumeDialog.source?.kind === "snapshot"} disabled={volumeDialog.source?.kind === "snapshot"} onChange={(event) => setReadOnly(event.target.checked)} />Read-only attachment</label><p className="small-print">The guest discovers the disk at its next boot. Snapshots always attach read-only. Only stopped instances with volume support and a free disk slot appear here.</p></>}
        <div className="modal-footer"><button type="button" className="button secondary" disabled={busy.has("volume-dialog")} onClick={() => setVolumeDialog(null)}>Cancel</button><button className="button primary" disabled={!workspaceWritable || busy.has("volume-dialog") || (volumeDialog.action === "attach" && (!selectedTarget || selectedSlotUsed))}>{busy.has("volume-dialog") ? <LoaderCircle size={15} className="spin" /> : <HardDrive size={15} />}{volumeDialog.action === "attach" ? "Attach volume" : volumeDialog.action === "create" ? "Create volume" : volumeDialog.action === "snapshot" ? "Save snapshot" : "Create clone"}</button></div>
      </form>
    </Modal>}
    {deletion && <DeleteResourceDialog key={deletion.key} request={deletion} revision={deletionRevision} onClose={() => setDeletion(null)} onDeleted={() => { setNotice({ message: `${deletion.name} deleted. Other resources were kept.`, error: false }); setDeletion(null); setRefresh((value) => value + 1); }} blockerAction={(blocker) => {
      if (blocker.type === "instance") return { label: "View instance", run: () => { setDeletion(null); setTab("instances"); setFilter(blocker.name); } };
      if (blocker.type === "object") return { label: "View objects", run: () => { setDeletion(null); setTab("objects"); setPrefix(""); } };
      return null;
    }} />}
    {confirmation && <Modal title={confirmation.title} onClose={() => { if (!busy.has(confirmation.key)) setConfirmation(null); }} notice={notice}><p className="cloud-confirm-copy">{confirmation.body}</p><div className="modal-footer"><button className="button secondary" disabled={busy.has(confirmation.key)} onClick={() => setConfirmation(null)}>Cancel</button><button className="button primary" disabled={busy.has(confirmation.key)} onClick={() => { const current = confirmation; void perform(current.key, current.run).then((success) => { if (success) setConfirmation(null); }); }}>{busy.has(confirmation.key) ? <LoaderCircle size={15} className="spin" /> : null}{confirmation.label}</button></div></Modal>}
  </section>;
}

function ApiExample({ title, description, code }: { title: string; description: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  async function copyCode() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable.");
      await navigator.clipboard.writeText(code);
      setCopied(true); setError("");
    } catch {
      setCopied(false); setError("Clipboard access is unavailable. Select and copy the code below.");
    }
  }
  return <section className="cloud-api-example glass"><header><h3>{title}</h3><button className="icon-button" aria-label={`Copy ${title} example`} onClick={() => { void copyCode(); }}>{copied ? <CheckCircle2 size={15} /> : <Copy size={15} />}</button></header><p>{description}</p>{error && <p className="error-text">{error}</p>}<pre tabIndex={0}><code>{code}</code></pre></section>;
}
