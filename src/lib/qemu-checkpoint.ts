// SPDX-License-Identifier: Apache-2.0
import { LEGACY_QEMU_BUNDLE_ID, getQemuBundle, isSupportedQemuBundleId, type QemuBundleId, type QemuRuntimeBundle } from "./qemu-assets.ts";
import { defaultX86MachineConfiguration, validateX86MachineConfiguration, qemuPresetBootOptions, type X86MachineConfiguration } from "./x86-machine-config.ts";

/** Historical compatibility constant. It must not follow a future boot-default switch. */
export const QEMU_RUNTIME_VERSION = LEGACY_QEMU_BUNDLE_ID;
export const MAX_QEMU_CHECKPOINT_PAYLOAD_BYTES = 768 * 1024 * 1024;
export const MAX_QEMU_CHECKPOINT_METADATA_BYTES = 16 * 1024;
export const QEMU_CHECKPOINT_HEADER_BYTES = 24;
export const MAX_QEMU_CHECKPOINT_BYTES = MAX_QEMU_CHECKPOINT_PAYLOAD_BYTES + MAX_QEMU_CHECKPOINT_METADATA_BYTES + QEMU_CHECKPOINT_HEADER_BYTES;
const MAGIC = new TextEncoder().encode("TRMQEMU1");
const PROFILE = "alpine-x86_64" as const;
const CLUSTER = 65_536;
function guestHashes(bundle: QemuRuntimeBundle): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(bundle.assets)
    .filter(([name]) => name !== "wasm").map(([name, asset]) => [name, asset.sha256])));
}

export interface QemuCheckpointManifest {
  kind: "terrarium-qemu-checkpoint";
  version: 1 | 2;
  /** v1 is the historical fixed small topology; v2 binds the actual configuration. */
  machine?: X86MachineConfiguration;
  profileId: typeof PROFILE;
  runtimeVersion: QemuBundleId;
  architecture: "x86_64";
  memoryMiB: 512;
  serialPorts: 4;
  mac: string;
  createdAt: number;
  emulatorSha256: string;
  guestSha256: Readonly<Record<string, string>>;
  payload: { kind: "qcow2-internal-snapshot"; bytes: number; sha256: string; snapshot: "terrarium" };
  /** Host monitor observations captured while the VM was paused; not an attestation. */
  registers: string | null;
}
export interface QemuCheckpoint {
  manifest: QemuCheckpointManifest;
  payload: ArrayBuffer;
  /** Stable full container used for provenance hashing. */
  buffer: ArrayBuffer;
}
export interface CheckpointCpu {
  instructionPointer: string | number | null;
  previousInstructionPointer: string | number | null;
  privilegeLevel: number | null;
  protectedMode: boolean | null;
  halted: boolean | null;
  generalRegisters: Record<string, string | number> | null;
}

function invalid(reason: string): Error { return new Error(`This is not a compatible Terrarium x86_64 checkpoint: ${reason}`); }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === names.length && keys.every((key) => names.includes(key));
}
function validMac(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(value) && (parseInt(value.slice(0, 2), 16) & 1) === 0 && value !== "00:00:00:00:00:00";
}
async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Checkpoint integrity checking requires HTTPS or localhost.");
  const result = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(result, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isQemuCheckpoint(input: ArrayBuffer): boolean {
  return input instanceof ArrayBuffer && input.byteLength >= MAGIC.length && MAGIC.every((value, index) => new Uint8Array(input, 0, MAGIC.length)[index] === value);
}

/** Bound the dedicated qcow2 state container before the native QEMU decoder sees it. */
export function validateQemuStateDisk(input: ArrayBuffer | Uint8Array<ArrayBuffer>): void {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 4 * CLUSTER || bytes.byteLength > MAX_QEMU_CHECKPOINT_PAYLOAD_BYTES || bytes.byteLength % CLUSTER !== 0)
    throw invalid("the state disk has an unsupported length.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const number64 = (offset: number): number => {
    const value = view.getBigUint64(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid("a state disk offset is too large.");
    return Number(value);
  };
  const range = (offset: number, length: number, alignment = CLUSTER): void => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < CLUSTER || length < 0 || offset % alignment || offset + length > bytes.byteLength)
      throw invalid("a state disk table is outside the file.");
  };
  if (view.getUint32(0) !== 0x514649fb || view.getUint32(4) !== 3 ||
      number64(8) !== 0 || view.getUint32(16) !== 0 || view.getUint32(20) !== 16 ||
      number64(24) !== 8 * 1024 * 1024 || view.getUint32(32) !== 0 ||
      view.getBigUint64(72) !== 0n || view.getBigUint64(80) !== 0n || view.getBigUint64(88) !== 0n ||
      view.getUint32(96) !== 4 || view.getUint32(100) !== 104)
    throw invalid("the state disk differs from the pinned unencrypted, self-contained qcow2 profile.");
  // No header extensions, external data files, backing paths, or alternate compression formats.
  if (view.getUint32(104) !== 0 || view.getUint32(108) !== 0)
    throw invalid("state disk extensions are not supported.");
  const l2Tables = new Set<number>();
  const validateL1 = (offset: number, size: number): void => {
    if (!Number.isSafeInteger(size) || size < 1 || size > 1024) throw invalid("the state disk L1 table is too large.");
    range(offset, size * 8);
    for (let index = 0; index < size; index++) {
      const entry = view.getBigUint64(offset + index * 8);
      const address = entry & 0x7fffffffffffffffn;
      if (!address) continue;
      if (address > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid("the state disk L1 address is invalid.");
      const l2 = Number(address); range(l2, CLUSTER); l2Tables.add(l2);
      if (l2Tables.size > 64) throw invalid("the state disk has too many L2 tables.");
    }
  };
  validateL1(number64(40), view.getUint32(36));
  const refcountClusters = view.getUint32(56);
  if (refcountClusters < 1 || refcountClusters > 4) throw invalid("the state disk refcount table is too large.");
  const refcounts = number64(48); range(refcounts, refcountClusters * CLUSTER);
  for (let index = 0; index < refcountClusters * CLUSTER / 8; index++) {
    const offset = number64(refcounts + index * 8);
    if (offset) range(offset, CLUSTER);
  }
  if (view.getUint32(60) !== 1) throw invalid("the state disk must contain exactly one named VM checkpoint.");
  const snapshot = number64(64); range(snapshot, 40, 8);
  const idBytes = view.getUint16(snapshot + 12), nameBytes = view.getUint16(snapshot + 14), extraBytes = view.getUint32(snapshot + 36);
  if (idBytes < 1 || idBytes > 64 || nameBytes !== 9 || extraBytes > 4096)
    throw invalid("the state disk checkpoint entry is malformed.");
  range(snapshot, 40 + extraBytes + idBytes + nameBytes, 8);
  const nameOffset = snapshot + 40 + extraBytes + idBytes;
  if (new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(nameOffset, nameOffset + nameBytes)) !== "terrarium")
    throw invalid("the state disk checkpoint name differs.");
  validateL1(number64(snapshot), view.getUint32(snapshot + 8));
  for (const table of l2Tables) {
    for (let index = 0; index < CLUSTER / 8; index++) {
      const entry = view.getBigUint64(table + index * 8);
      // Fixed profile uses ordinary uncompressed clusters; zero-cluster bit is permitted.
      if (entry & 0x4000000000000000n) throw invalid("compressed state disk clusters are not supported.");
      const address = entry & 0x7ffffffffffffffen;
      if (!address) continue;
      if (address > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid("the state disk L2 address is invalid.");
      range(Number(address), CLUSTER);
    }
  }
}

function validateManifest(value: unknown, payloadBytes: number): QemuCheckpointManifest {
  if (!record(value) || !exactKeys(value, ["kind", "version", "profileId", "runtimeVersion", "architecture", "memoryMiB", "serialPorts", "mac", "createdAt", "emulatorSha256", "guestSha256", "payload", "registers", ...(value.version === 2 ? ["machine"] : [])]))
    throw invalid("the manifest fields are missing or unknown.");
  if (!isSupportedQemuBundleId(value.runtimeVersion)) throw invalid("the runtime identity is unknown or differs from supported bundles.");
  const bundle = getQemuBundle(value.runtimeVersion);
  if (value.kind !== "terrarium-qemu-checkpoint" || (value.version !== 1 && value.version !== 2) || value.profileId !== bundle.profileId ||
      value.architecture !== bundle.architecture || value.memoryMiB !== 512 || bundle.memoryMiB !== 512 || value.serialPorts !== bundle.serialPorts ||
      value.emulatorSha256 !== bundle.assets.wasm.sha256 || !validMac(value.mac) || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) <= 0)
    throw invalid("the machine, runtime, network identity or hardware profile differs.");
  const machine = value.version === 2 ? validateX86MachineConfiguration(value.machine)
    : defaultX86MachineConfiguration({ runtimeBundleId: bundle.id, mac: value.mac as string });
  if (!qemuPresetBootOptions(machine).checkpointSupported || machine.runtimeBundleId !== bundle.id || machine.nic.mac !== value.mac)
    throw invalid("the checkpoint configuration has no validated RAM restore path.");
  const recordedGuest = value.guestSha256;
  const expectedGuest = guestHashes(bundle);
  if (!record(recordedGuest) || !exactKeys(recordedGuest, Object.keys(expectedGuest)) ||
      Object.entries(expectedGuest).some(([name, hash]) => recordedGuest[name] !== hash))
    throw invalid("the checkpoint's guest assets differ from the pinned profile.");
  const payload = value.payload;
  if (!record(payload) || !exactKeys(payload, ["kind", "bytes", "sha256", "snapshot"]) ||
      payload.kind !== "qcow2-internal-snapshot" || payload.bytes !== payloadBytes || payload.snapshot !== "terrarium" ||
      typeof payload.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(payload.sha256))
    throw invalid("the state disk preservation record is invalid.");
  if (value.registers !== null && (typeof value.registers !== "string" || value.registers.length > 8192 || /[^\x09\x0a\x0d\x20-\x7e]/.test(value.registers)))
    throw invalid("the saved monitor observations are malformed.");
  return Object.freeze({ ...value, ...(value.version === 2 ? { machine } : {}), guestSha256: Object.freeze({ ...recordedGuest }), payload: Object.freeze({ ...payload }) }) as unknown as QemuCheckpointManifest;
}

function decode(input: ArrayBuffer): { manifest: QemuCheckpointManifest; payloadOffset: number; payloadBytes: number } {
  if (!isQemuCheckpoint(input) || input.byteLength < QEMU_CHECKPOINT_HEADER_BYTES || input.byteLength > MAX_QEMU_CHECKPOINT_BYTES)
    throw invalid("choose a complete Terrarium x86_64 checkpoint within the supported size.");
  const header = new DataView(input, 0, QEMU_CHECKPOINT_HEADER_BYTES);
  const metadataBytes = header.getUint32(12, true), payloadBytes = header.getUint32(16, true);
  if (header.getUint32(8, true) !== 1 || header.getUint32(20, true) !== 0 ||
      metadataBytes < 1 || metadataBytes > MAX_QEMU_CHECKPOINT_METADATA_BYTES ||
      payloadBytes < 1 || payloadBytes > MAX_QEMU_CHECKPOINT_PAYLOAD_BYTES ||
      QEMU_CHECKPOINT_HEADER_BYTES + metadataBytes + payloadBytes !== input.byteLength)
    throw invalid("the checkpoint header or declared lengths are invalid.");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(input, QEMU_CHECKPOINT_HEADER_BYTES, metadataBytes))); }
  catch { throw invalid("the manifest is not valid UTF-8 JSON."); }
  const manifest = validateManifest(value, payloadBytes);
  const payloadOffset = QEMU_CHECKPOINT_HEADER_BYTES + metadataBytes;
  validateQemuStateDisk(new Uint8Array(input, payloadOffset, payloadBytes));
  return { manifest, payloadOffset, payloadBytes };
}

export async function createQemuCheckpoint(input: ArrayBuffer, options: { runtimeBundleId: QemuBundleId; mac: string; machine?: X86MachineConfiguration; registers?: string | null; createdAt?: number }): Promise<ArrayBuffer> {
  // The caller must name the runtime that actually produced these bytes.
  // Falling back to a boot default could relabel a restored legacy machine.
  const bundle = getQemuBundle(options.runtimeBundleId);
  if (!(input instanceof ArrayBuffer)) throw invalid("the emulator returned no state disk.");
  validateQemuStateDisk(input);
  const payload = new Uint8Array(input.slice(0));
  const manifest = validateManifest({
    kind: "terrarium-qemu-checkpoint", version: options.machine ? 2 : 1, ...(options.machine ? { machine: options.machine } : {}), profileId: bundle.profileId, runtimeVersion: bundle.id,
    architecture: bundle.architecture, memoryMiB: bundle.memoryMiB, serialPorts: bundle.serialPorts, mac: options.mac, createdAt: options.createdAt ?? Date.now(),
    emulatorSha256: bundle.assets.wasm.sha256, guestSha256: guestHashes(bundle),
    payload: { kind: "qcow2-internal-snapshot", bytes: payload.length, sha256: await digest(payload), snapshot: "terrarium" },
    registers: options.registers ?? null,
  }, payload.length);
  const metadata = new TextEncoder().encode(JSON.stringify(manifest));
  if (metadata.length > MAX_QEMU_CHECKPOINT_METADATA_BYTES) throw invalid("the manifest is too large.");
  const output = new Uint8Array(QEMU_CHECKPOINT_HEADER_BYTES + metadata.length + payload.length);
  output.set(MAGIC);
  const header = new DataView(output.buffer);
  header.setUint32(8, 1, true); header.setUint32(12, metadata.length, true); header.setUint32(16, payload.length, true);
  output.set(metadata, QEMU_CHECKPOINT_HEADER_BYTES); output.set(payload, QEMU_CHECKPOINT_HEADER_BYTES + metadata.length);
  return output.buffer;
}

export async function parseQemuCheckpoint(input: ArrayBuffer): Promise<QemuCheckpoint> {
  decode(input); // Bound and reject incompatible input before the private copy and hashing.
  const original = input.slice(0);
  const { manifest, payloadOffset, payloadBytes } = decode(original);
  const payload = original.slice(payloadOffset, payloadOffset + payloadBytes);
  if (await digest(new Uint8Array(payload)) !== manifest.payload.sha256)
    throw invalid("the state disk failed SHA-256 verification. It has not been loaded.");
  return { manifest, payload, buffer: original };
}

export function inspectQemuRegisters(registers: string | null): CheckpointCpu {
  const empty: CheckpointCpu = { instructionPointer: null, previousInstructionPointer: null, privilegeLevel: null, protectedMode: null, halted: null, generalRegisters: null };
  if (!registers) return empty;
  const values = new Map<string, string>();
  for (const match of registers.matchAll(/\b(RAX|RBX|RCX|RDX|RSI|RDI|RBP|RSP|R8|R9|R10|R11|R12|R13|R14|R15|RIP|CR0|CPL|HLT)[ \t]{0,4}=([0-9a-fA-F]+)\b/g)) {
    if (values.has(match[1])) return empty;
    values.set(match[1], match[2]);
  }
  const hex = (name: string): string | null => {
    const value = values.get(name);
    return value && /^[0-9a-fA-F]{1,16}$/.test(value) ? `0x${value.toLowerCase().padStart(16, "0")}` : null;
  };
  const names = ["RAX", "RBX", "RCX", "RDX", "RSI", "RDI", "RBP", "RSP", "R8", "R9", "R10", "R11", "R12", "R13", "R14", "R15"];
  const general = names.every((name) => hex(name)) ? Object.fromEntries(names.map((name) => [name.toLowerCase(), hex(name)!])) : null;
  const cr0 = hex("CR0"), cpl = values.get("CPL"), hlt = values.get("HLT");
  return {
    ...empty, instructionPointer: hex("RIP"), generalRegisters: general,
    privilegeLevel: cpl && /^[0-3]$/.test(cpl) ? Number(cpl) : null,
    protectedMode: cr0 ? (BigInt(cr0) & 1n) === 1n : null,
    halted: hlt === "0" ? false : hlt === "1" ? true : null,
  };
}
