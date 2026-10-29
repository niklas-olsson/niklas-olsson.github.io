// SPDX-License-Identifier: Apache-2.0
// Actual workspace/control-plane/agent API, one real Linux VM, durable block I/O,
// and real IndexedDB transactions through fake-indexeddb. This is not browser UI,
// storage-eviction, or crash-consistency validation.
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

const { workspace, MachineWorkspace } = await import("../src/lib/machines.ts");
const { installAgentBridge } = await import("../src/lib/agent-bridge.ts");
const { createCloudControlPlane } = await import("../src/lib/cloud.ts");
const { createWorkspaceCloudProvider } = await import("../src/lib/cloud-workspace.ts");
const { CloudObjectStore } = await import("../src/lib/cloud-object-store.ts");
const volumeStorage = await import("../src/lib/volume-store.ts");
const cloud = createCloudControlPlane(createWorkspaceCloudProvider(workspace, volumeStorage));
installAgentBridge({ active: workspace.active, list: workspace.list, get: (id) => workspace.list().find((entry) => entry.id === id) }, { cloud });
assert.strictEqual(window.terrarium.cloud, cloud);
const report = (name, extra = {}) => console.log(JSON.stringify({ name, passed: true, ...extra }));
const volumes = [];
try {
  const baseline = (await cloud.instances.list())[0];
  assert.equal(cloud.apiVersion, "terrarium.local/v1alpha1");
  assert((await cloud.images.list()).some((image) => image.id === "x86"));
  const vpc = await cloud.vpcs.create({ name: "Cloud lab", cidr: "10.55.0.0/16", subnets: [{ name: "Workers", cidr: "10.55.1.0/24" }] }, { idempotencyKey: "cloud-vpc" }).wait();
  const subnet = vpc.subnets[0];
  const extraSubnet = await cloud.subnets.create(vpc.id, { name: "Unused", cidr: "10.55.2.0/24" }).wait();
  assert.equal((await cloud.subnets.update(vpc.id, extraSubnet.id, { name: "Moved", cidr: "10.55.3.0/24" }).wait()).cidr, "10.55.3.0/24");
  await cloud.subnets.delete(vpc.id, extraSubnet.id).wait();
  await cloud.vpcs.update(vpc.id, { name: "Provider-backed VPC" }).wait();
  assert.equal((await cloud.vpcs.get(vpc.id)).name, "Provider-backed VPC");
  const request = { name: "cloud-worker", imageId: "x86", vpcId: vpc.id, subnetId: subnet.id, ip: "10.55.1.10" };
  const creation = cloud.instances.create(request, { idempotencyKey: "cloud-worker" });
  assert.strictEqual(cloud.instances.create(request, { idempotencyKey: "cloud-worker" }), creation);
  const instance = await creation.wait();
  assert.equal(instance.status, "idle"); assert.equal(emulatorCount, 0);
  assert.equal((await cloud.instances.list()).length, 2);
  await assert.rejects(cloud.subnets.update(vpc.id, subnet.id, { cidr: "10.55.4.0/24" }).wait(), /occupied/);
  await assert.rejects(cloud.vpcs.delete(vpc.id).wait(), /attached/);
  report("actual workspace definitions, scoped VPC/subnet mutations and stable idempotent resource handles", { instanceId: instance.id, urn: instance.urn, operations: cloud.operations.list().length });

  const disk = await cloud.volumes.create({ name: "Cloud data", sizeMiB: 8 }).wait(); volumes.push(disk.id);
  const configured = await cloud.instances.attachVolume(instance.id, { volumeId: disk.id }).wait();
  assert.equal(configured.volumeAttachments[0].volumeId, disk.id);
  await assert.rejects(cloud.volumes.delete(disk.id).wait(), /Detach/);
  cloud.simulation.identities.set({ id: "observer", allow: [], deny: ["instances.*"] });
  await assert.rejects(cloud.instances.start(instance.id, { identity: "observer" }).wait(), (error) => error.code === "access_denied");
  cloud.simulation.faults.next({ action: "instances.start", fail: true });
  await assert.rejects(cloud.instances.start(instance.id).wait(), (error) => error.code === "injected_failure");
  assert.equal(emulatorCount, 0);
  const booted = await cloud.instances.start(instance.id).wait(); assert.equal(booted.status, "running");
  const agent = window.terrarium.get(instance.id);
  const output = await agent.exec("set -e; uname -a; printf 'cloud durable café 🐧\\n' > /mnt/volumes/disk0/record.txt; printf 'ram-only\\n' > /root/volatile.txt", { timeoutMs: 30_000 });
  assert.equal(output.status, "exited"); assert.equal(output.exitCode, 0); assert.match(output.output, /Linux .*i686/);
  await cloud.instances.syncVolumes(instance.id).wait();
  const metadata = await cloud.metadata.describe(instance.id); assert.equal(metadata.instance.status, "running"); assert.equal(metadata.instance.ip, "10.55.1.10");
  assert.equal(metadata.instance.volumeAttachments[0].volumeId, disk.id);
  await cloud.objectStore.buckets.create({ name: "cloud-proof" });
  const artifact = await cloud.objectStore.objects.put("cloud-proof", "uname.txt", output.output, { metadata: { instanceId: instance.id } });
  await cloud.objectStore.close();
  const reopenedObjects = new CloudObjectStore();
  const stored = await reopenedObjects.objects.get("cloud-proof", "uname.txt");
  assert.equal(new TextDecoder().decode(stored.body), output.output); assert.equal(stored.sha256, artifact.sha256); await reopenedObjects.close();
  await cloud.instances.stop(instance.id).wait();
  assert.equal((await cloud.instances.get(instance.id)).status, "idle");
  assert((await cloud.volumes.get(disk.id)).revision > 0);
  report("real cloud start + agent execution + durable volume sync + origin-local object bytes", { kernel: output.output.trim(), objectSha256: artifact.sha256, diskRevision: (await cloud.volumes.get(disk.id)).revision });

  await cloud.instances.start(instance.id).wait();
  const reopened = await agent.exec("set -e; test ! -e /root/volatile.txt; cat /mnt/volumes/disk0/record.txt");
  assert.equal(reopened.status, "exited"); assert.equal(reopened.exitCode, 0); assert.equal(reopened.output, "cloud durable café 🐧\n");
  await cloud.instances.pause(instance.id).wait(); assert.equal((await cloud.instances.get(instance.id)).status, "paused");
  await assert.rejects(cloud.instances.stop(instance.id).wait(), /Resume.*sync/);
  await cloud.instances.resume(instance.id).wait();
  await cloud.instances.stop(instance.id).wait();
  await assert.rejects(cloud.volumes.delete(disk.id).wait(), /Detach/);
  await cloud.instances.detachVolume(instance.id, disk.id).wait();
  const preserved = await cloud.volumes.snapshot(disk.id, { name: "Cloud preserved disk" }).wait(); volumes.push(preserved.id);
  const cloned = await cloud.volumes.clone(preserved.id, { name: "Cloud writable clone" }).wait(); volumes.push(cloned.id);
  assert.equal(preserved.kind, "snapshot"); assert.match(preserved.sha256, /^[a-f0-9]{64}$/); assert.equal(cloned.sourceId, preserved.id);
  assert.equal((await volumeStorage.exportVolume(cloned.id)).sha256, preserved.sha256);
  await cloud.instances.delete(instance.id).wait();
  await cloud.subnets.delete(vpc.id, subnet.id).wait();
  await cloud.vpcs.delete(vpc.id).wait();
  assert.equal((await cloud.instances.list()).length, 1);
  await cloud.instances.delete(baseline.id).wait();
  for (const remainingVpc of await cloud.vpcs.list()) {
    for (const remainingSubnet of remainingVpc.subnets) await cloud.subnets.delete(remainingVpc.id, remainingSubnet.id).wait();
    await cloud.vpcs.delete(remainingVpc.id).wait();
  }
  assert.deepEqual(await cloud.instances.list(), []); assert.deepEqual(await cloud.vpcs.list(), []);
  const reopenedWorkspace = new MachineWorkspace();
  assert.deepEqual(reopenedWorkspace.list(), []); assert.deepEqual(reopenedWorkspace.getSnapshot().vpcs, []);
  assert.deepEqual(reopenedWorkspace.getSnapshot().recovery, []);
  report("deleting the final instance, subnet and VPC persists an empty workspace with no resurrection");
  report("stop/restart discards RAM while real disk bytes persist; pause/resume and snapshot/clone/delete gates reach their owners", { emulatorInstances: emulatorCount, snapshotSha256: preserved.sha256 });
  assert(cloud.events.list().some((event) => event.type === "operation.failed"));
  assert(cloud.events.list().some((event) => event.type === "operation.succeeded" && event.resourceId === instance.id));
  report("cloud control-plane integration complete", { operations: cloud.operations.list().length, events: cloud.events.list().length });
} finally {
  for (const machine of workspace.list()) {
    await machine.runtime.destroy().catch(() => {});
    for (const unsubscribe of machine.unsubscribe) unsubscribe();
    machine.runner.dispose(); machine.port.dispose();
  }
  for (const id of volumes) await volumeStorage.deleteVolume(id).catch(() => {});
  await cloud.objectStore.close().catch(() => {});
  cloud.dispose();
  hooks.deregister();
}
