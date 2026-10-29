// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { createCloudControlPlane, CloudError, type CloudInstanceCreate, type CloudInstanceRecord, type CloudProvider } from "./cloud.ts";
import { CloudObjectStore } from "./cloud-object-store.ts";
import { VirtualNetwork } from "./network.ts";
import { ALLOW_ALL_POLICY } from "./network-policy.ts";
import { parseVpcConfigs } from "./vpc-config.ts";

// This fixture supplies only compute metadata. Network mutations use the actual
// host network owner; real VM lifecycle is covered by scripts/smoke-cloud.mjs.
function fixture(quarantined = false) {
  const network = new VirtualNetwork();
  const port = network.createPort("baseline", "192.168.76.10", { quarantined });
  const calls: string[] = []; let name = "baseline"; let present = true;
  const instance = (): CloudInstanceRecord => {
    if (!present) throw new CloudError("not_found", "The fixture instance was deleted.");
    const state = port.getSnapshot();
    return { id: "baseline", name, imageId: "x86", status: "idle", message: "Fixture metadata", vpcId: state.vpcId, subnetId: state.subnetId, ip: state.ip, memoryMiB: 128, networkMode: state.mode, quarantined: state.quarantined, ephemeral: quarantined, commandBusy: false, operation: null, volumeAttachments: [] };
  };
  const control = (action: string) => () => { calls.push(action); return instance(); };
  const vpc = (id: string) => { const result = network.listVpcs().find((entry) => entry.id === id); if (!result) throw new Error("Missing VPC"); return result; };
  const subnet = (vpcId: string, id: string) => { const result = vpc(vpcId).subnets.find((entry) => entry.id === id); if (!result) throw new Error("Missing subnet"); return { ...result, vpcId }; };
  const provider: CloudProvider = {
    images: [{ id: "x86", name: "Pinned test registry", architecture: "i686", bits: 32, memoryMiB: 128, description: "Provider registry fixture", kernel: "6.8", userland: "BusyBox", capabilities: { snapshots: true }, limitations: [] }],
    instances: {
      list: () => present ? [instance()] : [], get: () => instance(), create: control("create"),
      update: (_id, patch) => { if (patch.name !== undefined) name = patch.name; calls.push("update"); return instance(); },
      start: control("start"), pause: control("pause"), resume: control("resume"), stop: control("stop"), remove: () => { calls.push("remove"); port.dispose(); present = false; },
      setNetwork: (_id, mode) => { calls.push("setNetwork"); port.setMode(mode); return instance(); },
      configureTransport: (_id, transport) => { calls.push("transport"); port.configureTransport(transport); return instance(); },
      setPolicy: (_id, policy) => { calls.push("policy"); port.setPolicy(policy); return instance(); },
      move: (_id, attachment) => { calls.push("move"); port.configureAttachment(attachment); return instance(); },
      attachVolume: control("attachVolume"), detachVolume: control("detachVolume"),
    },
    vpcs: { list: network.listVpcs, create: (input) => { network.addVpc(input); return vpc(input.id); }, update: (id, patch) => { network.updateVpc(id, patch); return vpc(id); }, remove: (id) => network.removeVpc(id) },
    subnets: { create: (vpcId, input) => { network.addSubnet(vpcId, input); return subnet(vpcId, input.id); }, update: (vpcId, id, patch) => { network.updateSubnet(vpcId, id, patch); return subnet(vpcId, id); }, remove: (vpcId, id) => network.removeSubnet(vpcId, id) },
  };
  const cloud = createCloudControlPlane(provider, { objectStore: new CloudObjectStore({ indexedDB: new IDBFactory(), databaseName: crypto.randomUUID() }) });
  return { cloud, calls, network, port, provider };
}

test("the cloud facade cannot release quarantine even with an unrestricted simulated identity", async () => {
  const { cloud, calls, port } = fixture(true);
  cloud.simulation.identities.set({ id: "allowed", allow: ["*"], deny: [] });
  const options = { identity: "allowed" };
  const blocked = [
    cloud.instances.setNetwork("baseline", "local", options),
    cloud.instances.setNetwork("baseline", "world", options),
    cloud.instances.configureTransport("baseline", { kind: "web" }, options),
    cloud.instances.setPolicy("baseline", ALLOW_ALL_POLICY, options),
    cloud.instances.move("baseline", { vpcId: "default", subnetId: "default", ip: "192.168.76.11" }, options),
    cloud.instances.attachVolume("baseline", { volumeId: "disk" }, options),
    cloud.instances.detachVolume("baseline", "disk", options),
  ];
  await Promise.all(blocked.map((operation) => assert.rejects(operation.wait(), (error) => error instanceof CloudError && error.code === "quarantined")));
  assert.deepEqual(calls, []);
  const copied = await cloud.instances.get("baseline"); copied.quarantined = false;
  assert.equal((await cloud.instances.get("baseline")).quarantined, true);
  await cloud.instances.setNetwork("baseline", "isolated", options).wait();
  port.setReady(false); assert.equal(port.getSnapshot().quarantined, true); assert.equal(port.getSnapshot().mode, "isolated");
  assert.throws(() => port.setMode("world"), /quarantined/);
  port.dispose();
});

test("resource reads are current provider copies with stable versioned identities", async () => {
  const { cloud, calls, port } = fixture();
  const before = await cloud.instances.get("baseline");
  const changed = await cloud.instances.update("baseline", { name: "renamed" }).wait();
  assert.equal(changed.urn, before.urn); assert.equal(changed.apiVersion, "terrarium.local/v1alpha1");
  const described = await cloud.metadata.describe("baseline"); assert.equal(described.instance.name, "renamed"); assert.equal(described.source, "live-workspace-registry");
  assert.equal(before.name, "baseline");
  described.instance.name = "caller mutation"; assert.equal((await cloud.instances.get("baseline")).name, "renamed");
  assert.equal("submit" in cloud.operations, false, "The public journal cannot submit arbitrary callbacks as cloud operations");
  assert.throws(() => cloud.instances.create({ name: "unknown", imageId: "unverified" }), (error) => error instanceof CloudError && error.code === "not_found");
  assert.deepEqual(calls, ["update"]); port.dispose();
});

test("x86_64 create rejects undeclared options before inventory mutation while existing profiles retain their contract", async () => {
  const { cloud, calls, port, provider } = fixture();
  const original = await provider.instances.get("baseline"), accepted: CloudInstanceCreate[] = [];
  const base = provider.images[0];
  provider.images = [...provider.images,
    { ...base, id: "alpine-x86_64", architecture: "x86_64", bits: 64, memoryMiB: 512 },
    { ...base, id: "riscv64", architecture: "riscv64", bits: 64 },
  ];
  provider.instances.create = (input) => {
    accepted.push(structuredClone(input)); calls.push("create");
    return { ...original, name: input.name, imageId: input.imageId };
  };
  const valid = { name: "small", imageId: "alpine-x86_64", initScript: "echo small", vpcId: "default", subnetId: "default", ip: "192.168.76.11" };
  let getterCalls = 0;
  try {
    const inventory = await cloud.instances.list(), operations = cloud.operations.list();
    for (const extra of [{ memoryMiB: 1024 }, { virtualCpus: 2 }, { arguments: ["-m", "8G"] },
      { kernel: "https://unverified.invalid/kernel" }, { defaultBootBundleId: "unregistered" }]) {
      assert.throws(() => cloud.instances.create({ ...valid, ...extra }),
        error => error instanceof CloudError && error.code === "unsupported" && /unsupported option/.test(error.message));
    }
    const getter = Object.defineProperty({ ...valid }, "memoryMiB", {
      get() { getterCalls++; throw new Error("An unknown option getter must not execute"); },
    });
    assert.throws(() => cloud.instances.create(getter), error => error instanceof CloudError
      && error.code === "unsupported" && /unsupported option "memoryMiB"/.test(error.message));
    assert.throws(() => cloud.instances.create(Object.assign(Object.create({ virtualCpus: 2 }), valid)),
      error => error instanceof CloudError && error.code === "unsupported" && /plain options/.test(error.message));
    assert.equal(getterCalls, 0); assert.deepEqual(calls, []); assert.deepEqual(accepted, []);
    assert.deepEqual(cloud.operations.list(), operations, "Rejected hardware cannot create a queued operation");
    assert.deepEqual(await cloud.instances.list(), inventory);
    await cloud.instances.create(Object.assign(Object.create(null), valid)).wait();
    assert.deepEqual(accepted[0], valid, "All declared existing x86_64 fields remain accepted");
    for (const imageId of ["x86", "riscv64"]) {
      const legacy = { name: imageId, imageId, memoryMiB: 1024, virtualCpus: 2 };
      await cloud.instances.create(legacy).wait();
      assert.deepEqual(accepted.at(-1), { name: imageId, imageId, initScript: "" }, "Other profiles retain the prior option projection");
    }
  } finally { cloud.dispose(); port.dispose(); }
});

test("optional services report unsupported instead of producing a simulated success", async () => {
  const { cloud, calls, port } = fixture();
  for (const operation of [cloud.instances.syncVolumes("baseline"), cloud.volumes.create({ name: "data", sizeMiB: 8 })]) {
    await assert.rejects(operation.wait(), (error) => error instanceof CloudError && error.code === "unsupported"); assert.equal(operation.get().status, "failed");
  }
  await assert.rejects(cloud.volumes.list(), (error) => error instanceof CloudError && error.code === "unsupported");
  assert.deepEqual(calls, []); port.dispose();
});

test("subnet operations mutate the host owner and reject occupied CIDR changes or removal atomically", async () => {
  const { cloud, network, port } = fixture();
  const request = { name: "VPC", cidr: "10.80.0.0/16", subnets: [{ name: "Active", cidr: "10.80.1.0/24" }] };
  const creation = cloud.vpcs.create(request, { idempotencyKey: "vpc" }); const vpc = await creation.wait();
  assert.strictEqual(cloud.vpcs.create(request, { idempotencyKey: "vpc" }), creation);
  const worker = network.createPort("worker", "10.80.1.10", { vpcId: vpc.id, subnetId: vpc.subnets[0].id });
  const before = network.listVpcs();
  await assert.rejects(cloud.subnets.update(vpc.id, vpc.subnets[0].id, { cidr: "10.80.2.0/24" }).wait(), /occupied/);
  await assert.rejects(cloud.subnets.delete(vpc.id, vpc.subnets[0].id).wait(), /machine/);
  assert.deepEqual(network.listVpcs(), before);
  const renamed = await cloud.subnets.update(vpc.id, vpc.subnets[0].id, { name: "Renamed safely" }).wait(); assert.equal(renamed.name, "Renamed safely");
  const added = await cloud.subnets.create(vpc.id, { name: "Free", cidr: "10.80.2.0/24" }).wait();
  assert.equal((await cloud.subnets.update(vpc.id, added.id, { cidr: "10.80.3.0/24" }).wait()).cidr, "10.80.3.0/24");
  assert.equal((await cloud.subnets.get(vpc.id, added.id)).urn, added.urn);
  await cloud.subnets.delete(vpc.id, added.id).wait();
  worker.dispose();
  await assert.rejects(cloud.vpcs.delete(vpc.id).wait(), /child subnets/);
  await cloud.subnets.delete(vpc.id, vpc.subnets[0].id).wait();
  await cloud.vpcs.delete(vpc.id).wait(); assert.equal(network.listVpcs().length, 1); port.dispose(); cloud.dispose();
});

test("delete previews identify stopped dependencies and allow removing the last subnet and VPC without recreating defaults", async () => {
  const { cloud, network } = fixture();
  const blocked = await cloud.deletions.preview({ type: "subnet", id: "default", vpcId: "default" });
  assert.equal(blocked.allowed, false); assert.equal(blocked.blockers[0].name, "baseline"); assert.match(blocked.blockers[0].message, /idle/);
  await cloud.instances.delete("baseline").wait(); assert.deepEqual(await cloud.instances.list(), []);
  const parent = await cloud.deletions.preview({ type: "vpc", id: "default" });
  assert.equal(parent.allowed, false); assert.equal(parent.blockers[0].type, "subnet"); assert.equal(parent.blockers[0].name, "Default subnet");
  await assert.rejects(cloud.vpcs.delete("default").wait(), /Default subnet/);
  await cloud.subnets.delete("default", "default").wait();
  assert.deepEqual((await cloud.vpcs.get("default")).subnets, []);
  assert.equal((await cloud.deletions.preview({ type: "vpc", id: "default" })).allowed, true);
  await cloud.vpcs.delete("default").wait(); assert.deepEqual(network.listVpcs(), []); assert.deepEqual(parseVpcConfigs([]), []);
  const empty = await cloud.vpcs.create({ name: "Empty", cidr: "10.80.0.0/16", subnets: [] }).wait();
  assert.deepEqual(parseVpcConfigs([empty])[0].subnets, []);
  const subnet = await cloud.subnets.create(empty.id, { name: "Later", cidr: "10.80.1.0/24" }).wait();
  await cloud.subnets.delete(empty.id, subnet.id).wait(); await cloud.vpcs.delete(empty.id).wait(); assert.deepEqual(network.listVpcs(), []); cloud.dispose();
});

test("deletion preview permits explicit boot cancellation while retaining command and writable-disk blockers", async () => {
  const { cloud, provider, port } = fixture();
  const original = await provider.instances.get("baseline");
  let state: CloudInstanceRecord = { ...original, imageId: "alpine-x86_64", status: "loading", canCancelBoot: true };
  provider.instances.list = () => [state];
  assert.equal((await cloud.deletions.preview({ type: "instance", id: state.id })).allowed, true);
  state = { ...state, status: "booting" };
  assert.equal((await cloud.deletions.preview({ type: "instance", id: state.id })).allowed, true);
  state = { ...state, canCancelBoot: false };
  assert.equal((await cloud.deletions.preview({ type: "instance", id: state.id })).allowed, false);
  state = { ...state, canCancelBoot: true, commandBusy: true };
  assert.equal((await cloud.deletions.preview({ type: "instance", id: state.id })).allowed, false);
  state = { ...state, commandBusy: false, operation: "restoring" };
  assert.equal((await cloud.deletions.preview({ type: "instance", id: state.id })).allowed, false);
  state = { ...state, operation: null, status: "paused", volumeAttachments: [{ volumeId: "disk", slot: 0, readOnly: false }] };
  assert.equal((await cloud.deletions.preview({ type: "instance", id: state.id })).allowed, false);
  port.dispose(); cloud.dispose();
});

test("a dependency added after preview still blocks the actual subnet deletion", async () => {
  const { cloud, network } = fixture(); await cloud.instances.delete("baseline").wait();
  assert.equal((await cloud.deletions.preview({ type: "subnet", id: "default", vpcId: "default" })).allowed, true);
  const late = network.createPort("late", "192.168.76.11", { hostname: "late-worker" });
  await assert.rejects(cloud.subnets.delete("default", "default").wait(), /late-worker/);
  assert.equal((await cloud.subnets.list("default")).length, 1); late.dispose(); cloud.dispose();
});

test("volume attachment and deletion share a lock and deletion rechecks the live dependency", async () => {
  const { cloud, provider, port } = fixture();
  const record = await provider.instances.get("baseline");
  provider.instances.get = () => structuredClone(record); provider.instances.list = () => [structuredClone(record)];
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; }); let deleted = false;
  const volume = { id: "disk", name: "Agent data", bytes: 8 * 1024 * 1024, kind: "volume" as const, createdAt: 1, updatedAt: 1, revision: 0, sha256: null, filesystem: "ext2" as const };
  provider.volumes = { list: () => deleted ? [] : [volume], get: () => volume, create: () => volume, snapshot: () => volume, clone: () => volume, remove: () => { if (record.volumeAttachments.length) throw new CloudError("conflict", "Detach disk from baseline first."); deleted = true; } };
  provider.instances.attachVolume = async () => { await held; record.volumeAttachments = [{ volumeId: "disk", slot: 0, readOnly: false }]; return structuredClone(record); };
  const attachment = cloud.instances.attachVolume("baseline", { volumeId: "disk" });
  const deletion = cloud.volumes.delete("disk", { ifRevision: 0 });
  await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(deletion.get().status, "queued");
  release(); await attachment.wait(); await assert.rejects(deletion.wait(), /Detach/); assert.equal(deleted, false);
  const preview = await cloud.deletions.preview({ type: "volume", id: "disk" }); assert.equal(preview.allowed, false); assert.equal(preview.blockers[0].name, "baseline"); assert.equal(preview.revision, 0);
  port.dispose(); cloud.dispose();
});

test("the singleton ownership guard blocks shared and simulation writes, including delayed dispatch", async () => {
  const { cloud, provider, port, calls } = fixture(); let writable = true;
  provider.assertWritable = () => { if (!writable) throw new CloudError("conflict", "Another tab owns this workspace."); };
  await cloud.objectStore.buckets.create({ name: "owned" });
  cloud.simulation.faults.next({ action: "instances.start", delayMs: 30 });
  const delayed = cloud.instances.start("baseline"); await new Promise<void>((resolve) => setImmediate(resolve)); writable = false;
  await assert.rejects(delayed.wait(), /Another tab/); assert.deepEqual(calls, []);
  await assert.rejects(cloud.objectStore.objects.put("owned", "data", "blocked"), /Another tab/);
  assert.throws(() => cloud.simulation.identities.set({ id: "worker", allow: [], deny: [] }), /Another tab/);
  assert.throws(() => cloud.simulation.faults.next({ action: "instances.start", fail: true }), /Another tab/);
  assert.equal((await cloud.objectStore.buckets.list()).length, 1);
  assert.equal((await cloud.deletions.preview({ type: "instance", id: "baseline" })).allowed, false);
  writable = true; await cloud.objectStore.buckets.delete("owned"); await cloud.objectStore.close(); port.dispose(); cloud.dispose();
});

test("object and simulation API changes publish live invalidations and queued faults can be deleted individually", async () => {
  const { cloud, port } = fixture(); const events: string[] = [];
  const unsubscribe = cloud.subscribe((event) => { if (event.type === "resource.changed") events.push(`${event.resourceType}:${event.action}`); });
  const identity = cloud.simulation.identities.set({ id: "worker", allow: [], deny: [] });
  cloud.simulation.identities.set({ id: "worker", allow: ["instances.start"], deny: [] });
  assert.throws(() => cloud.simulation.identities.delete("worker", { ifRevision: identity.revision }), /changed/);
  assert.equal(cloud.simulation.identities.delete("worker", { ifRevision: cloud.simulation.identities.get("worker").revision }), true);
  const first = cloud.simulation.faults.next({ action: "instances.start", fail: true });
  const second = cloud.simulation.faults.next({ action: "instances.stop", fail: true });
  assert.equal((await cloud.deletions.preview({ type: "fault", id: first.id })).allowed, true);
  assert.equal(cloud.simulation.faults.delete(first.id), true); assert.deepEqual(cloud.simulation.faults.list().map((item) => item.id), [second.id]); cloud.simulation.faults.clear();
  await cloud.objectStore.buckets.create({ name: "events" });
  const object = await cloud.objectStore.objects.put("events", "task/result.txt", "done");
  assert.equal((await cloud.deletions.preview({ type: "bucket", id: "events" })).blockers[0].name, "task/result.txt");
  const preview = await cloud.deletions.preview({ type: "object", id: object.key, bucket: object.bucket }); assert.equal(preview.generation, object.generation);
  await cloud.objectStore.objects.delete("events", object.key, { ifRevision: object.revision, ifGeneration: object.generation }); await cloud.objectStore.buckets.delete("events");
  for (const expected of ["identity:created", "identity:updated", "identity:deleted", "fault:created", "fault:deleted", "fault:cleared", "bucket:created", "object:updated", "object:deleted", "bucket:deleted"]) assert(events.includes(expected), expected);
  unsubscribe(); cloud.dispose(); port.dispose(); await cloud.objectStore.close();
});

test("controlled reload cannot overtake queued cloud operations or object hashing and commits", async () => {
  const { cloud, port } = fixture();
  cloud.simulation.faults.next({ action: "instances.start", delayMs: 30 });
  const first = cloud.instances.start("baseline"), second = cloud.instances.stop("baseline");
  assert.throws(cloud.assertSettled, /pending cloud operations/);
  await first.wait(); await second.wait(); assert.doesNotThrow(cloud.assertSettled);
  const bucket = cloud.objectStore.buckets.create({ name: "reload" }); assert.throws(cloud.assertSettled, /pending object-store mutation/); await bucket;
  const write = cloud.objectStore.objects.put("reload", "data", new Uint8Array(65536)); assert.throws(cloud.assertSettled, /pending object-store mutation/);
  const current = await write; assert.doesNotThrow(cloud.assertSettled);
  const rejected = cloud.objectStore.objects.delete("reload", "data", { ifRevision: current.revision + 1 });
  assert.throws(cloud.assertSettled, /pending object-store mutation/); await assert.rejects(rejected, /revision/); assert.doesNotThrow(cloud.assertSettled);
  await cloud.objectStore.close(); cloud.dispose(); port.dispose();
});
