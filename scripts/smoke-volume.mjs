// SPDX-License-Identifier: Apache-2.0
// Real v86/Linux/VirtIO/ext2 I/O. fake-indexeddb exercises IndexedDB transactions
// in Node; this is not a browser storage-eviction, power-loss or UI test.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import * as workerThreads from "node:worker_threads";
import "fake-indexeddb/auto";
import { V86 } from "v86";
import "../public/runtime/libv86.js";
import { LinuxRuntime } from "../src/lib/linux-runtime.ts";
import { CommandRunner } from "../src/lib/command-runner.ts";
import { createVolume, getVolume, exportVolume, snapshotVolume, cloneVolume, deleteVolume } from "../src/lib/volume-store.ts";

if (!workerThreads.locks) throw Error("Use Node 24.5 or newer for this real Web Locks integration smoke.");
Object.defineProperty(navigator, "locks", { configurable: true, value: workerThreads.locks });
const provenance = JSON.parse(await readFile(new URL("../public/runtime/provenance.json", import.meta.url), "utf8"));
async function verified(file) {
  const asset = provenance.externalGuestAssets.find((entry) => entry.file === file);
  assert.ok(asset, "Missing pinned provenance for " + file);
  let bytes;
  if (process.env.TERRARIUM_VM_ASSET_DIR) {
    bytes = await readFile(resolve(process.env.TERRARIUM_VM_ASSET_DIR, file === "buildroot-bzimage68.bin" ? file : "bios/" + file));
  } else {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(60_000), credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok || !response.body) throw Error("Could not download " + file);
    bytes = new Uint8Array(asset.bytes);
    let offset = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        if (offset + value.byteLength > bytes.byteLength) throw Error("Unexpected asset length");
        bytes.set(value, offset); offset += value.byteLength;
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    assert.equal(offset, asset.bytes);
  }
  assert.equal(bytes.byteLength, asset.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
  return [asset.url, bytes];
}
const assets = new Map(await Promise.all(["buildroot-bzimage68.bin", "seabios.bin", "vgabios.bin"].map(verified)));
class HostV86 extends V86 {
  constructor(options) { super({ ...options, wasm_path: fileURLToPath(options.wasm_path) }); }
}
const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
globalThis.window = { setTimeout, clearTimeout, V86: HostV86 };
globalThis.document = { baseURI: new URL("../public/", import.meta.url).href };
globalThis.fetch = async (url) => {
  const bytes = assets.get(String(url));
  if (!bytes) throw Error("Unexpected asset URL: " + url);
  return new Response(bytes);
};
const machines = [], records = [];
function machine(volumes) {
  const runtime = new LinuxRuntime({ volumes });
  const runner = new CommandRunner(runtime);
  const pair = { runtime, runner }; machines.push(pair); return pair;
}
async function run(pair, command) {
  const result = await pair.runner.execute(command, { timeoutMs: 30_000 });
  assert.equal(result.status, "exited", JSON.stringify(result));
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  return result.output;
}
async function sync(pair) {
  await pair.runtime.syncVolumes((command) => pair.runner.executeInternal(command, { timeoutMs: 30_000 }));
}
const report = (name, details = {}) => console.log(JSON.stringify({ name, passed: true, ...details }));
try {
  const volume = await createVolume({ name: "VM data", sizeMiB: 8 }); records.push(volume.id);
  const first = machine([{ id: volume.id, slot: 0 }]);
  await first.runtime.boot();
  assert.equal(first.runtime.getSnapshot().volumes[0].status, "mounted");
  assert.equal(first.runtime.capabilities.snapshots, false);
  await assert.rejects(first.runtime.save(), /external durable disks/);
  await assert.rejects(first.runtime.restore(new ArrayBuffer(0)), /Detach external volumes/);
  await assert.rejects(first.runtime.detachVolume(0), /Stop/);
  await assert.rejects(snapshotVolume(volume.id, { name: "unsafe live snapshot" }), /attached|use/);
  await run(first, "set -e; test -b /dev/terrarium-volume0; printf 'persistent café 🐧\\n' > /mnt/volumes/disk0/evidence.txt; dd if=/dev/zero of=/mnt/volumes/disk0/payload.bin bs=4096 count=20 2>/dev/null; test $(wc -c </mnt/volumes/disk0/payload.bin) -eq 81920");
  await sync(first);
  assert.equal(first.runtime.getSnapshot().volumes[0].pendingWrites, 0);
  const stopping = first.runtime.destroy();
  assert.equal(first.runtime.getSnapshot().volumeOperation, "detaching");
  await assert.rejects(first.runtime.boot(), /volume operation/);
  await assert.rejects(first.runtime.detachVolume(0), /volume operation/);
  await Promise.all([stopping, first.runtime.destroy()]);
  assert.equal(first.runtime.getSnapshot().volumeOperation, null);
  assert.ok((await getVolume(volume.id)).revision > 0);
  report("real VirtIO/ext2 writes persist; boot/detach blocked during shared teardown");

  const reopened = machine([{ id: volume.id, slot: 0 }]);
  await reopened.runtime.boot();
  assert.match(await run(reopened, "cat /mnt/volumes/disk0/evidence.txt; wc -c </mnt/volumes/disk0/payload.bin"), /persistent café 🐧[\s\S]*81920/);
  await reopened.runtime.reset();
  assert.match(await run(reopened, "cat /mnt/volumes/disk0/evidence.txt"), /persistent café 🐧/);
  await sync(reopened); await reopened.runtime.destroy();
  await reopened.runtime.detachVolume(0);
  assert.equal(reopened.runtime.capabilities.snapshots, true);
  report("independent VM reopen, reset and detach preserve the data filesystem");

  const snapshot = await snapshotVolume(volume.id, { name: "Preserved original" }); records.push(snapshot.id);
  const before = await exportVolume(snapshot.id);
  assert.equal(before.sha256, snapshot.sha256);
  const clone = await cloneVolume(snapshot.id, { name: "Writable analysis copy" }); records.push(clone.id);
  const analysis = machine([{ id: clone.id, slot: 0 }, { id: snapshot.id, slot: 1, readOnly: true }]);
  await analysis.runtime.boot();
  assert.equal(analysis.runtime.getSnapshot().volumes.length, 2);
  assert.match(await run(analysis, "cat /mnt/volumes/disk1/evidence.txt; cat /sys/block/vdb/ro"), /persistent café 🐧[\s\S]*1/);
  const denied = await analysis.runner.execute("printf changed > /mnt/volumes/disk1/evidence.txt");
  assert.equal(denied.status, "exited"); assert.notEqual(denied.exitCode, 0);
  assert.match(denied.output, /read.only|Read.only/);
  const rawDenied = await analysis.runner.execute("dd if=/dev/zero of=/dev/terrarium-volume1 bs=512 count=1");
  assert.equal(rawDenied.status, "exited"); assert.notEqual(rawDenied.exitCode, 0);
  assert.match(rawDenied.output, /read.only|Read.only|Operation not permitted/);
  await run(analysis, "printf 'clone changed\\n' > /mnt/volumes/disk0/evidence.txt");
  await sync(analysis); await analysis.runtime.destroy();
  assert.equal((await exportVolume(snapshot.id)).sha256, snapshot.sha256);
  const checkClone = machine([{ id: clone.id, slot: 1 }]);
  await checkClone.runtime.boot();
  assert.match(await run(checkClone, "cat /mnt/volumes/disk1/evidence.txt"), /clone changed/);
  await sync(checkClone); await checkClone.runtime.destroy();
  report("snapshot hash unchanged; RO feature denies filesystem and raw block writes; writable clone independent; slot 1 works alone");
  console.log("PASS: real Linux durable volume mount/write/reopen/reset/snapshot/clone/read-only integration. IndexedDB is fake-indexeddb in this Node harness, not browser UI or eviction testing.");
} finally {
  for (const pair of machines) {
    await pair.runtime.destroy().catch(() => {});
    try { pair.runner.dispose(); } catch { /* Preserve the original assertion. */ }
  }
  for (const id of records) await deleteVolume(id).catch(() => {});
  globalThis.window = previous.window; globalThis.document = previous.document; globalThis.fetch = previous.fetch;
}
