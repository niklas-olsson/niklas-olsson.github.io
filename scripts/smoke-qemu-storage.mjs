// SPDX-License-Identifier: Apache-2.0
// Real QEMU x86_64 Linux, production worker dispatch, synchronous SAB disk RPC,
// and VolumeSession commits. fake-indexeddb is not browser durability/eviction QA.
// Run: TERRARIUM_QEMU_ASSET_DIR=/verified/packs node --experimental-strip-types scripts/smoke-qemu-storage.mjs
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as workerThreads from "node:worker_threads";
import vm from "node:vm";
import "fake-indexeddb/auto";
import { createNodeQemuWorkers } from "./qemu-node-adapter.mjs";
import { QemuRuntime } from "../src/lib/qemu-runtime.ts";
import { loadQemuTestAssets, installQemuTestPthread } from "./qemu-test-assets.mjs";
import { CommandRunner } from "../src/lib/command-runner.ts";
import { parseCommandFrame } from "../src/lib/command-protocol.ts";
import { isSessionPrompt } from "../src/lib/guest-startup.ts";
import { createVolume, getVolume, exportVolume, snapshotVolume, cloneVolume, deleteVolume } from "../src/lib/volume-store.ts";
import { decodeEvidenceBytes, exportEvidenceArchive } from "../src/lib/evidence.ts";
import { VirtualNetwork } from "../src/lib/network.ts";

if (!workerThreads.locks) throw new Error("Use Node 24.5 or newer for the real Web Locks integration.");
Object.defineProperty(navigator, "locks", { configurable: true, value: workerThreads.locks });
const previous = { fetch: globalThis.fetch, Worker: globalThis.Worker, document: globalThis.document, crossOriginIsolated: globalThis.crossOriginIsolated, isSecureContext: globalThis.isSecureContext };
const { bundle, manifest, pthread, assets } = await loadQemuTestAssets({ fetchAsset: previous.fetch });
const temporary = await mkdtemp(join(tmpdir(), "terrarium-qemu-storage-"));
await installQemuTestPthread(temporary, bundle, pthread);
const { Worker, workers, joinTeardown } = createNodeQemuWorkers({ temporary, manifest, bundleId: bundle.id });
const adapterContext = vm.createContext({ console, performance, setTimeout, clearTimeout, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Headers, Response, Request, crypto, URL });
vm.runInContext(await readFile(new URL("../public/runtime/libv86.js", import.meta.url), "utf8"), adapterContext);
assert.ok(adapterContext.TerrariumNetworkAdapters, "Run npm run runtime:prepare before the smoke.");
const network = new VirtualNetwork({ factories: adapterContext.TerrariumNetworkAdapters });
Object.assign(globalThis, { Worker, document: { baseURI: "https://terrarium.invalid/" }, crossOriginIsolated: true, isSecureContext: true });
globalThis.fetch = async (url) => {
  const bytes = assets.get(String(url));
  if (!bytes) throw new Error(`Unexpected host request: ${url}`);
  return new Response(Uint8Array.from(bytes), { status: 200 });
};

const machines = [], records = [];
let current = null, failed = false;
let failureStacks = null;
function machine(volumes, initScript = "", networkPort) {
  const runtime = new QemuRuntime({ defaultBootBundleId: bundle.id, volumes, initScript, networkPort });
  const runner = new CommandRunner(runtime);
  const output = ["", "", "", ""];
  const listeners = new Set();
  const unsubscribe = [0, 1, 2, 3].map((port) => runtime.onOutput((text) => {
    output[port] = (output[port] + text).slice(-256 * 1024);
    if (process.env.TERRARIUM_QEMU_VERBOSE === "1") process.stdout.write(`[ttyS${port}] ${text}`);
    for (const check of listeners) check();
  }, port));
  const machineNumber = machines.length + 1;
  if (failureStacks) unsubscribe.push(failureStacks.instrumentStartup(runtime, `storage machine ${machineNumber}`));
  let stage = "";
  unsubscribe.push(runtime.subscribe((state) => {
    const next = `${state.status}: ${state.message}`;
    if (next !== stage) {
      stage = next;
      console.log(`Machine ${machineNumber}: ${next}`);
    }
  }));
  const pair = { runtime, runner, output, listeners, unsubscribe, networkPort }; machines.push(pair); current = pair; return pair;
}
function wait(pair, predicate, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pair.listeners.delete(check); reject(new Error("Timed out waiting for an interactive shell.")); }, timeoutMs);
    const check = () => { const value = predicate(); if (value) { clearTimeout(timer); pair.listeners.delete(check); resolve(value); } };
    pair.listeners.add(check); check();
  });
}
async function interactive(pair, port, command) {
  const token = randomUUID().replaceAll("-", "");
  const offset = pair.output[port].length;
  const completed = wait(pair, () => parseCommandFrame(pair.output[port].slice(offset), token));
  pair.runtime.send(`printf '\\n__TRM_BEGIN_${token}__\\n'; ${command}; _trm_rc=$?; printf '\\n__TRM_END_${token}__:%s\\n' "$_trm_rc"\n`, port);
  const result = await completed;
  assert.equal(result.exitCode, 0, result.output);
  await wait(pair, () => isSessionPrompt(pair.output[port].slice(-2048), port));
  return result.output;
}
async function run(pair, command) {
  const result = await pair.runner.execute(command, { timeoutMs: 60_000 });
  assert.equal(result.status, "exited", JSON.stringify(result));
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  return result.output;
}
const internal = (pair) => (command) => pair.runner.executeInternal(command, { timeoutMs: 60_000 });
async function boot(pair, label) {
  const started = performance.now(); current = pair;
  await pair.runtime.boot();
  assert.equal(pair.runtime.getSnapshot().status, "running");
  assert.equal(pair.runtime.getSnapshot().controlReady, true);
  assert.equal(pair.runtime.getSnapshot().runtimeBundle.activeBundleId, bundle.id);
  assert.equal(pair.runtime.getSnapshot().guestCapabilities?.kernelRelease, bundle.guest.kernel);
  console.log(JSON.stringify({ name: label, passed: true, bootMs: Math.round(performance.now() - started) }));
}
async function shutdown(pair) {
  await pair.runtime.prepareVolumeShutdown(internal(pair));
  await pair.runtime.destroy(); await joinTeardown();
  assert.equal(pair.runtime.getSnapshot().status, "idle");
  assert.equal(workers.size, 0);
}
const smokeDeadlineAt = performance.now() + 15 * 60_000;
const deadline = setTimeout(() => {
  console.error("Storage smoke timed out. Recent output:\n" + (current?.output[0].slice(-12000) ?? ""));
  process.exit(1);
}, 15 * 60_000);
try {
  if (process.env.TERRARIUM_QEMU_FAILURE_STACKS === "1") {
    const { createFailureStackCapture } = await import("./qemu-failure-stacks.mjs");
    failureStacks = createFailureStackCapture({ workers, bundleId: bundle.id, deadlineAt: smokeDeadlineAt });
  }
  const volume = await createVolume({ name: "x86_64 data", sizeMiB: 8 }); records.push(volume.id);
  const initScript = 'set -e\ncount=0\nif [ -f /mnt/volumes/disk1/boots ]; then read -r count < /mnt/volumes/disk1/boots; fi\nprintf "%s\\n" "$((count + 1))" > /mnt/volumes/disk1/boots\nprintf "DISK_INIT_OK\\n"';
  const source = machine([{ id: volume.id, slot: 1 }], initScript);
  await boot(source, "slot 1 boots independently and mounts before init");
  assert.equal(source.runtime.getSnapshot().init.status, "succeeded", source.runtime.getSnapshot().init.output);
  assert.equal(source.runtime.getSnapshot().init.output, "DISK_INIT_OK\n");
  const prerequisites = await run(source, [
    "mkdir -p /sys/fs/cgroup",
    "mountpoint -q /sys/fs/cgroup || mount -t cgroup2 none /sys/fs/cgroup",
    "_trm_rc=$?; printf 'cgroup2 mount exit=%s\\n' \"$_trm_rc\"",
    "if [ -f /sys/fs/cgroup/cgroup.controllers ]; then printf 'controllers='; cat /sys/fs/cgroup/cgroup.controllers; fi",
    "for _trm_module in overlay br_netfilter veth; do modprobe \"$_trm_module\" 2>&1; _trm_rc=$?; printf '%s module exit=%s\\n' \"$_trm_module\" \"$_trm_rc\"; done",
    "true",
  ].join("\n"));
  console.log("Observed kernel prerequisite probes (not container/Kubernetes execution):\n" + prerequisites);
  assert.equal(source.runtime.getSnapshot().volumes[0].status, "mounted");
  assert.equal(source.runtime.capabilities.snapshots, false);
  await assert.rejects(source.runtime.save(), {
    name: "Error",
    message: "RAM checkpoints require a qualified small preset with a built-in image and no external data disks or evidence. Larger/custom machines use persistent mounts.",
  });
  await assert.rejects(source.runtime.restore(new ArrayBuffer(0)), {
    name: "Error",
    message: "Restore a VM checkpoint into a machine without external data disks or evidence attachments.",
  });
  await assert.rejects(source.runtime.detachVolume(1), /Stop/);
  await assert.rejects(snapshotVolume(volume.id, { name: "unsafe live copy" }), /attached|use/);
  await run(source, "set -e; test -b /dev/terrarium-volume1; printf 'persistent café 雪 🐧\\n' > /mnt/volumes/disk1/evidence.txt; dd if=/dev/zero of=/mnt/volumes/disk1/payload.bin bs=4096 count=20 2>/dev/null; printf 'tail' | dd of=/mnt/volumes/disk1/payload.bin bs=1 seek=81916 conv=notrunc 2>/dev/null; test $(wc -c </mnt/volumes/disk1/payload.bin) -eq 81920");
  const payloadHash = (await run(source, "sha256sum /mnt/volumes/disk1/payload.bin")).split(" ")[0];
  await source.runtime.syncVolumes(internal(source));
  assert.equal(source.runtime.getSnapshot().volumes[0].pendingWrites, 0);

  await interactive(source, 1, "cd /mnt/volumes/disk1");
  await assert.rejects(source.runtime.prepareVolumeShutdown(internal(source)), /busy|shutdown was refused|shutdown was not confirmed/i);
  assert.equal(source.runtime.getSnapshot().status, "running");
  assert.equal(source.runtime.getSnapshot().controlReady, true);
  assert.match(await run(source, "cat /mnt/volumes/disk1/evidence.txt"), /persistent café 雪 🐧/);
  await interactive(source, 1, "cd /root");
  console.log("PASS: true worker disk RPC commits; a busy filesystem refuses shutdown and remains usable.");

  await source.runtime.pause();
  await assert.rejects(source.runtime.reset(), /Resume|resume|sync/);
  await source.runtime.resume();
  const resetStarted = performance.now();
  await source.runtime.reset();
  console.log(`Reset and fresh boot completed in ${Math.round(performance.now() - resetStarted)} ms.`);
  assert.match(await run(source, "cat /mnt/volumes/disk1/evidence.txt; cat /mnt/volumes/disk1/boots"), /persistent café 雪 🐧\n2\n/);
  assert.equal((await run(source, "sha256sum /mnt/volumes/disk1/payload.bin")).split(" ")[0], payloadHash);
  await shutdown(source);
  assert.ok((await getVolume(volume.id)).revision > 0);
  console.log("PASS: filesystem bytes and exact binary digest survive runtime reset and complete worker teardown.");

  const preserved = await snapshotVolume(volume.id, { name: "Preserved x86_64 disk" }); records.push(preserved.id);
  const preservedHash = (await exportVolume(preserved.id)).sha256;
  const clone = await cloneVolume(preserved.id, { name: "Writable x86_64 analysis disk" }); records.push(clone.id);
  const quarantinePort = network.createPort("disk-quarantine", "192.168.76.10", { quarantined: true });
  const analysis = machine([{ id: clone.id, slot: 0 }, { id: preserved.id, slot: 1, readOnly: true }], "", quarantinePort);
  await boot(analysis, "independent new machine opens clone and immutable snapshot");
  assert.match(await run(analysis, "cat /mnt/volumes/disk0/evidence.txt; cat /mnt/volumes/disk1/evidence.txt"), /persistent café 雪 🐧\npersistent café 雪 🐧/);
  assert.equal((await run(analysis, "sha256sum /mnt/volumes/disk0/payload.bin")).split(" ")[0], payloadHash);
  // A guest root may try clearing its own RO flag. The host image must remain protected.
  const remount = await analysis.runner.execute("blockdev --setrw /dev/terrarium-volume1 2>/dev/null; mount -o remount,rw /mnt/volumes/disk1", { timeoutMs: 30_000 });
  assert.equal(remount.status, "exited", JSON.stringify(remount));
  console.log(`Guest read-only snapshot remount attempt exit=${remount.exitCode}.`);
  for (const command of ["printf changed > /mnt/volumes/disk1/evidence.txt", "dd if=/dev/zero of=/dev/terrarium-volume1 bs=512 count=1"]) {
    const denied = await analysis.runner.execute(command, { timeoutMs: 30_000 });
    assert.equal(denied.status, "exited", JSON.stringify(denied)); assert.notEqual(denied.exitCode, 0, JSON.stringify(denied));
  }
  assert.equal(quarantinePort.getSnapshot().quarantined, true);
  assert.throws(() => quarantinePort.setMode("world"), /quarantined/);
  const evidence = await analysis.runtime.captureEvidence([
    "/mnt/volumes/disk0/evidence.txt", "/mnt/volumes/disk0/payload.bin",
  ], internal(analysis), { title: "Captured x86_64 disk files", machineId: "disk-quarantine", machineName: "disk-quarantine" });
  const capturedText = evidence.files.find((file) => file.path.endsWith("/evidence.txt"));
  const capturedBinary = evidence.files.find((file) => file.path.endsWith("/payload.bin"));
  assert.equal(new TextDecoder().decode(decodeEvidenceBytes(capturedText)), "persistent café 雪 🐧\n");
  assert.equal(createHash("sha256").update(decodeEvidenceBytes(capturedBinary)).digest("hex"), payloadHash);
  assert.equal(capturedBinary.size, 81920);
  assert.equal(evidence.source.guestExecuted, true);
  const evidenceBefore = exportEvidenceArchive(evidence);
  console.log("PASS: real guest-assisted Unicode and 80 KiB binary capture from a permanently quarantined source.");
  await run(analysis, "printf 'clone changed\\n' > /mnt/volumes/disk0/evidence.txt");
  await shutdown(analysis);
  assert.equal((await exportVolume(preserved.id)).sha256, preservedHash);
  console.log("PASS: two slots, immutable snapshot filesystem/raw/remount denial, preserved original SHA-256, independent clone writes.");

  const analyst = machine([{ id: clone.id, slot: 1 }]);
  await analyst.runtime.attachEvidence(evidence);
  await boot(analyst, "slot 1 clone and separate read-only evidence mount");
  assert.equal((await run(analyst, "cat /mnt/volumes/disk1/evidence.txt")).trim(), "clone changed");
  assert.equal((await run(analyst, "sha256sum /mnt/evidence/files/mnt/volumes/disk0/payload.bin")).split(" ")[0], payloadHash);
  assert.equal(await run(analyst, "cat /mnt/evidence/files/mnt/volumes/disk0/evidence.txt"), "persistent café 雪 🐧\n");
  const evidenceRemount = await analyst.runner.execute("blockdev --setrw /dev/terrarium-evidence 2>/dev/null; mount -o remount,rw /mnt/evidence", { timeoutMs: 30_000 });
  assert.equal(evidenceRemount.status, "exited", JSON.stringify(evidenceRemount));
  console.log(`Guest evidence remount attempt exit=${evidenceRemount.exitCode}.`);
  for (const command of ["printf changed > /mnt/evidence/files/mnt/volumes/disk0/evidence.txt", "dd if=/dev/zero of=/dev/terrarium-evidence bs=512 count=1"]) {
    const denied = await analyst.runner.execute(command, { timeoutMs: 30_000 });
    assert.equal(denied.status, "exited", JSON.stringify(denied)); assert.notEqual(denied.exitCode, 0, JSON.stringify(denied));
  }
  await shutdown(analyst);
  assert.equal((await exportVolume(preserved.id)).sha256, preservedHash);
  assert.deepEqual(exportEvidenceArchive(evidence), evidenceBefore);
  console.log("PASS: a fresh slot-1-only machine reads the committed clone; evidence bytes and provenance remain unchanged under filesystem/raw write attempts.");
  console.log("PASS: real x86_64 storage lifecycle, reset, clean/busy shutdown, snapshot/clone, read-only data and evidence mounts. Browser eviction/crash durability remains a separate check.");
} catch (error) {
  failed = true;
  if (failureStacks) await failureStacks.captureFailure({ runtime: current?.runtime, error, reason: "original-storage-smoke-failure" });
  console.error("Recent guest output:\n" + (current?.output[0].slice(-20000) ?? ""));
  console.error(error);
} finally {
  clearTimeout(deadline);
  for (const pair of machines) {
    await pair.runtime.destroy().catch(() => undefined);
    pair.runner.dispose(); pair.unsubscribe.forEach((unsubscribe) => unsubscribe()); pair.networkPort?.dispose();
  }
  for (const worker of [...workers]) worker.terminate();
  await joinTeardown();
  for (const id of records) await deleteVolume(id).catch(() => undefined);
  Object.assign(globalThis, previous);
  await rm(temporary, { recursive: true, force: true });
}
failureStacks?.reportComplete();
process.exit(failed ? 1 : 0);
