// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, Save, Trash2, Upload } from "lucide-react";
import type { ManagedMachine } from "../lib/machines";
import { cloud } from "../lib/control-plane";
import { DEFAULT_QEMU_BUNDLE_ID, OWNED_QEMU_BUNDLE_ID } from "../lib/qemu-assets";
import { defaultX86MachineConfiguration, migratedMachineMac, qemuPresetBootOptions, validateX86MachineConfiguration,
  X86_MACHINE_PRESETS, type X86MachineConfiguration, type X86MachinePresetId } from "../lib/x86-machine-config";
import { validateMachineName } from "../lib/machine-config";
import { MACHINE_IMAGE_MAX_BYTES, MACHINE_IMAGE_MIME } from "../lib/machine-image";
import { subscribeMachineImageChanges, type MachineImageMeta } from "../lib/machine-image-store";
import { downloadFile } from "../lib/snapshots";
import { DeleteResourceDialog, type DeleteResourceRequest } from "./DeleteResourceDialog";
import "./MachineHardwareSettings.css";

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function MachineHardwareSettings({ machine, name, onNameChange, writable, revision, deleteDisabled,
  onDelete, onSaved, onBusyChange }: {
  machine: ManagedMachine;
  name: string;
  onNameChange: (name: string) => void;
  writable: boolean;
  revision: string;
  deleteDisabled: boolean;
  onDelete: () => void;
  onSaved: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [draft, setDraft] = useState<X86MachineConfiguration>(() => machine.config.x86 ?? defaultX86MachineConfiguration({
    runtimeBundleId: DEFAULT_QEMU_BUNDLE_ID, mac: migratedMachineMac(machine.id),
  }));
  const [hostname, setHostname] = useState(draft.kernelSettings.hostname ?? "terrarium");
  const [images, setImages] = useState<MachineImageMeta[]>([]);
  const [imagesLoading, setImagesLoading] = useState(true);
  const [imagesError, setImagesError] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const [deletion, setDeletion] = useState<DeleteResourceRequest | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const listSequence = useRef(0);
  const runtime = machine.runtime.getSnapshot();
  const stopped = runtime.status === "idle" && machine.lifecycle === "ready" && !machine.runner.isBusy() &&
    !runtime.operation && !runtime.volumeOperation && !runtime.acquiringEvidence;
  const editable = writable && stopped && !busy;
  const selectedImage = draft.image.kind === "custom" ? images.find((image) => image.id === draft.image.id) : undefined;
  const preset = X86_MACHINE_PRESETS[draft.presetId];
  let validated: X86MachineConfiguration | null = null;
  let configurationError = "";
  try {
    validateMachineName(name);
    validated = validateX86MachineConfiguration({ ...draft, kernelSettings: hostname ? { hostname } : {} });
    if (draft.image.kind === "custom" && !imagesLoading && !selectedImage)
      throw new Error("The selected custom image is unavailable. Choose an existing image before saving.");
  } catch (error) { configurationError = message(error); }
  const boot = validated ? qemuPresetBootOptions(validated) : null;
  const checkpointSupported = Boolean(boot?.checkpointSupported && machine.config.volumes.length === 0 && !machine.investigation && !machine.evidence);
  let serverUnavailable = "";
  try { defaultX86MachineConfiguration({ presetId: "server", mac: draft.nic.mac }); }
  catch (error) { serverUnavailable = message(error); }

  async function refreshImages() {
    const sequence = ++listSequence.current;
    if (mounted.current) setImagesLoading(true);
    try {
      const saved = await cloud.machineImages.list();
      if (mounted.current && sequence === listSequence.current) { setImages(saved); setImagesError(""); }
    } catch (error) {
      if (mounted.current && sequence === listSequence.current) { setImages([]); setImagesError(message(error)); }
    } finally { if (mounted.current && sequence === listSequence.current) setImagesLoading(false); }
  }

  useEffect(() => {
    mounted.current = true;
    void refreshImages();
    const unsubscribe = subscribeMachineImageChanges(() => { void refreshImages(); });
    return () => { mounted.current = false; listSequence.current += 1; unsubscribe(); };
  }, []);
  useEffect(() => { onBusyChange(Boolean(busy || deletion)); }, [busy, deletion, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  async function perform(label: string, work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(label); setNotice(null);
    try { await work(); }
    catch (error) { if (mounted.current) setNotice({ message: message(error), error: true }); }
    finally { pending.current = false; if (mounted.current) setBusy(""); }
  }

  function choosePreset(presetId: X86MachinePresetId) {
    try {
      const next = defaultX86MachineConfiguration({ presetId, mac: draft.nic.mac,
        ...(presetId === "small" && draft.image.kind === "builtin" ? { runtimeBundleId: DEFAULT_QEMU_BUNDLE_ID } : {}),
        ...(draft.image.kind === "custom" ? { image: draft.image, ...(presetId === "small" ? { runtimeBundleId: OWNED_QEMU_BUNDLE_ID } : {}) } : {}),
        ...(hostname ? { hostname } : {}) });
      setDraft(next); setNotice(null);
    } catch (error) { setNotice({ message: message(error), error: true }); }
  }

  function chooseImage(value: string) {
    try {
      if (value === "builtin") {
        setDraft(validateX86MachineConfiguration({ ...draft, image: { kind: "builtin", id: draft.runtimeBundleId }, kernelSettings: { hostname: "terrarium" } }));
        setHostname("terrarium");
      } else {
        const image = images.find((item) => item.id === value);
        if (!image) throw new Error("That image is no longer available. Refresh the saved image list.");
        const next = defaultX86MachineConfiguration({ presetId: draft.presetId, mac: draft.nic.mac,
          runtimeBundleId: draft.presetId === "small" ? OWNED_QEMU_BUNDLE_ID : draft.runtimeBundleId,
          image: { kind: "custom", id: image.id }, hostname: image.manifest.boot.hostname });
        setDraft(next); setHostname(image.manifest.boot.hostname);
      }
      setNotice(null);
    } catch (error) { setNotice({ message: message(error), error: true }); }
  }

  function reviewDelete(image: MachineImageMeta) {
    setDeletion({ key: image.id, kind: "machine image", name: image.name,
      description: "Remove this independent saved image only after all dependent machine definitions have been changed or deleted.",
      preview: () => cloud.deletions.preview({ type: "image", id: image.id }),
      remove: () => cloud.machineImages.delete(image.id, { ifSha256: image.id }).wait() });
  }

  return <div className="hardware-settings">
    <div className="machine-form">
      <label htmlFor="edit-machine-name">Name</label>
      <input id="edit-machine-name" value={name} onChange={(event) => onNameChange(event.target.value)} maxLength={32}
        spellCheck={false} disabled={!editable} autoFocus />
    </div>
    {!writable && <p className="small-print" role="status">This workspace is read-only. Take control before changing a machine or saved image.</p>}
    {!stopped && <p className="small-print" role="status">Stop this machine and finish its current operations before changing hardware, name, or boot image.</p>}
    <div className="hardware-settings-grid">
      <label htmlFor="x86-machine-preset">x86_64 preset
        <select id="x86-machine-preset" aria-label="x86_64 preset" value={draft.presetId} disabled={!editable}
          onChange={(event) => choosePreset(event.target.value as X86MachinePresetId)}>
          {Object.values(X86_MACHINE_PRESETS).map((item) => <option key={item.id} value={item.id} disabled={item.id === "server" && Boolean(serverUnavailable)}>
            {item.label} · {item.virtualCpus} vCPU · {item.memoryMiB} MiB{item.id === "server" && serverUnavailable ? " · runtime unavailable" : ""}
          </option>)}
        </select>
      </label>
      <label htmlFor="x86-machine-image">Boot image
        <select id="x86-machine-image" aria-label="Boot image" value={draft.image.kind === "builtin" ? "builtin" : draft.image.id}
          disabled={!editable || imagesLoading} onChange={(event) => chooseImage(event.target.value)}>
          <option value="builtin">Built-in pinned Linux image</option>
          {draft.image.kind === "custom" && !selectedImage && <option value={draft.image.id}>Selected image unavailable · {draft.image.id.slice(0, 12)}</option>}
          {images.map((image) => <option key={image.id} value={image.id}>{image.name} · {image.id.slice(0, 12)}</option>)}
        </select>
      </label>
      <label htmlFor="x86-machine-hostname">Guest hostname
        <input id="x86-machine-hostname" value={hostname} maxLength={63} spellCheck={false} disabled={!editable || draft.image.kind === "custom"}
          onChange={(event) => setHostname(event.target.value)} />
      </label>
      <label htmlFor="x86-machine-mac">Stable NIC address
        <input id="x86-machine-mac" value={draft.nic.mac} readOnly spellCheck={false} />
      </label>
    </div>
    {serverUnavailable && <p className="small-print">Server preset: {serverUnavailable}</p>}
    {configurationError && <p className="error-text" role="alert">{configurationError}</p>}
    <div className="hardware-image-identity" role="status" aria-label="Selected image identity">
      <strong>{selectedImage?.name ?? (draft.image.kind === "builtin" ? "Built-in pinned Linux image" : "Selected custom image")}</strong>
      <code>{draft.image.id}</code>
      {selectedImage && <span>{selectedImage.manifest.guest.identity} · Linux {selectedImage.manifest.guest.kernelRelease}</span>}
    </div>
    <p className="small-print">Root writes use a temporary overlay and disappear on a fresh boot. Keep application data on explicitly attached persistent volumes. Architecture remains x86_64.</p>
    <p className="small-print">{checkpointSupported
      ? "This small built-in configuration supports full-machine checkpoints while no external volumes or evidence disks are attached."
      : "Full-machine RAM checkpoints are unavailable for this configuration. Custom images, larger presets, and attached external disks require separate persistent-data preservation."}</p>
    <details className="new-script-details">
      <summary>Hardware and boot contract</summary>
      <dl className="runtime-facts">
        <div><dt>Requested hardware</dt><dd>{preset.virtualCpus} vCPU · {preset.memoryMiB} MiB RAM</dd></div>
        <div><dt>Runtime</dt><dd><code>{draft.runtimeBundleId}</code></dd></div>
        <div><dt>Reserved runtime memory</dt><dd>{boot?.reservedWasmMiB ?? "Unavailable"} MiB, plus imported image bytes and app storage buffers</dd></div>
        <div><dt>Consoles</dt><dd>UART 0 for commands; UARTs 1–3 for independent shells</dd></div>
        <div><dt>Data disks</dt><dd>{draft.diskSlots.map((disk) => `${disk.slot}: ${disk.serial}`).join("; ")}</dd></div>
        <div><dt>Root and NIC</dt><dd>Read-only base over virtio block{selectedImage ? " (raw ext4)" : ""}; virtio network device</dd></div>
        <div><dt>Safe boot settings</dt><dd><code>{boot?.kernelAppend ?? "Fix the settings above."}</code></dd></div>
      </dl>
    </details>
    <section className="hardware-image-manager" aria-label="Saved Linux images">
      <h3>Saved Linux images</h3>
      <p className="small-print">Import a data-only .trmimg bundle: x86_64 kernel up to 64 MiB, Alpine-compatible initramfs up to 64 MiB, raw ext4 root up to 512 MiB. Saved image budget: eight bundles and 1 GiB total.</p>
      <label htmlFor="linux-image-bundle">Import Linux image bundle</label>
      <input ref={fileInput} id="linux-image-bundle" type="file" accept=".trmimg,application/vnd.terrarium.machine-image"
        disabled={!writable || Boolean(busy)} onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          if (file && (file.size < 12 || file.size > MACHINE_IMAGE_MAX_BYTES)) {
            setSelectedFile(null); event.target.value = ""; setNotice({ message: "Choose an image bundle within the declared component budgets.", error: true });
          } else { setSelectedFile(file); setNotice(null); }
        }} />
      {selectedFile && <div className="hardware-image-actions">
        <span className="small-print">{selectedFile.name} · {(selectedFile.size / 1048576).toFixed(1)} MiB</span>
        <button className="button small secondary" disabled={!writable || Boolean(busy)} onClick={() => {
          void perform("Verifying and saving image…", async () => {
            const saved = await (await cloud.machineImages.import(selectedFile)).wait();
            await refreshImages();
            if (mounted.current) { setSelectedFile(null); if (fileInput.current) fileInput.current.value = "";
              setNotice({ message: `${saved.name} was saved. Select it as the boot image and save the machine configuration to apply it.`, error: false }); }
          });
        }}><Upload size={14} />Import image</button>
        <button className="button small ghost" disabled={Boolean(busy)} onClick={() => { setSelectedFile(null); if (fileInput.current) fileInput.current.value = ""; }}>Clear file</button>
      </div>}
      {imagesLoading && <p className="small-print" role="status">Loading saved image metadata…</p>}
      {imagesError && <div role="alert"><p className="error-text">Saved images could not be read: {imagesError}</p>
        <button className="button small secondary" disabled={Boolean(busy)} onClick={() => { void refreshImages(); }}>Retry image list</button></div>}
      {!imagesLoading && !imagesError && images.length === 0 && <p className="small-print">No custom Linux images are saved.</p>}
      {images.map((image) => <div className="hardware-saved-image" key={image.id}>
        <div><strong>{image.name}</strong><span>{(image.totalBytes / 1048576).toFixed(1)} MiB · {image.id.slice(0, 12)}</span></div>
        <div className="hardware-image-actions">
          <button className="button small ghost" disabled={Boolean(busy)} aria-label={`Export ${image.name}`} onClick={() => {
            void perform("Verifying image for export…", async () => {
              const blob = await cloud.machineImages.export(image.id);
              downloadFile(`${image.manifest.guest.identity}.trmimg`, blob, MACHINE_IMAGE_MIME);
              if (mounted.current) setNotice({ message: "Verified image export is ready in your browser downloads.", error: false });
            });
          }}><Download size={14} />Export</button>
          <button className="button small ghost danger-hover" disabled={!writable || Boolean(busy)} aria-label={`Delete ${image.name}`} onClick={() => reviewDelete(image)}><Trash2 size={14} />Delete</button>
        </div>
      </div>)}
    </section>
    {busy && <p className="hardware-operation small-print" role="status"><LoaderCircle className="spin" size={15} />{busy} This operation cannot be cancelled after it starts; keep this dialog open until it completes.</p>}
    {notice && <p className={notice.error ? "error-text" : "small-print"} role={notice.error ? "alert" : "status"}>{notice.message}</p>}
    <footer className="modal-footer">
      <button className="button ghost danger-hover" disabled={deleteDisabled || Boolean(busy)} onClick={onDelete}><Trash2 size={15} />Delete machine</button>
      <button className="button primary" disabled={!editable || Boolean(configurationError) || !validated || (draft.image.kind === "custom" && imagesLoading)} onClick={() => {
        void perform("Saving machine configuration…", async () => {
          const machineConfiguration = validateX86MachineConfiguration({ ...draft, kernelSettings: hostname ? { hostname } : {} });
          await cloud.instances.update(machine.id, { name: validateMachineName(name), machine: machineConfiguration }).wait();
          if (mounted.current) onSaved();
        });
      }}><Save size={15} />Save machine configuration</button>
    </footer>
    {deletion && <DeleteResourceDialog request={deletion} revision={revision} onClose={() => setDeletion(null)} onDeleted={() => {
      setDeletion(null); void refreshImages(); setNotice({ message: "The independent saved image was deleted. Existing machine definitions were checked before deletion.", error: false });
    }} />}
  </div>;
}
