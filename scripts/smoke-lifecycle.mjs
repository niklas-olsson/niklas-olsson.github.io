// SPDX-License-Identifier: Apache-2.0
// Actual Linux/VirtIO/ext2 + production workspace deletion and manifest recovery.
// fake-indexeddb/MemoryStorage model storage in Node; this is not a browser reload,
// power-loss, storage-eviction, or UI test. The sync-failure case is injected.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import * as workerThreads from "node:worker_threads";
import "fake-indexeddb/auto";
import { V86 } from "v86";
import "../public/runtime/libv86.js";

if (!workerThreads.locks) throw Error("Use Node 24.5 or newer for this real Web Locks integration smoke.");
Object.defineProperty(navigator, "locks", { configurable: true, value: workerThreads.locks });
const sourceRoot = new URL("../src/", import.meta.url).href;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith(".") && !/\.[a-zA-Z0-9]+$/.test(specifier)) return next(`${specifier}.ts`, context);
  return next(specifier, context);
} });
class MemoryStorage {
  values = new Map();
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(String(key)) ?? null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
  clear() { this.values.clear(); }
}
const storage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
const provenance = JSON.parse(await readFile(new URL("../public/runtime/provenance.json", import.meta.url), "utf8"));
async function verified(file) {
  const asset = provenance.externalGuestAssets.find((entry) => entry.file === file); assert.ok(asset);
  let bytes;
  if (process.env.TERRARIUM_VM_ASSET_DIR) bytes = await readFile(resolve(process.env.TERRARIUM_VM_ASSET_DIR, file === "buildroot-bzimage68.bin" ? file : "bios/" + file));
  else {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(60_000), credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok || !response.body) throw Error("Could not download " + file);
    bytes = new Uint8Array(asset.bytes); let offset = 0; const reader = response.body.getReader();
    try { while (true) { const { done, value } = await reader.read(); if (done) break; if (offset + value.byteLength > bytes.byteLength) throw Error("Unexpected asset length"); bytes.set(value, offset); offset += value.byteLength; } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    assert.equal(offset, asset.bytes);
  }
  assert.equal(bytes.byteLength, asset.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
  return [asset.url, bytes];
}
const assets = new Map(await Promise.all(["buildroot-bzimage68.bin", "seabios.bin", "vgabios.bin"].map(verified)));
let emulatorCount = 0;
class HostV86 extends V86 {
  constructor(options) { super({ ...options, wasm_path: fileURLToPath(options.wasm_path) }); emulatorCount++; }
}
globalThis.window = { setTimeout, clearTimeout, V86: HostV86, localStorage: storage, indexedDB };
globalThis.document = { baseURI: new URL("../public/", import.meta.url).href };
globalThis.fetch = async (url) => { const bytes = assets.get(String(url)); if (!bytes) throw Error("Unexpected URL: " + url); return new Response(bytes); };

const { MachineWorkspace, workspace } = await import("../src/lib/machines.ts");
const { installAgentBridge } = await import("../src/lib/agent-bridge.ts");
const { MACHINE_STORAGE_KEY } = await import("../src/lib/machine-config.ts");
const { WORKSPACE_STORAGE_KEY, loadWorkspaceManifest } = await import("../src/lib/workspace-persistence.ts");
const { createVolume, getVolume, deleteVolume, registerVolumeDeletionGuard } = await import("../src/lib/volume-store.ts");
const report = (name, extra = {}) => console.log(JSON.stringify({ name, passed: true, ...extra }));
const owners = [workspace], disks = [], guards = [];
const install = (owner) => installAgentBridge({ active: owner.active, list: owner.list, get: (id) => owner.list().find((entry) => entry.id === id) });
async function run(agent, command) {
  const result = await agent.exec(command, { timeoutMs: 30_000 });
  assert.equal(result.status, "exited", JSON.stringify(result));
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  return result.output;
}
function manifest() { const loaded = loadWorkspaceManifest(storage); assert.equal(loaded.error, null); return loaded.manifest; }

try {
  const entry = workspace.list()[0]; assert.ok(entry);
  const legacyConfig = structuredClone(entry.config);
  const primary = await createVolume({ name: "Retained after delete", sizeMiB: 8 }); disks.push(primary.id);
  const secondary = await createVolume({ name: "Busy mount rollback", sizeMiB: 4 }); disks.push(secondary.id);
  const attaching = workspace.attachVolume(entry.id, { id: primary.id, slot: 0 });
  await assert.rejects(deleteVolume(primary.id), /pending attachment|Detach/);
  await attaching;
  await workspace.attachVolume(entry.id, { id: secondary.id, slot: 1 });
  install(workspace);
  const retained = window.terrarium.get(entry.id);
  const booting = retained.boot();
  await assert.rejects(workspace.remove(entry.id), /Wait.*boot|still starting/);
  await booting;
  await run(retained, "set -e; printf 'survives deletion café 🐧\\n' > /mnt/volumes/disk0/record.txt; printf 'secondary data\\n' > /mnt/volumes/disk1/record.txt; printf volatile > /root/volatile.txt; uname -a");

  const prepareShutdown = entry.runtime.prepareVolumeShutdown;
  assert.equal(typeof prepareShutdown, "function");
  entry.runtime.prepareVolumeShutdown = async () => { throw new Error("Injected guest sync failure"); };
  try { await assert.rejects(workspace.remove(entry.id), /Injected guest sync failure/); }
  finally { entry.runtime.prepareVolumeShutdown = prepareShutdown; }
  assert.equal(workspace.get(entry.id), entry);
  assert.equal(entry.runtime.getSnapshot().status, "running");
  assert.equal(entry.lifecycle, "ready");
  assert.equal(manifest().machines.some((machine) => machine.id === entry.id), true);
  report("pending attachment and boot block deletion; injected sync failure preserves the running definition and disks");

  // A real process whose cwd is on the second disk makes umount return EBUSY.
  // The first disk has already unmounted, so shutdown must remount it on failure.
  await run(retained, "(cd /mnt/volumes/disk1 && exec sleep 60) </dev/null >/dev/null 2>&1 & echo $! >/tmp/terrarium-busy.pid");
  await assert.rejects(workspace.remove(entry.id), /shutdown was not confirmed|still busy/);
  assert.equal(workspace.get(entry.id), entry);
  assert.equal(entry.runtime.getSnapshot().status, "running");
  assert.equal(entry.runtime.getSnapshot().volumeOperation, null);
  assert.equal(entry.runtime.getSnapshot().operation, null);
  assert.equal(await run(retained, "set -e; grep -q ' /mnt/volumes/disk0 ext2 rw' /proc/mounts; grep -q ' /mnt/volumes/disk1 ext2 rw' /proc/mounts; cat /mnt/volumes/disk0/record.txt; kill $(cat /tmp/terrarium-busy.pid)"), "survives deletion café 🐧\n");
  report("actual busy second ext2 mount refuses deletion and restores the first writable mount");

  const deleting = workspace.remove(entry.id);
  assert.equal(entry.lifecycle, "deleting");
  await assert.rejects(retained.exec("printf forbidden > /mnt/volumes/disk0/race.txt"), /deleting|operation/);
  await assert.rejects(retained.boot(), /deleting|operation/);
  await assert.rejects(workspace.remove(entry.id), /deleting|operation/);
  await deleting;
  assert.equal(workspace.list().length, 0);
  assert.deepEqual(manifest().machines, []);
  assert.deepEqual(manifest().activity, []);
  assert.equal(manifest().activeId, "");
  await assert.rejects(retained.boot(), /deleted/);
  await assert.rejects(retained.exec("echo forbidden"), /deleted/);
  assert.throws(() => retained.readOutput(), /deleted/);
  assert.throws(() => entry.runtime.boot(), /deleted/);
  assert.equal(emulatorCount, 1);
  assert.ok((await getVolume(primary.id)).revision > 0);
  assert.ok((await getVolume(secondary.id)).revision > 0);
  report("machine deletion commits an empty manifest, retains disks, gates concurrent work and revokes old handles");

  // Old-format keys must never resurrect a machine after a committed deletion.
  storage.setItem(MACHINE_STORAGE_KEY, JSON.stringify([legacyConfig]));
  const reopened = new MachineWorkspace(); owners.push(reopened);
  guards.push(registerVolumeDeletionGuard(reopened.guardVolumeDeletion));
  assert.equal(reopened.list().length, 0);
  assert.equal(reopened.getSnapshot().activeId, "");
  assert.equal(emulatorCount, 1);
  const restored = reopened.add("reopened-data", "x86");
  await reopened.attachVolume(restored.id, { id: primary.id, slot: 0 });
  await assert.rejects(deleteVolume(primary.id), /Detach/);
  install(reopened);
  const verifier = window.terrarium.get(restored.id);
  await verifier.boot();
  assert.equal(await run(verifier, "set -e; test ! -e /root/volatile.txt; test ! -e /mnt/volumes/disk0/race.txt; cat /mnt/volumes/disk0/record.txt"), "survives deletion café 🐧\n");
  await reopened.remove(restored.id);
  const emptyAgain = new MachineWorkspace(); owners.push(emptyAgain);
  assert.equal(emptyAgain.list().length, 0);
  assert.deepEqual(JSON.parse(storage.getItem(WORKSPACE_STORAGE_KEY)).machines, []);
  report("fresh manager restores zero machines despite legacy keys; a new real guest reads the preserved disk", { emulatorInstances: emulatorCount });
  console.log("PASS: real guest safe deletion, busy-unmount rollback, retained-handle revocation and manifest reopen. Browser reload/eviction are not simulated by this Node harness.");
} finally {
  for (const owner of owners) {
    for (const machine of owner.list()) {
      await machine.runtime.destroy().catch(() => {});
      for (const unsubscribe of machine.unsubscribe) unsubscribe();
      machine.runner.dispose(); machine.port.dispose();
    }
  }
  for (const detach of guards) detach();
  for (const id of disks) await deleteVolume(id).catch(() => {});
  hooks.deregister();
}
