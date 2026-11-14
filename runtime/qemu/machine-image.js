// SPDX-License-Identifier: Apache-2.0
// Data-only image policy shared by the UI importer and the QEMU worker.
export const MACHINE_IMAGE_SCHEMA = "terrarium.machine-image/v1";
export const MACHINE_IMAGE_MAGIC = "TRMIMG01";
export const MACHINE_IMAGE_LIMITS = Object.freeze({
  manifestBytes: 64 * 1024,
  kernelBytes: 64 * 1024 * 1024,
  initramfsBytes: 64 * 1024 * 1024,
  rootfsBytes: 512 * 1024 * 1024,
  chunkBytes: 1024 * 1024,
  provenanceInputs: 16,
});
export const MACHINE_IMAGE_MAX_BYTES = 12 + MACHINE_IMAGE_LIMITS.manifestBytes +
  MACHINE_IMAGE_LIMITS.kernelBytes + MACHINE_IMAGE_LIMITS.initramfsBytes + MACHINE_IMAGE_LIMITS.rootfsBytes;

function record(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error(`${label} must be a plain data record.`);
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key)))
    throw new Error(`${label} has missing or unsupported fields; executable code, paths, arguments, and backing references are not supported.`);
  for (const key of own) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error(`${label} cannot contain accessors.`);
  }
  return value;
}

function literal(value, expected, label) {
  if (value !== expected) throw new Error(`${label} must be ${expected}.`);
  return expected;
}

function text(value, length, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > length ||
      value.trim() !== value || /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value))
    throw new Error(`${label} must be bounded printable text.`);
  return value;
}

function token(value, length, label) {
  text(value, length, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes(".."))
    throw new Error(`${label} must be a safe identifier, not a path or URL.`);
  return value;
}

function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${label} is outside the supported size or value budget.`);
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function component(value, min, max, label) {
  const data = record(value, ["bytes", "sha256"], label);
  return Object.freeze({ bytes: integer(data.bytes, min, max, `${label} bytes`), sha256: digest(data.sha256, `${label} digest`) });
}

function inputArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length < 1 || value.length > MACHINE_IMAGE_LIMITS.provenanceInputs)
    throw new Error("Image provenance requires between one and sixteen plain pinned input records.");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => key !== "length" &&
      (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)))
    throw new Error("Provenance input arrays cannot have holes, symbols or extra fields.");
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("Provenance input arrays cannot contain accessors.");
  }
  return value;
}

/** No caller-supplied runtime, JavaScript, command line, path or network policy exists in this schema. */
export function validateMachineImageManifest(value) {
  const data = record(value, ["schema", "architecture", "integration", "guest", "devices", "boot", "components", "provenance"], "Image manifest");
  const guest = record(data.guest, ["name", "version", "kernelRelease", "identity"], "Guest identity");
  const devices = record(data.devices, ["machine", "root", "network", "serialPorts"], "Image devices");
  const boot = record(data.boot, ["initramfs", "rootFilesystem", "rootMode", "hostname"], "Safe boot policy");
  const components = record(data.components, ["kernel", "initramfs", "rootfs"], "Image components");
  const provenance = record(data.provenance, ["source", "recipe", "recipeSha256", "sourceDateEpoch", "inputs"], "Image provenance");
  const declaredInputs = inputArray(provenance.inputs);
  const inputNames = new Set();
  const inputs = declaredInputs.map((input) => {
    const item = record(input, ["name", "bytes", "sha256"], "Provenance input");
    const name = token(item.name, 160, "Provenance input name");
    if (inputNames.has(name)) throw new Error("Provenance input names must be unique.");
    inputNames.add(name);
    return Object.freeze({ name, bytes: integer(item.bytes, 1, Number.MAX_SAFE_INTEGER, "Provenance input bytes"), sha256: digest(item.sha256, "Provenance input digest") });
  });
  const hostname = text(boot.hostname, 63, "Guest hostname");
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(hostname)) throw new Error("Guest hostname must be one lowercase DNS label.");
  const rootfs = component(components.rootfs, 4 * 1024 * 1024, MACHINE_IMAGE_LIMITS.rootfsBytes, "Root filesystem");
  if (rootfs.bytes % 4096 !== 0) throw new Error("The raw ext4 root must have an integral number of 4 KiB blocks.");
  return Object.freeze({
    schema: literal(data.schema, MACHINE_IMAGE_SCHEMA, "Image schema"),
    architecture: literal(data.architecture, "x86_64", "Guest architecture"),
    integration: literal(data.integration, "terrarium-qemu-uart4-v1", "Guest integration ABI"),
    guest: Object.freeze({ name: text(guest.name, 80, "Guest name"), version: text(guest.version, 80, "Guest version"),
      kernelRelease: token(guest.kernelRelease, 80, "Guest kernel release"), identity: token(guest.identity, 160, "Guest identity") }),
    devices: Object.freeze({ machine: literal(devices.machine, "pc", "Machine type"), root: literal(devices.root, "virtio-blk-pci", "Root device"),
      network: literal(devices.network, "virtio-net-pci", "Network device"), serialPorts: literal(devices.serialPorts, 4, "Serial port count") }),
    boot: Object.freeze({ initramfs: literal(boot.initramfs, "alpine-overlay-v1", "Initramfs boot adapter"),
      rootFilesystem: literal(boot.rootFilesystem, "ext4", "Root filesystem format"), rootMode: literal(boot.rootMode, "ephemeral-overlay", "Root persistence policy"), hostname }),
    components: Object.freeze({ kernel: component(components.kernel, 1024, MACHINE_IMAGE_LIMITS.kernelBytes, "Linux kernel"),
      initramfs: component(components.initramfs, 18, MACHINE_IMAGE_LIMITS.initramfsBytes, "Initramfs"), rootfs }),
    provenance: Object.freeze({ source: text(provenance.source, 240, "Provenance source"), recipe: token(provenance.recipe, 160, "Provenance recipe"),
      recipeSha256: digest(provenance.recipeSha256, "Provenance recipe digest"),
      sourceDateEpoch: integer(provenance.sourceDateEpoch, 0, 4_102_444_800, "Provenance epoch"), inputs: Object.freeze(inputs) }),
  });
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Exact canonical bytes also reject duplicate JSON keys and ambiguous encodings during import. */
export function canonicalMachineImageManifest(value) {
  return canonical(validateMachineImageManifest(value));
}

/** Structural checks are deliberately narrower than arbitrary Linux/filesystem support. They are not fsck or a malware check. */
export function assertMachineImageComponentHeader(kind, bytes, totalBytes) {
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)) throw new Error("Image headers must be immutable-copy byte arrays, not shared memory.");
  if (!Number.isSafeInteger(totalBytes) || totalBytes < bytes.byteLength) throw new Error("Invalid image component length.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (kind === "kernel") {
    if (bytes.byteLength < 0x268 || totalBytes < 1024 || totalBytes > MACHINE_IMAGE_LIMITS.kernelBytes ||
        view.getUint16(0x1fe, true) !== 0xaa55 || view.getUint32(0x202, true) !== 0x53726448 ||
        view.getUint16(0x206, true) < 0x20c || !(view.getUint16(0x236, true) & 1))
      throw new Error("The kernel must be a Linux x86_64 bzImage with boot protocol 2.12 or later.");
    const setupBytes = ((bytes[0x1f1] || 4) + 1) * 512;
    const protectedBytes = view.getUint32(0x1f4, true) * 16;
    if (setupBytes > totalBytes || protectedBytes < 16 || setupBytes + protectedBytes > totalBytes)
      throw new Error("The kernel boot header declares an out-of-bounds protected-mode payload.");
  } else if (kind === "initramfs") {
    if (bytes.byteLength < 10 || totalBytes < 18 || totalBytes > MACHINE_IMAGE_LIMITS.initramfsBytes ||
        bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8 || (bytes[3] & 0xe0))
      throw new Error("The supported Alpine initramfs must be a bounded gzip stream.");
  } else if (kind === "rootfs") {
    if (bytes.byteLength < 2048 || totalBytes < 4 * 1024 * 1024 || totalBytes > MACHINE_IMAGE_LIMITS.rootfsBytes || totalBytes % 4096)
      throw new Error("The root must be a bounded raw ext4 filesystem, not a partitioned or backing-file disk.");
    const at = 1024;
    const compat = view.getUint32(at + 0x5c, true);
    const incompat = view.getUint32(at + 0x60, true);
    const roCompat = view.getUint32(at + 0x64, true);
    if (view.getUint16(at + 0x38, true) !== 0xef53 || view.getUint32(at + 0x18, true) !== 2 ||
        view.getUint32(at + 0x4c, true) !== 1 || view.getUint16(at + 0x58, true) !== 256 ||
        view.getUint32(at + 0x4, true) * 4096 !== totalBytes || view.getUint32(at + 0x150, true) !== 0 ||
        !(incompat & 0x40) || (compat & ~0x38) || (incompat & ~0x2c2) || (roCompat & ~0x46b) ||
        view.getUint16(at + 0x3a, true) !== 1 || view.getUint32(at + 0xe0, true) !== 0 || view.getUint32(at + 0xe4, true) !== 0 ||
        bytes.subarray(at + 0xd0, at + 0xe0).some((byte) => byte !== 0))
      throw new Error("The root requires clean ext4 with 4 KiB blocks, 256-byte inodes, supported features, exact size, and no journal or external dependencies.");
  } else throw new Error("Unknown image component.");
}
