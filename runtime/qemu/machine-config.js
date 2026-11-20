// SPDX-License-Identifier: Apache-2.0
import { DEFAULT_QEMU_BUNDLE_ID, LEGACY_QEMU_BUNDLE_ID, OWNED_QEMU_V2_BUNDLE_ID, OWNED_QEMU_BUNDLE_ID, SERVER_QEMU_BUNDLE_ID } from "./catalog.js";
import { getQemuBundle } from "./bundles.js";

export const X86_MACHINE_SCHEMA = "terrarium.x86-machine/v1";
export const X86_MACHINE_PRESETS = Object.freeze({
  small: Object.freeze({ id: "small", label: "Small", memoryMiB: 512, virtualCpus: 1, minimumWasmMiB: 2300, memoryLayout: "single-ram-block-v1", checkpointSupported: true }),
  worker: Object.freeze({ id: "worker", label: "Worker", memoryMiB: 1024, virtualCpus: 1, minimumWasmMiB: 2300, memoryLayout: "single-ram-block-v1", checkpointSupported: false }),
  server: Object.freeze({ id: "server", label: "Server", memoryMiB: 2048, virtualCpus: 2, minimumWasmMiB: 3584, memoryLayout: "split-2x1024m-ram-blocks-v1", checkpointSupported: false }),
});
const DISK_SLOTS = Object.freeze([Object.freeze({ slot: 0, serial: "terrarium-volume0" }), Object.freeze({ slot: 1, serial: "terrarium-volume1" })]);

function object(value, keys, label, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be a plain data object.`);
  const own = Reflect.ownKeys(value);
  if (own.some(key => typeof key !== "string" || !keys.includes(key) || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))
    || keys.some(key => !optional.includes(key) && !Object.hasOwn(value, key)))
    throw new Error(`${label} has missing, unknown or executable fields.`);
}
function array(value, expected, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== expected.length
    || Reflect.ownKeys(value).some(key => key !== "length" && !expected.map((_, i) => String(i)).includes(key)))
    throw new Error(`${label} does not match the supported topology.`);
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error(`${label} cannot contain accessors or holes.`);
  }
}
export function validMachineMac(value) {
  return typeof value === "string" && /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(value)
    && (parseInt(value.slice(0, 2), 16) & 1) === 0 && value !== "00:00:00:00:00:00";
}

/** UI, workspace, API and worker use this same data-only, fixed-preset contract. */
export function validateX86MachineConfiguration(value) {
  object(value, ["schema", "presetId", "runtimeBundleId", "image", "nic", "consoles", "diskSlots", "diskPolicy", "kernelSettings"], "Machine configuration");
  if (value.schema !== X86_MACHINE_SCHEMA || typeof value.presetId !== "string" || !Object.hasOwn(X86_MACHINE_PRESETS, value.presetId)) throw new Error("Unsupported x86_64 configuration schema or preset.");
  const preset = X86_MACHINE_PRESETS[value.presetId];
  const bundle = getQemuBundle(value.runtimeBundleId);
  if (preset.id === "small" && ![LEGACY_QEMU_BUNDLE_ID, OWNED_QEMU_V2_BUNDLE_ID, OWNED_QEMU_BUNDLE_ID].includes(bundle.id)) throw new Error("The small checkpoint-capable preset requires a separately qualified small runtime.");
  if (preset.id !== "small" && bundle.nodeAdapter !== "owned-minified-cpu-websocket-bindings-v1") throw new Error("Worker and server presets require an owned runtime.");
  if (preset.id === "worker" && bundle.id !== OWNED_QEMU_BUNDLE_ID) throw new Error("The worker preset requires its qualified owned runtime; installed bundles do not imply preset compatibility.");
  if (bundle.resources.reservedWasmMiB < preset.minimumWasmMiB) throw new Error(`${preset.label} requires a registered runtime reserving at least ${preset.minimumWasmMiB} MiB of Wasm memory. The selected build is too small.`);
  if (preset.id === "server" && (bundle.id !== SERVER_QEMU_BUNDLE_ID || bundle.machineMemoryLayout !== preset.memoryLayout)) throw new Error("The server preset requires its exact registered split-memory runtime; earlier candidates are not supported.");
  object(value.image, ["kind", "id"], "Boot image");
  if (value.image.kind === "builtin") {
    if (value.image.id !== bundle.id) throw new Error("The built-in image must match its pinned runtime bundle.");
  } else if (value.image.kind === "custom") {
    if (typeof value.image.id !== "string" || !/^[a-f0-9]{64}$/.test(value.image.id)) throw new Error("Choose a verified, content-addressed custom image.");
    if (bundle.nodeAdapter !== "owned-minified-cpu-websocket-bindings-v1") throw new Error("Custom images require an owned runtime with the Terrarium four-UART boot ABI.");
    if (preset.id === "small" && bundle.id !== OWNED_QEMU_BUNDLE_ID) throw new Error("Custom images on the small preset require the qualified owned runtime; historical runtimes remain available for their original built-in images and checkpoints.");
  } else throw new Error("Unsupported boot image kind.");
  object(value.nic, ["mac"], "NIC identity");
  if (!validMachineMac(value.nic.mac)) throw new Error("The NIC requires a lowercase unicast MAC address.");
  array(value.consoles, [0, 1, 2, 3], "Console layout");
  if (value.consoles.some((port, i) => port !== i)) throw new Error("Four fixed UARTs are required: command port 0 and shells 1–3.");
  array(value.diskSlots, DISK_SLOTS, "Disk slots");
  value.diskSlots.forEach((disk, i) => {
    object(disk, ["slot", "serial"], "Disk slot");
    if (disk.slot !== DISK_SLOTS[i].slot || disk.serial !== DISK_SLOTS[i].serial) throw new Error("Disk slot and serial mappings are fixed by the boot ABI.");
  });
  if (value.diskPolicy !== "persistent-mounts") throw new Error("This release uses explicit persistent data mounts and an ephemeral root overlay.");
  object(value.kernelSettings, ["hostname"], "Kernel settings", ["hostname"]);
  if (value.kernelSettings.hostname !== undefined && (typeof value.kernelSettings.hostname !== "string"
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.kernelSettings.hostname))) throw new Error("Choose a lowercase hostname of 1–63 letters, digits or internal hyphens.");
  return Object.freeze({ schema: X86_MACHINE_SCHEMA, presetId: preset.id, runtimeBundleId: bundle.id,
    image: Object.freeze({ ...value.image }), nic: Object.freeze({ mac: value.nic.mac }), consoles: Object.freeze([0, 1, 2, 3]),
    diskSlots: DISK_SLOTS, diskPolicy: "persistent-mounts", kernelSettings: Object.freeze({ ...value.kernelSettings }) });
}

export function defaultX86MachineConfiguration(options = {}) {
  object(options, ["runtimeBundleId", "mac", "presetId", "image", "hostname"], "Machine defaults", ["runtimeBundleId", "mac", "presetId", "image", "hostname"]);
  const presetId = options.presetId ?? "small";
  if (typeof presetId !== "string" || !Object.hasOwn(X86_MACHINE_PRESETS, presetId)) throw new Error("Choose a supported x86_64 preset.");
  const runtimeBundleId = options.runtimeBundleId ?? (presetId === "small" ? DEFAULT_QEMU_BUNDLE_ID : presetId === "worker" ? OWNED_QEMU_BUNDLE_ID
    : SERVER_QEMU_BUNDLE_ID);
  if (!runtimeBundleId) throw new Error("The server preset is unavailable until its larger owned runtime is installed and validated.");
  let mac = options.mac;
  if (mac === undefined) {
    const bytes = crypto.getRandomValues(new Uint8Array(6)); bytes[0] = (bytes[0] & 0xfc) | 2;
    mac = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join(":");
  }
  return validateX86MachineConfiguration({ schema: X86_MACHINE_SCHEMA, presetId, runtimeBundleId,
    image: options.image ?? { kind: "builtin", id: runtimeBundleId }, nic: { mac }, consoles: [0, 1, 2, 3], diskSlots: DISK_SLOTS,
    diskPolicy: "persistent-mounts", kernelSettings: options.hostname === undefined ? {} : { hostname: options.hostname } });
}

export function qemuPresetBootOptions(value) {
  const config = validateX86MachineConfiguration(value), preset = X86_MACHINE_PRESETS[config.presetId], bundle = getQemuBundle(config.runtimeBundleId);
  const hostname = config.kernelSettings.hostname ?? "terrarium";
  return Object.freeze({ memoryMiB: preset.memoryMiB, virtualCpus: preset.virtualCpus, memoryLayout: preset.memoryLayout,
    kernelAppend: `console=ttyS0 root=/dev/vda noautodetect hostname=${hostname} clocksource=tsc${preset.id === "small" ? " noapic" : ""} 8250.nr_uarts=4`,
    checkpointSupported: preset.checkpointSupported && config.image.kind === "builtin",
    reservedWasmMiB: bundle.resources.reservedWasmMiB, translationCacheMiB: bundle.resources.translationCacheMiB });
}

/** Canonical metadata is included in new checkpoint envelopes, not inferred from labels. */
export function machineCheckpointIdentity(value) { return validateX86MachineConfiguration(value); }
