// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { Box, CheckCircle2, Cpu, Download, ExternalLink, HardDrive, Info, Layers3, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { workspace, type WorkspaceSnapshot } from "../lib/machines";
import { readStorageHealth, type StorageHealth } from "../lib/workspace-persistence";
import { downloadFile } from "../lib/snapshots";
import { getSharedMemorySupport, prepareSharedMemoryRuntime } from "../lib/browser-isolation";
import { Modal } from "./Modal";

function bytes(value: number | null): string {
  if (value === null) return "Unavailable";
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`;
}
export function WorkspaceRecovery({ work, onOpenMachine, onSnapshots }: {
  work: WorkspaceSnapshot; onOpenMachine: (id: string) => void; onSnapshots: () => void;
}) {
  const [health, setHealth] = useState<StorageHealth | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const [reload, setReload] = useState(false);
  const [enableRuntime, setEnableRuntime] = useState(false);
  const [sharedMemory, setSharedMemory] = useState(getSharedMemorySupport);
  const writable = work.persistence.mode === "writable" && !work.preparingReload;
  useEffect(() => { let active = true; void readStorageHealth().then((value) => { if (active) setHealth(value); }); return () => { active = false; }; }, []);
  useEffect(() => {
    const update = () => setSharedMemory(getSharedMemorySupport());
    navigator.serviceWorker?.addEventListener("controllerchange", update);
    return () => navigator.serviceWorker?.removeEventListener("controllerchange", update);
  }, []);
  async function perform(label: string, task: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setNotice(null);
    try { await task(); }
    catch (error) { setNotice({ message: error instanceof Error ? error.message : String(error), error: true }); }
    finally { setBusy(""); }
  }
  const live = work.machines.filter((machine) => !["idle", "error"].includes(machine.state.status));
  return <section className="recovery-page">
    <header className="page-heading workspace-heading"><div><div className="eyebrow"><HardDrive size={14} /> WORKSPACE & STORAGE</div><h1>A world <span>worth keeping.</span></h1><p>Review saved resources, interrupted sessions, and browser storage.</p></div><button className="button secondary" disabled={Boolean(busy)} onClick={() => void perform("export", async () => { downloadFile("terrarium-workspace-manifest.json", workspace.exportManifest(), "application/json"); setNotice({ message: "Configuration manifest downloaded. Export disks, checkpoints, objects, and evidence separately to back up their contents.", error: false }); })}><Download size={15} />Export configuration</button></header>
    {notice && <p className={`cloud-notice ${notice.error ? "error" : ""}`} role={notice.error ? "alert" : "status"}>{notice.message}</p>}
    <div className="recovery-grid">
      <section className="recovery-card glass"><div className="card-label">SAVED INVENTORY <Box size={16} /></div><h2>{work.persistence.mode === "writable" ? "This tab is in control" : work.persistence.mode === "opening" ? "Opening the workspace" : "Workspace needs attention"}</h2><p>Machines, VPCs, subnets, disk attachments, boot scripts, and the selected machine are saved together. Deleting the final resource leaves an empty inventory.</p><dl className="runtime-facts"><div><dt>Saved revision</dt><dd>{work.persistence.revision}</dd></div><div><dt>Last saved</dt><dd>{work.persistence.updatedAt ? new Date(work.persistence.updatedAt).toLocaleString() : "Not yet saved"}</dd></div><div><dt>Machine definitions</dt><dd>{work.machines.filter((machine) => !machine.ephemeral).length}</dd></div><div><dt>Temporary investigation guests</dt><dd>{work.machines.filter((machine) => machine.ephemeral).length}</dd></div></dl>{work.persistence.error && <p className="error-text" role="alert">{work.persistence.error}</p>}{work.persistence.mode !== "writable" && <button className="button secondary" disabled={Boolean(busy) || work.persistence.mode === "opening"} onClick={() => void perform("ownership", async () => { await workspace.takeControl(); setNotice({ message: "This tab now owns the latest saved workspace.", error: false }); })}>{busy === "ownership" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}Take control / retry</button>}<p className="small-print">One browser tab owns resource changes and guest execution. A second tab can inspect its loaded inventory and take control after the owner closes.</p></section>
      <section className="recovery-card glass"><div className="card-label">BROWSER STORAGE <ShieldCheck size={16} /></div><h2>{health?.persistent ? "Persistent storage granted" : health?.persistent === false ? "Best-effort storage" : "Storage information"}</h2><p>Disks, stored snapshots, evidence, and objects belong to this site in this browser. A different browser, site address, or cleared site data has separate storage.</p><dl className="runtime-facts"><div><dt>Estimated usage</dt><dd>{bytes(health?.usage ?? null)}</dd></div><div><dt>Estimated quota</dt><dd>{bytes(health?.quota ?? null)}</dd></div><div><dt>Persistence</dt><dd>{health?.persistent === true ? "Granted" : health?.persistent === false ? "Not granted" : "Unavailable"}</dd></div></dl><div className="recovery-actions"><button className="button secondary" disabled={Boolean(busy)} onClick={() => void perform("estimate", async () => setHealth(await readStorageHealth()))}><RefreshCw size={14} />Refresh estimate</button>{health?.canRequestPersistence && !health.persistent && <button className="button secondary" disabled={Boolean(busy)} onClick={() => void perform("persistence", async () => { const granted = await navigator.storage.persist(); setHealth(await readStorageHealth()); setNotice({ message: granted ? "The browser granted persistent storage for this site." : "The browser did not grant persistent storage. Existing data is unchanged; keep exported backups.", error: false }); })}><ShieldCheck size={14} />Request persistence</button>}</div><p className="small-print">Persistence reduces automatic eviction. It cannot prevent you from clearing site data, and does not replace an exported backup. Quota estimates cover the site origin.</p></section>
    </div>
    <section className="recovery-card glass">
      <div className="card-label">X86_64 RUNTIME <Cpu size={16} /></div>
      <h2>{sharedMemory.ready ? "Shared memory is ready" : "Enable shared memory for x86_64"}</h2>
      <p>{sharedMemory.message}</p>
      <dl className="runtime-facts">
        <div><dt>Page isolation</dt><dd>{sharedMemory.crossOriginIsolated ? "Enabled" : "Not active"}</dd></div>
        <div><dt>SharedArrayBuffer</dt><dd>{sharedMemory.sharedArrayBuffer ? "Available" : "Not exposed"}</dd></div>
        <div><dt>Guest memory</dt><dd>512 MiB per x86_64 guest</dd></div>
        <div><dt>Emulator reservation</dt><dd>2,300 MiB per x86_64 instance</dd></div>
      </dl>
      <div className="recovery-actions">
        {!sharedMemory.ready && <button className="button primary" disabled={!writable || Boolean(busy) || sharedMemory.embedded || !sharedMemory.secureContext || !sharedMemory.serviceWorkerAvailable || sharedMemory.crossOriginIsolated} onClick={() => { setNotice(null); setEnableRuntime(true); }}><RefreshCw size={15} />Enable x86_64 & reload</button>}
        <button className="button secondary" disabled={Boolean(busy)} onClick={() => setSharedMemory(getSharedMemorySupport())}><RefreshCw size={14} />Check support</button>
        {sharedMemory.embedded && <a className="button secondary" href={window.location.href} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} />Open Terrarium in a new tab</a>}
      </div>
      <p className="small-print">This enables the shared WebAssembly memory required by the experimental QEMU backend. It does not install Kubernetes. Setup adds isolation headers only to this app’s own pages and workers, without caching guest files or changing outside requests. An embedding page or hosting policy can still prevent isolation.</p>
    </section>
    <section className="recovery-card glass"><div className="card-label">PREVIOUS SESSION <Layers3 size={16} /></div><h2>{work.recovery.length ? "Review interrupted machines" : "No interrupted machines recorded"}</h2><p>A refresh keeps saved definitions and committed data. Guest CPU, RAM, temporary root files, terminals, and running commands end with the page. Machines reopen stopped; boot scripts run again on a fresh boot. Outside access stays off.</p>{work.recovery.length > 0 && <div className="recovery-machine-list">{work.recovery.map((activity) => { const machine = work.machines.find((item) => item.id === activity.id); if (!machine) return null; return <article key={activity.id}><div><strong>{machine.name}</strong><p>Last recorded as {activity.status} · {new Date(activity.updatedAt).toLocaleString()}</p>{machine.config.volumes.some((volume) => !volume.readOnly) && <p className="small-print">Writable disks may have uncommitted guest changes. Committed blocks remain; an abrupt close does not guarantee a consistent filesystem.</p>}</div><div className="recovery-actions"><button className="button secondary" onClick={() => onOpenMachine(activity.id)}>Open machine</button><button className="button ghost" disabled={!writable || Boolean(busy)} onClick={() => void perform(`ack:${activity.id}`, async () => { workspace.acknowledgeRecovery(activity.id); })}>Acknowledge</button></div></article>; })}</div>}<button className="button secondary" onClick={onSnapshots}><Layers3 size={14} />Open saved checkpoints</button><p className="small-print">Compatible Pocket PC and Alpine x86_64 checkpoints can be restored explicitly from Snapshots & evidence. No automatic RAM checkpoint is taken on refresh, and commands are never automatically rerun.</p></section>
    <section className="recovery-card glass recovery-reload"><div><div className="card-label">CONTROLLED RELOAD <RefreshCw size={16} /></div><h2>Stop cleanly before reopening</h2><p>Wait for current tasks, sync writable disks, stop guests, and commit the workspace before reloading. If any step fails, this page stays open and reports the reason.</p><span className="pill subtle">{live.length} started guest{live.length === 1 ? "" : "s"}</span></div><button className="button primary" disabled={!writable || Boolean(busy)} onClick={() => { setNotice(null); setReload(true); }}><RefreshCw size={15} />Stop & reload</button></section>
    <p className="small-print recovery-note"><Info size={14} /> Configuration export contains boot scripts and attachment IDs. It is a diagnostic configuration copy, not a complete data backup or an importable workspace bundle.</p>
    {reload && <Modal title="Stop guests and reload?" notice={notice} onClose={() => { if (!busy) setReload(false); }}><p className="confirm-copy">This discards guest RAM, temporary root files, and processes. Writable data disks are synced and preserved. Saved checkpoints, evidence, objects, and resource definitions stay in this browser. Pause is not a checkpoint: resume paused guests with writable disks first.</p><div className="modal-footer"><button className="button secondary" disabled={Boolean(busy)} onClick={() => setReload(false)}>Cancel</button><button className="button primary" disabled={Boolean(busy)} onClick={() => void perform("reload", async () => { await workspace.prepareReload(); window.location.reload(); })}>{busy === "reload" ? <LoaderCircle className="spin" size={15} /> : <CheckCircle2 size={15} />}Stop & reload</button></div></Modal>}
    {enableRuntime && <Modal title="Enable x86_64 and reload?" notice={notice} onClose={() => { if (!busy) setEnableRuntime(false); }}><p className="confirm-copy">The x86_64 emulator needs shared memory. Terrarium will activate its isolation helper for this application’s directory, then stop guests cleanly before reloading. Guest RAM, temporary root files, and processes are discarded. Writable data disks are synced and preserved. Finish current tasks and resume paused guests with writable disks first.</p><p className="small-print">If activation or shutdown fails, this page stays open and reports the reason. There is no automatic reload or retry loop. If isolation remains unavailable after this reload, check the hosting or embedding policy.</p><div className="modal-footer"><button className="button secondary" disabled={Boolean(busy)} onClick={() => setEnableRuntime(false)}>Cancel</button><button className="button primary" disabled={!writable || Boolean(busy)} onClick={() => void perform("isolation", async () => { await prepareSharedMemoryRuntime(); setSharedMemory(getSharedMemorySupport()); await workspace.prepareReload(); window.location.reload(); })}>{busy === "isolation" ? <LoaderCircle className="spin" size={15} /> : <CheckCircle2 size={15} />}Enable, stop & reload</button></div></Modal>}
  </section>;
}
