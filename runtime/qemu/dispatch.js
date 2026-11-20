// SPDX-License-Identifier: Apache-2.0
import { startQemu } from "./engine.js";
import { getQemuBundle, assertQemuBundleManifest } from "./bundles.js";
import { assertQemuBootOptions } from "./options.js";
import { qemuPresetBootOptions, validateX86MachineConfiguration } from "./machine-config.js";

/** The same owned worker protocol is used by browser and real-kernel tests. */
export function createQemuDispatcher({ emit, close, isIsolated, loadBundle, loadModule, start = startQemu }) {
  let engine = null;
  let booted = false;
  let carrier = false;
  let closed = false;
  const send = (message, transfer = []) => { if (!closed) emit(message, transfer); };
  return async function receive(data) {
    if (closed) return;
    try {
      if (!data || typeof data !== "object") throw new Error("Invalid QEMU worker message.");
      if (data.type === "boot") {
        if (booted) throw new Error("This worker already owns a machine.");
        booted = true;
        assertQemuBootOptions(data);
        const bundle = getQemuBundle(data.runtimeBundleId);
        const machine = data.machine === undefined ? null : validateX86MachineConfiguration(data.machine);
        const hardware = machine ? qemuPresetBootOptions(machine) : null;
        if (data.profileId !== bundle.profileId || data.memoryMiB !== (hardware?.memoryMiB ?? bundle.memoryMiB))
          throw new Error("Unsupported QEMU machine profile.");
        if (machine) {
          if (machine.runtimeBundleId !== bundle.id || machine.nic.mac !== data.mac)
            throw new Error("The configured runtime and NIC identity must match this worker boot.");
          if (machine.image.kind === "custom" ? data.customImage?.id !== machine.image.id : data.customImage !== undefined)
            throw new Error("The verified boot image must match the machine configuration.");
          if (data.checkpoint !== undefined && !hardware.checkpointSupported)
            throw new Error("RAM checkpoints are unsupported for this hardware or custom boot image; use persistent data mounts.");
        } else if (bundle.memoryMiB !== 512 || bundle.virtualCpus !== 1 || data.customImage !== undefined) {
          throw new Error("A versioned machine configuration is required for changed hardware or custom images.");
        }
        if (!isIsolated() || typeof SharedArrayBuffer === "undefined") throw new Error("The worker requires cross-origin isolation and shared memory.");
        const { manifest, pthreadUrl } = await loadBundle(bundle);
        if (closed) return;
        assertQemuBundleManifest(manifest, bundle);
        engine = await start({ ...data, manifest, assets: data }, { emit: send, loadModule, pthreadUrl });
        if (closed) { await engine.destroy(); return; }
        if (data.checkpoint instanceof ArrayBuffer) await engine.restoreCheckpoint();
        if (closed) { await engine.destroy(); return; }
        engine.carrier(carrier);
        send({ type: "initialized" });
      } else if (data.type === "carrier") {
        carrier = !!data.enabled; engine?.carrier(carrier);
      } else if (data.type === "network" && data.frame instanceof ArrayBuffer) {
        engine?.network(new Uint8Array(data.frame));
      } else if (data.type === "input" && typeof data.text === "string") {
        engine?.input(data.text, data.port ?? 0);
      } else if (data.type === "pause" || data.type === "resume") {
        if (!engine) throw new Error("The emulator is not initialized.");
        await engine[data.type](); send({ type: "ack", id: data.id });
      } else if (data.type === "flush-disks") {
        if (!engine) throw new Error("The emulator is not initialized.");
        await engine.flushDisks(); send({ type: "ack", id: data.id });
      } else if (data.type === "save-checkpoint") {
        if (!engine) throw new Error("The emulator is not initialized.");
        const buffer = await engine.saveCheckpoint();
        send({ type: "ack", id: data.id, buffer }, [buffer]);
      } else if (data.type === "inspect-registers") {
        if (!engine) throw new Error("The emulator is not initialized.");
        const registers = await engine.inspectRegisters();
        send({ type: "ack", id: data.id, registers });
      } else if (data.type === "inspect-resources") {
        if (!engine) throw new Error("The emulator is not initialized.");
        const resources = await engine.inspectResources();
        send({ type: "ack", id: data.id, resources });
      } else if (data.type === "destroy") {
        await engine?.destroy(); send({ type: "ack", id: data.id });
        closed = true; close();
      } else {
        throw new Error("Unsupported QEMU worker message.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (data?.type === "save-checkpoint" && error?.code === "checkpoint_rejected") {
        send({ type: "control-error", id: data.id, code: "checkpoint_rejected", message: message.slice(0, 4096) });
      } else {
        send({ type: "error", message });
      }
    }
  };
}
