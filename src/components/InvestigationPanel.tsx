// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  FileSearch,
  FolderOpen,
  LoaderCircle,
  Play,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import {
  workspace,
  type ManagedMachine,
  type WorkspaceSnapshot,
} from "../lib/machines";
import {
  inspectCheckpoint,
  type CheckpointInspection,
} from "../lib/checkpoint-format";
import {
  downloadFile,
  readSnapshot,
  type SnapshotMeta,
} from "../lib/snapshots";
import {
  decodeEvidenceBytes,
  exportEvidenceArchive,
  importEvidenceArchive,
  MAX_EVIDENCE_ARCHIVE_BYTES,
  type EvidenceArchive,
} from "../lib/evidence";
import {
  listEvidence,
  storeEvidence,
  readEvidence,
  deleteEvidence,
  subscribeEvidenceChanges,
  type EvidenceMeta,
} from "../lib/evidence-store";
import { Modal } from "./Modal";
import { DeleteResourceDialog, type DeleteResourceRequest } from "./DeleteResourceDialog";
import { getRuntimeProfile, isRuntimeProfileId, RUNTIME_PROFILES, type RuntimeProfileId } from "../lib/runtime-profiles";

const sizeLabel = (bytes: number) =>
  bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MiB`
    : `${(bytes / 1024).toFixed(1)} KiB`;
const displayPath = (value: string) =>
  value.replace(
    /[\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
const downloadName = (path: string) =>
  (path.split("/").at(-1) || "evidence.bin").replace(
    /[\u0000-\u001f\u007f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,
    "_",
  );
const hex = (value: number | string | null) =>
  value === null
    ? "Unavailable"
    : typeof value === "string"
      ? value.startsWith("0x") ? value : `0x${value}`
      : `0x${(value >>> 0).toString(16).padStart(8, "0")}`;

export function InvestigationPanel({
  work,
  machine,
  inspect,
  onCloseInspection,
  onOpenMachine,
  onError,
}: {
  work: WorkspaceSnapshot;
  machine: ManagedMachine | null;
  inspect: SnapshotMeta | null;
  onCloseInspection: () => void;
  onOpenMachine: (id: string) => void;
  onError: (error: unknown) => void;
}) {
  const [inspection, setInspection] = useState<CheckpointInspection | null>(null);
  const [inspectionError, setInspectionError] = useState("");
  const [archives, setArchives] = useState<EvidenceMeta[]>([]);
  const [selected, setSelected] = useState<EvidenceArchive | null>(null);
  const [analystProfile, setAnalystProfile] = useState<RuntimeProfileId>("x86");
  const [filePath, setFilePath] = useState("");
  const [previewMode, setPreviewMode] = useState<"text" | "hex">("text");
  const [paths, setPaths] = useState(
    "/etc/passwd\n/etc/inittab\n/etc/resolv.conf",
  );
  const [title, setTitle] = useState("Logical file capture");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [taskError, setTaskError] = useState(false);
  const [deleting, setDeleting] = useState<DeleteResourceRequest | null>(null);
  const [archiveRevision, setArchiveRevision] = useState(0);
  const [archivesLoading, setArchivesLoading] = useState(true);
  const importInput = useRef<HTMLInputElement>(null);
  const taskLock = useRef(false);
  const current = machine ? work.machines.find((entry) => entry.id === machine.id) : undefined;
  const hasPlacement = work.vpcs.some((vpc) => vpc.subnets.length > 0);
  const workspaceWritable = (!work.persistence || work.persistence.mode === "writable") && !work.preparingReload;
  const analystProfiles = Object.values(RUNTIME_PROFILES).filter((profile) => getRuntimeProfile(profile.id).capabilities.evidenceMount);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  useEffect(() => {
    let active = true;
    let sequence = 0;
    let previous = new Map<string, string>();
    async function refreshArchives() {
      const request = ++sequence;
      try {
        const next = await listEvidence();
        if (!active || request !== sequence) return;
        const nextDigests = new Map(next.map((archive) => [archive.id, archive.sha256]));
        const oldDigests = previous;
        setArchives(next);
        setSelected((value) => value && oldDigests.get(value.id) === value.sha256 && nextDigests.get(value.id) !== value.sha256 ? null : value);
        previous = nextDigests;
        setArchiveRevision((value) => value + 1);
      } catch (error) {
        if (active && request === sequence) errorHandler.current(error);
      } finally {
        if (active && request === sequence) setArchivesLoading(false);
      }
    }
    const stop = subscribeEvidenceChanges(() => { void refreshArchives(); });
    void refreshArchives();
    return () => { active = false; sequence += 1; stop(); };
  }, []);
  function reviewDelete(archive: EvidenceMeta) {
    setDeleting({
      key: archive.id,
      name: archive.title,
      kind: "evidence archive",
      description: "This permanently removes the saved archive from this browser. Download it first if you want to preserve the captured bytes and provenance.",
      preview: async () => {
        const current = (await listEvidence()).find((entry) => entry.id === archive.id);
        const changed = current && current.sha256 !== archive.sha256;
        const blockers = changed ? [{ type: "evidence", id: archive.id, name: current.title, message: "The saved archive has changed since this dialog opened. Close this dialog and review the current archive before deleting it." }] : [];
        try { workspace.assertWritable(); } catch (error) { blockers.push({ type: "workspace", id: "workspace", name: "Workspace write access", message: error instanceof Error ? error.message : String(error) }); }
        return {
          exists: Boolean(current), allowed: Boolean(current) && blockers.length === 0,
          blockers,
          preserves: ["Mounted analyst shares are independent copies and remain available.", "Original checkpoints and source machines are kept."],
        };
      },
      remove: async () => { workspace.assertWritable(); await deleteEvidence(archive.id, { ifSha256: archive.sha256 }); },
    });
  }
  useEffect(() => {
    let cancelled = false;
    setInspection(null);
    setInspectionError("");
    if (inspect)
      void readSnapshot(inspect.id)
        .then(inspectCheckpoint)
        .then((result) => {
          if (!cancelled) setInspection(result);
        })
        .catch((error) => {
          if (!cancelled)
            setInspectionError(
              String(error instanceof Error ? error.message : error),
            );
        });
    return () => {
      cancelled = true;
    };
  }, [inspect?.id]);
  async function task(label: string, run: () => Promise<void>) {
    if (taskLock.current) return;
    taskLock.current = true;
    setBusy(label);
    setMessage("");
    setTaskError(false);
    try {
      await run();
    } catch (error) {
      onError(error);
      setTaskError(true);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      taskLock.current = false;
      setBusy("");
    }
  }
  function selectArchive(archive: EvidenceArchive) {
    setSelected(archive);
    setFilePath(archive.files[0]?.path ?? "");
  }
  const file = selected?.files.find((item) => item.path === filePath);
  const preview = useMemo(() => {
    if (!file) return "";
    const bytes = decodeEvidenceBytes(file).subarray(0, 4096);
    if (previewMode === "text")
      return new TextDecoder()
        .decode(bytes)
        .replace(
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,
          (character) =>
            `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
        );
    return Array.from({ length: Math.ceil(bytes.length / 16) }, (_, row) => {
      const chunk = bytes.subarray(row * 16, row * 16 + 16);
      return `${(row * 16).toString(16).padStart(6, "0")}  ${Array.from(
        chunk,
        (byte) => byte.toString(16).padStart(2, "0"),
      )
        .join(" ")
        .padEnd(
          47,
          " ",
        )}  ${Array.from(chunk, (byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".")).join("")}`;
    }).join("\n");
  }, [file, previewMode]);

  return (
    <section className="investigation-section">
      <header className="section-toolbar">
        <div>
          <span className="eyebrow">
            <FileSearch size={14} /> INVESTIGATION BENCH
          </span>
          <h2>Preserve. Inspect. Investigate.</h2>
          <p>
            Keep the checkpoint intact. Work on a quarantined copy, then mount
            selected files in a clean guest.
          </p>
        </div>
        <button
          className="button secondary"
          disabled={Boolean(busy) || !workspaceWritable}
          onClick={() => importInput.current?.click()}
        >
          <Upload size={14} /> Import evidence
        </button>
      </header>
      <input
        ref={importInput}
        type="file"
        accept=".json,.terrarium-evidence"
        hidden
        onChange={(event) => {
          const input = event.currentTarget;
          const file = input.files?.[0];
          input.value = "";
          if (file)
            void task("Verifying archive", async () => {
              workspace.assertWritable();
              if (file.size > MAX_EVIDENCE_ARCHIVE_BYTES)
                throw new Error(
                  "Choose an evidence archive of at most 12 MiB.",
                );
              const archive = await importEvidenceArchive(
                await file.arrayBuffer(),
              );
              selectArchive(archive);
              workspace.assertWritable();
              await storeEvidence(archive);
              setArchives(await listEvidence());
              setMessage(
                "Archive and file hashes verified. No guest was started.",
              );
            });
        }}
      />
      {!workspaceWritable && <p className="evidence-storage-note" role="status">Evidence reads, downloads, and passive inspection remain available. Take control in Workspace & storage before importing, capturing, or deleting an archive.</p>}
      <div className="investigation-grid">
        <section className="technical-notes glass evidence-capture">
          <div className="card-label">
            QUARANTINED ACQUISITION <ShieldCheck size={16} />
          </div>
          <label htmlFor="investigation-machine">Investigation machine</label>
          <select
            id="investigation-machine"
            value={machine?.investigation && current ? machine.id : ""}
            disabled={Boolean(busy) || !work.machines.some((entry) => entry.investigation)}
            onChange={(event) => workspace.select(event.target.value)}
          >
            <option value="" disabled>
              Select a quarantined clone
            </option>
            {work.machines
              .filter((entry) => entry.investigation)
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name} · {entry.state.status}
                </option>
              ))}
          </select>
          {!machine?.investigation || !current ? (
            <p>
              Choose <strong>Inspect</strong> on a checkpoint above, then create
              a paused quarantine clone. It creates an independent machine.
            </p>
          ) : (
            <>
              <p>
                <strong>{machine.name}</strong> has no peer or outside
                connection. Its original checkpoint remains unchanged. This
                machine is temporary and disappears on refresh.
              </p>
              {current.state.status === "paused" && (
                <button
                  className="button secondary"
                  disabled={Boolean(busy) || !workspaceWritable}
                  onClick={() =>
                    void task("Resuming quarantined guest", async () => {
                      workspace.assertWritable();
                      await machine.runtime.resume();
                      setMessage(
                        "The quarantined guest is now executing. Its network remains disconnected.",
                      );
                    })
                  }
                >
                  <Play size={14} /> Resume quarantined guest
                </button>
              )}
              <label htmlFor="evidence-title">Capture title</label>
              <input
                id="evidence-title"
                value={title}
                maxLength={80}
                onChange={(event) => setTitle(event.target.value)}
              />
              <label htmlFor="evidence-paths">
                Regular files, one absolute path per line
              </label>
              <textarea
                id="evidence-paths"
                className="script-editor compact"
                value={paths}
                onChange={(event) => setPaths(event.target.value)}
                spellCheck={false}
              />
              <p className="small-print">
                Up to 32 files, 1 MiB per file, 8 MiB total. Capture runs
                commands inside the guest. A compromised guest can hide or
                falsify what those commands return.
              </p>
              <button
                className="button primary"
                disabled={
                  Boolean(busy) || !workspaceWritable ||
                  !current.capabilities.evidenceCapture ||
                  !current.runner.ready ||
                  current.state.status !== "running"
                }
                onClick={() =>
                  void task("Capturing selected files", async () => {
                    workspace.assertWritable();
                    if (!machine.runtime.capabilities.evidenceCapture || !machine.runtime.captureEvidence)
                      throw new Error("This machine profile does not support logical evidence capture.");
                    const archive = await machine.runtime.captureEvidence(
                      paths
                        .split("\n")
                        .map((path) => path.trim())
                        .filter(Boolean),
                      (command) =>
                        machine.runner.executeInternal(command, {
                          timeoutMs: 30_000,
                        }),
                      {
                        title,
                        machineId: machine.id,
                        machineName: machine.name,
                        checkpointSha256: machine.investigation?.sha256,
                      },
                    );
                    selectArchive(archive);
                    workspace.assertWritable();
                    await storeEvidence(archive);
                    setArchives(await listEvidence());
                    setMessage(
                      "Logical capture saved. File bytes and provenance were hashed by the host.",
                    );
                  })
                }
              >
                <FileSearch size={14} /> Capture selected files
              </button>
            </>
          )}
        </section>
        <section className="technical-notes glass evidence-shelf">
          <div className="card-label">
            PRESERVED FILE ARCHIVES <FolderOpen size={16} />
          </div>
          {archivesLoading ? <p role="status"><LoaderCircle size={15} className="spin" /> Loading saved archives…</p> : !archives.length ? (
            <p>
              No logical captures yet. Imported or captured archives appear here
              with verified hashes.
            </p>
          ) : (
            <ul className="evidence-list">
              {archives.map((archive) => (
                <li
                  key={archive.id}
                  className={selected?.id === archive.id ? "selected" : ""}
                >
                  <button
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void task("Verifying evidence", async () => {
                        selectArchive(await readEvidence(archive.id));
                      })
                    }
                  >
                    <strong>{archive.title}</strong>
                    <small>
                      {archive.fileCount} files ·{" "}
                      {sizeLabel(archive.totalBytes)} ·{" "}
                      {new Date(archive.createdAt).toLocaleDateString()}
                    </small>
                  </button>
                  <button
                    className="icon-button danger-hover"
                    aria-label={`Delete evidence ${archive.title}`}
                    disabled={Boolean(busy) || !workspaceWritable}
                    onClick={() => reviewDelete(archive)}
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="small-print">
            These are bounded, guest-assisted file collections. They do not
            include unallocated space, deleted files, or a complete disk image.
            Hashes detect changes to the captured bytes; they do not prove the
            guest was truthful.
          </p>
        </section>
      </div>
      {(busy || message) && (
        <p className={`bench-status ${taskError ? "error-text" : ""}`} role={taskError ? "alert" : "status"}>
          {busy && <LoaderCircle size={15} className="spin" />}
          {busy || message}
        </p>
      )}
      {selected && (
        <section className="evidence-viewer glass">
          <header className="section-toolbar">
            <div>
              <span className="eyebrow">VERIFIED LOGICAL CAPTURE</span>
              <h3>{selected.title}</h3>
              <p>
                {selected.files.length} files · {sizeLabel(selected.totalBytes)}{" "}
                · {selected.source.machineName || "Imported source"}
              </p>
            </div>
            <div className="heading-actions">
              <button
                className="button secondary"
                disabled={Boolean(busy)}
                onClick={() =>
                  downloadFile(
                    `terrarium-evidence-${selected.id}.json`,
                    exportEvidenceArchive(selected).slice()
                      .buffer as ArrayBuffer,
                    "application/json",
                  )
                }
              >
                <Download size={14} /> Archive
              </button>
              <label className="analyst-profile-control" htmlFor="evidence-analyst-profile">
                Analyst profile
                <select id="evidence-analyst-profile" value={analystProfile} disabled={Boolean(busy)} onChange={(event) => {
                  const profile = event.target.value;
                  if (isRuntimeProfileId(profile) && getRuntimeProfile(profile).capabilities.evidenceMount) setAnalystProfile(profile);
                }}>
                  {analystProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
                </select>
              </label>
              <button
                className="button primary"
                disabled={Boolean(busy) || !hasPlacement || !workspaceWritable}
                title={hasPlacement ? `Boot a clean ${getRuntimeProfile(analystProfile).label} machine with a read-only evidence attachment.` : "Create a VPC and subnet in Connections first."}
                onClick={() =>
                  void task("Preparing analyst machine", async () => {
                    const entry = await workspace.createAnalyst(selected, analystProfile);
                    onOpenMachine(entry.id);
                  })
                }
              >
                <FolderOpen size={14} /> Mount in clean analyst
              </button>
            </div>
          </header>
          {!archives.some((archive) => archive.id === selected.id && archive.sha256 === selected.sha256) && <p className="evidence-storage-note" role="status">This archive is available in this open view. Export it to preserve a copy outside this page.</p>}
          {!hasPlacement && <p className="evidence-storage-note">Create a VPC and subnet in Connections before mounting this archive in a clean analyst guest. Host inspection and downloads remain available.</p>}
          <p className="digest-line">
            <strong>Archive SHA-256</strong>
            <code>{selected.sha256}</code>
          </p>
          {selected.source.checkpointSha256 && (
            <p className="digest-line">
              <strong>Source checkpoint SHA-256</strong>
              <code>{selected.source.checkpointSha256}</code>
            </p>
          )}
          <div className="evidence-file-layout">
            <nav aria-label="Captured files">
              {selected.files.map((item) => (
                <button
                  key={item.path}
                  aria-current={filePath === item.path ? "true" : undefined}
                  onClick={() => setFilePath(item.path)}
                >
                  <code>{displayPath(item.path)}</code>
                  <small>{sizeLabel(item.size)}</small>
                </button>
              ))}
            </nav>
            <div className="evidence-file-preview">
              <div className="section-toolbar">
                <label>
                  Preview{" "}
                  <select
                    value={previewMode}
                    onChange={(event) =>
                      setPreviewMode(event.target.value as "text" | "hex")
                    }
                  >
                    <option value="text">Text</option>
                    <option value="hex">Hex bytes</option>
                  </select>
                </label>
                <button
                  className="button ghost"
                  disabled={!file}
                  onClick={() =>
                    file &&
                    downloadFile(
                      downloadName(file.path),
                      decodeEvidenceBytes(file).buffer as ArrayBuffer,
                    )
                  }
                >
                  <Download size={14} /> File
                </button>
              </div>
              <pre tabIndex={0}>{preview || "(empty file)"}</pre>
              {file && (
                <>
                  <p className="small-print">
                    {file.size > 4096
                      ? "Showing the first 4 KiB. Download the file for all bytes. "
                      : ""}
                    Control and direction characters are escaped in the text
                    preview and path labels. Download names replace invisible
                    controls with underscores.
                  </p>
                  <p className="digest-line">
                    <strong>File SHA-256</strong>
                    <code>{file.sha256}</code>
                  </p>
                </>
              )}
            </div>
          </div>
          <p className="small-print">
            The clean analyst mounts an independent read-only copy at{" "}
            <code>/mnt/evidence</code>. Captured paths are under{" "}
            <code>/mnt/evidence/files</code>, alongside{" "}
            <code>manifest.json</code>. The host rejects writes even if the
            guest remounts it. View permissions and timestamps are synthetic,
            not original inode metadata. The original archive stays unchanged.
            Evidence attachment machines are temporary and cannot save
            checkpoints.
          </p>
        </section>
      )}
      {inspect && (
        <Modal
          title="Inspect a preserved checkpoint."
          subtitle={inspect.title}
          className="inspection-modal"
          notice={
            busy || message
              ? { message: busy || message, error: !busy && taskError }
              : null
          }
          onClose={() => {
            if (!busy) onCloseInspection();
          }}
        >
          {inspectionError ? (
            <p className="modal-alert error" role="alert">
              {inspectionError}
            </p>
          ) : !inspection ? (
            <p role="status">
              <LoaderCircle size={16} className="spin" /> Validating checkpoint
              and calculating SHA-256…
            </p>
          ) : (
            <>
              <p className="inspection-state">
                <ShieldCheck size={17} /> Passive inspection. No guest
                instructions executed.
              </p>
              <dl className="inspection-facts">
                <div>
                  <dt>Format</dt>
                  <dd>{inspection.kind === "qemu-checkpoint" ? "QEMU checkpoint" : "v86 state"} v{inspection.formatVersion}</dd>
                </div>
                <div>
                  <dt>Memory</dt>
                  <dd>
                    {inspection.memoryMiB} MiB{inspection.videoMemoryMiB !== null ? ` + ${inspection.videoMemoryMiB} MiB video` : ""}
                  </dd>
                </div>
                <div>
                  <dt>Checkpoint</dt>
                  <dd>{sizeLabel(inspection.size)}</dd>
                </div>
                <div>
                  <dt>Serial ports</dt>
                  <dd>{inspection.serialPorts}</dd>
                </div>
                <div>
                  <dt>Instruction pointer</dt>
                  <dd>
                    <code>{hex(inspection.cpu.instructionPointer)}</code>
                  </dd>
                </div>
                <div>
                  <dt>CPU privilege</dt>
                  <dd>{inspection.cpu.privilegeLevel ?? "Unavailable"}</dd>
                </div>
              </dl>
              <p className="small-print">
                {inspection.cpuSource === "captured-monitor"
                  ? "CPU values were captured from the emulator monitor while paused at save time. They are preserved observations; this view does not decode CPU registers from the QEMU state payload."
                  : inspection.cpuSource === "serialized-state"
                    ? "CPU values are decoded from the checkpoint's serialized emulator state."
                    : "This checkpoint does not contain a CPU register observation."}
              </p>
              <p className="digest-line">
                <strong>SHA-256 of original bytes</strong>
                <code>{inspection.sha256}</code>
              </p>
              {inspection.cpu.generalRegisters && (
                <details className="cpu-registers">
                  <summary>{inspection.cpuSource === "captured-monitor" ? "CPU registers captured at save time" : "Saved CPU registers"}</summary>
                  <dl>
                    {Object.entries(inspection.cpu.generalRegisters).map(
                      ([name, value]) => (
                        <div key={name}>
                          <dt>{name}</dt>
                          <dd>
                            <code>{hex(value)}</code>
                          </dd>
                        </div>
                      ),
                    )}
                  </dl>
                </details>
              )}
              <p>
                The checkpoint contains CPU, memory, and devices. To inspect
                files, create a quarantine clone, explicitly resume it, and
                acquire selected files. A paused clone has not run startup
                scripts or guest commands.
              </p>
              <p className="small-print">
                Quarantine blocks every guest network frame, including peer
                traffic. This is an educational emulator boundary inside your
                browser, not a hardened malware analysis environment or a kernel
                debugger.
              </p>
              {!hasPlacement && <p className="evidence-storage-note">Create a VPC and subnet in Connections before making an investigation machine. This passive checkpoint inspection does not need a machine.</p>}
              <footer className="modal-footer">
                <button
                  className="button secondary"
                  disabled={Boolean(busy)}
                  onClick={onCloseInspection}
                >
                  Close
                </button>
                <button
                  className="button primary"
                  disabled={Boolean(busy) || !hasPlacement || !workspaceWritable}
                  title={!hasPlacement ? "Create a VPC and subnet in Connections first." : undefined}
                  onClick={() =>
                    void task("Restoring paused quarantine clone", async () => {
                      const entry = await workspace.createInvestigation(
                        await readSnapshot(inspect.id),
                        inspect,
                      );
                      onCloseInspection();
                      onOpenMachine(entry.id);
                    })
                  }
                >
                  {busy ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <ShieldCheck size={15} />
                  )}{" "}
                  Create paused quarantine clone
                </button>
              </footer>
            </>
          )}
        </Modal>
      )}
      {deleting && <DeleteResourceDialog key={deleting.key} request={deleting} revision={`${archiveRevision}:${workspaceWritable}`} onClose={() => setDeleting(null)} onDeleted={() => {
        setSelected((value) => value?.id === deleting.key ? null : value);
        setMessage(`${deleting.name} deleted. Mounted copies and source checkpoints were kept.`);
        setTaskError(false);
        setDeleting(null);
      }} />}

    </section>
  );
}
