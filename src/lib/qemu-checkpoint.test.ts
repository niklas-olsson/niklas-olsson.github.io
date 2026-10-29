// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import "fake-indexeddb/auto";
import {
  createQemuCheckpoint, parseQemuCheckpoint, validateQemuStateDisk, inspectQemuRegisters,
  QEMU_RUNTIME_VERSION, MAX_QEMU_CHECKPOINT_PAYLOAD_BYTES,
} from "./qemu-checkpoint.ts";
import { inspectCheckpoint, assertCheckpointProfile, checkpointRuntimeVersion, isCheckpointRuntimeCompatible } from "./checkpoint-format.ts";
import { DEFAULT_QEMU_BUNDLE_ID, LEGACY_QEMU_BUNDLE_ID, OWNED_QEMU_BUNDLE_ID, getQemuBundle } from "./qemu-assets.ts";
import { RUNTIME_VERSION } from "./runtime-types.ts";
import { defaultX86MachineConfiguration } from "./x86-machine-config.ts";
import { storeSnapshot, listSnapshots, readSnapshot, deleteSnapshot } from "./snapshots.ts";

// Structural fixture only. No emulator loads this synthetic qcow2 image.
function stateDisk(): ArrayBuffer {
  const cluster = 65536;
  const bytes = new Uint8Array(5 * cluster), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x514649fb); view.setUint32(4, 3); view.setUint32(20, 16);
  view.setBigUint64(24, 8n * 1024n * 1024n); view.setUint32(36, 1);
  view.setBigUint64(40, BigInt(3 * cluster)); view.setBigUint64(48, BigInt(cluster)); view.setUint32(56, 1);
  view.setUint32(60, 1); view.setBigUint64(64, BigInt(4 * cluster)); view.setUint32(96, 4); view.setUint32(100, 104);
  view.setBigUint64(cluster, BigInt(2 * cluster));
  const snapshot = 4 * cluster;
  view.setBigUint64(snapshot, BigInt(3 * cluster)); view.setUint32(snapshot + 8, 1);
  view.setUint16(snapshot + 12, 1); view.setUint16(snapshot + 14, 9); view.setUint32(snapshot + 16, 1); view.setUint32(snapshot + 36, 16);
  bytes.set(new TextEncoder().encode("1terrarium"), snapshot + 56);
  return bytes.buffer;
}
function rewriteManifest(input: ArrayBuffer, mutate: (manifest: Record<string, unknown>) => void): ArrayBuffer {
  const view = new DataView(input), length = view.getUint32(12, true);
  const manifest = JSON.parse(new TextDecoder().decode(new Uint8Array(input, 24, length)));
  mutate(manifest);
  const metadata = new TextEncoder().encode(JSON.stringify(manifest));
  const payload = new Uint8Array(input, 24 + length);
  const output = new Uint8Array(24 + metadata.length + payload.length);
  output.set(new Uint8Array(input, 0, 24));
  new DataView(output.buffer).setUint32(12, metadata.length, true);
  output.set(metadata, 24); output.set(payload, 24 + metadata.length);
  return output.buffer;
}
const options = { runtimeBundleId: LEGACY_QEMU_BUNDLE_ID, mac: "02:54:00:11:22:33", createdAt: 1234 };

test("v2 checkpoint metadata binds actual small configuration and refuses larger/custom reinterpretation", async () => {
  const machine = defaultX86MachineConfiguration({ runtimeBundleId: OWNED_QEMU_BUNDLE_ID, mac: options.mac, hostname: "saved-small" });
  const bytes = await createQemuCheckpoint(stateDisk(), { ...options, runtimeBundleId: OWNED_QEMU_BUNDLE_ID, machine });
  const parsed = await parseQemuCheckpoint(bytes);
  assert.equal(parsed.manifest.version, 2);
  assert.deepEqual(parsed.manifest.machine, machine);
  for (const mutate of [
    (value: Record<string, unknown>) => { value.version = "2"; },
    (value: Record<string, unknown>) => { value.machine = { ...machine, presetId: "worker" }; },
    (value: Record<string, unknown>) => { value.machine = { ...machine, image: { kind: "custom", id: "a".repeat(64) } }; },
    (value: Record<string, unknown>) => { value.machine = { ...machine, nic: { mac: "02:00:00:00:00:01" } }; },
  ]) await assert.rejects(parseQemuCheckpoint(rewriteManifest(bytes, mutate)));
  assert.equal((await parseQemuCheckpoint(await createQemuCheckpoint(stateDisk(), options))).manifest.version, 1, "Historical v1 creation/restore path remains byte-format compatible.");
});

test("QEMU checkpoints preserve a copied disk, pinned runtime identity, hardware and MAC", async () => {
  const input = stateDisk();
  const creating = createQemuCheckpoint(input, options);
  new Uint8Array(input).fill(0);
  const buffer = await creating;
  const parsed = await parseQemuCheckpoint(buffer);
  assert.deepEqual(parsed.payload, stateDisk());
  assert.equal(parsed.manifest.runtimeVersion, QEMU_RUNTIME_VERSION);
  assert.equal(parsed.manifest.profileId, "alpine-x86_64");
  assert.equal(parsed.manifest.mac, options.mac);
  assert.equal(parsed.manifest.memoryMiB, 512);
  assert.equal(parsed.manifest.serialPorts, 4);
  assert.equal(parsed.manifest.createdAt, 1234);
  assert.equal(checkpointRuntimeVersion("alpine-x86_64"), DEFAULT_QEMU_BUNDLE_ID);
  assert.equal(checkpointRuntimeVersion("riscv64"), null);
  await assertCheckpointProfile(buffer, "alpine-x86_64");
  await assert.rejects(assertCheckpointProfile(buffer, "x86"), /belongs to Alpine/);
});

test("QEMU checkpoint hashes reject payload changes before an emulator can be constructed", async () => {
  const buffer = await createQemuCheckpoint(stateDisk(), options);
  new Uint8Array(buffer)[buffer.byteLength - 1] ^= 1;
  await assert.rejects(parseQemuCheckpoint(buffer), /SHA-256/);
  await assert.rejects(inspectCheckpoint(buffer), /SHA-256/);
});

test("checkpoint eligibility distinguishes catalog compatibility from the fresh boot default", async () => {
  assert.equal(isCheckpointRuntimeCompatible("alpine-x86_64", LEGACY_QEMU_BUNDLE_ID), true);
  assert.equal(isCheckpointRuntimeCompatible("alpine-x86_64", DEFAULT_QEMU_BUNDLE_ID), true);
  assert.equal(isCheckpointRuntimeCompatible("alpine-x86_64", OWNED_QEMU_BUNDLE_ID), true);
  assert.equal(isCheckpointRuntimeCompatible("alpine-x86_64", "qemu@8.2.0-terrarium-0ef7b4e-s1-candidate-v1"), false);
  assert.equal(isCheckpointRuntimeCompatible("x86", RUNTIME_VERSION), true);
  for (const profile of ["x86", "alpine-x86_64", "riscv64"] as const)
    for (const value of [undefined, "", "__proto__", "foreign-runtime", {}])
      assert.equal(isCheckpointRuntimeCompatible(profile, value), false);
  assert.equal(isCheckpointRuntimeCompatible("x86", LEGACY_QEMU_BUNDLE_ID), false);
  assert.equal(isCheckpointRuntimeCompatible("alpine-x86_64", RUNTIME_VERSION), false);
  assert.equal(isCheckpointRuntimeCompatible("riscv64", LEGACY_QEMU_BUNDLE_ID), false);
  const missing = { mac: options.mac } as Parameters<typeof createQemuCheckpoint>[1];
  await assert.rejects(createQemuCheckpoint(stateDisk(), missing), /compatibility identity/);
});

test("checkpoint manifests bind each catalog identity to its complete runtime and guest pins", async () => {
  const legacy = await parseQemuCheckpoint(await createQemuCheckpoint(stateDisk(), options));
  const owned = await createQemuCheckpoint(stateDisk(), { ...options, runtimeBundleId: OWNED_QEMU_BUNDLE_ID });
  const observed = await parseQemuCheckpoint(owned);
  assert.equal(observed.manifest.runtimeVersion, OWNED_QEMU_BUNDLE_ID);
  assert.equal(observed.manifest.emulatorSha256, getQemuBundle(OWNED_QEMU_BUNDLE_ID).assets.wasm.sha256);
  assert.notDeepEqual(observed.manifest.guestSha256, legacy.manifest.guestSha256);
  await assert.rejects(parseQemuCheckpoint(rewriteManifest(owned, (value) => { value.runtimeVersion = LEGACY_QEMU_BUNDLE_ID; })), /differs/);
  await assert.rejects(parseQemuCheckpoint(rewriteManifest(owned, (value) => { value.emulatorSha256 = legacy.manifest.emulatorSha256; })), /differs/);
  await assert.rejects(parseQemuCheckpoint(rewriteManifest(owned, (value) => { value.guestSha256 = legacy.manifest.guestSha256; })), /differ/);
});

test("QEMU checkpoint manifests reject foreign runtimes, assets, hardware and unknown fields", async () => {
  const original = await createQemuCheckpoint(stateDisk(), options);
  for (const mutate of [
    (value: Record<string, unknown>) => { value.runtimeVersion = "foreign"; },
    (value: Record<string, unknown>) => { value.memoryMiB = 1024; },
    (value: Record<string, unknown>) => { value.serialPorts = 1; },
    (value: Record<string, unknown>) => { value.mac = "ff:ff:ff:ff:ff:ff"; },
    (value: Record<string, unknown>) => { value.guestSha256 = {}; },
    (value: Record<string, unknown>) => { value.emulatorSha256 = "0".repeat(64); },
    (value: Record<string, unknown>) => { value.guestSha256 = { ...(value.guestSha256 as object), kernel: "0".repeat(64) }; },
    (value: Record<string, unknown>) => { value.externalPath = "/host/file"; },
    (value: Record<string, unknown>) => { value.registers = "\u001b[31mforged"; },
  ]) await assert.rejects(parseQemuCheckpoint(rewriteManifest(original, mutate)), /differ|missing|unknown|malformed/);
  const excessive = original.slice(0);
  new DataView(excessive).setUint32(16, MAX_QEMU_CHECKPOINT_PAYLOAD_BYTES + 1, true);
  await assert.rejects(parseQemuCheckpoint(excessive), /lengths/);
  const truncated = original.slice(0, original.byteLength - 1);
  await assert.rejects(parseQemuCheckpoint(truncated), /lengths/);
});

test("QEMU state disk preflight rejects backing files, encryption, features, malformed tables and extra snapshots", () => {
  assert.doesNotThrow(() => validateQemuStateDisk(stateDisk()));
  for (const mutate of [
    (view: DataView) => view.setBigUint64(8, 1024n),
    (view: DataView) => view.setUint32(32, 1),
    (view: DataView) => view.setBigUint64(72, 1n),
    (view: DataView) => view.setUint32(104, 0x44415441),
    (view: DataView) => view.setUint32(36, 1025),
    (view: DataView) => view.setBigUint64(40, 9007199254740991n),
    (view: DataView) => view.setUint32(56, 5),
    (view: DataView) => view.setUint32(60, 2),
    (view: DataView) => view.setBigUint64(65536, 9007199254740991n),
    (view: DataView) => view.setUint32(4 * 65536 + 36, 5000),
  ]) {
    const buffer = stateDisk(); mutate(new DataView(buffer));
    assert.throws(() => validateQemuStateDisk(buffer), /state disk/);
  }
});

test("passive QEMU inspection preserves full 64-bit register values and labels monitor observations", async () => {
  const names = ["RAX", "RBX", "RCX", "RDX", "RSI", "RDI", "RBP", "RSP", "R8", "R9", "R10", "R11", "R12", "R13", "R14", "R15"];
  const registers = names.map((name, index) => `${name}${name.length === 2 ? " " : ""}=${index === 0 ? "ffffffffffffffff" : index.toString(16).padStart(16, "0")}`).join(" ") + "\nRIP=ffffffff81012345 CR0=0000000080050033 CPL=0 HLT=1";
  const buffer = await createQemuCheckpoint(stateDisk(), { ...options, registers });
  const inspection = await inspectCheckpoint(buffer);
  assert.equal(inspection.kind, "qemu-checkpoint");
  assert.equal(inspection.cpuSource, "captured-monitor");
  assert.equal(inspection.cpu.instructionPointer, "0xffffffff81012345");
  assert.equal(inspection.cpu.generalRegisters?.rax, "0xffffffffffffffff");
  assert.equal(inspection.cpu.protectedMode, true);
  assert.equal(inspection.cpu.halted, true);
  assert.equal(inspection.cpu.privilegeLevel, 0);
  assert.equal(inspection.videoMemoryMiB, null);
  assert.equal(inspection.bufferCount, null);
  assert.equal(inspectQemuRegisters(registers + " RAX=1").generalRegisters, null);
  assert.equal((await inspectCheckpoint(await createQemuCheckpoint(stateDisk(), options))).cpuSource, "unavailable");
});

test("QEMU checkpoints retain typed metadata and exact bytes in the shared snapshot store", async () => {
  const buffer = await createQemuCheckpoint(stateDisk(), options);
  const meta = await storeSnapshot("x86_64 preserved state", buffer);
  try {
    assert.equal(meta.kind, "qemu-checkpoint");
    assert.equal(meta.profileId, "alpine-x86_64");
    assert.equal(meta.runtime, QEMU_RUNTIME_VERSION);
    const saved = (await listSnapshots()).find((value) => value.id === meta.id);
    assert.equal(saved?.profileId, "alpine-x86_64");
    assert.deepEqual(await readSnapshot(meta.id), buffer);
  } finally { await deleteSnapshot(meta.id, { ifSha256: meta.sha256 }); }
});
