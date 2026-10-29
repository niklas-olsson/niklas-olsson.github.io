// SPDX-License-Identifier: Apache-2.0
// Production workspace ownership/recovery with Node's real Web Locks and mocked
// browser events/storage. No guest boots, network access, or real browser data.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as workerThreads from "node:worker_threads";
import "fake-indexeddb/auto";

if (!workerThreads.locks) throw Error("Use Node 24.5 or newer for the Web Locks ownership smoke.");
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
const storage = new MemoryStorage(), events = new EventTarget();
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
globalThis.window = {
  setTimeout, clearTimeout, localStorage: storage, indexedDB,
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
};
globalThis.document = { baseURI: "http://localhost/" };
const { DEFAULT_MACHINE } = await import("../src/lib/machine-config.ts");
const { DEFAULT_VPCS } = await import("../src/lib/vpc-config.ts");
const { WORKSPACE_STORAGE_KEY, WORKSPACE_LOCK, validateWorkspaceManifest, loadWorkspaceManifest } = await import("../src/lib/workspace-persistence.ts");
const { withResourceMutation } = await import("../src/lib/resource-events.ts");
const { storeSnapshot, deleteSnapshot } = await import("../src/lib/snapshots.ts");
const firstConfig = structuredClone(DEFAULT_MACHINE);
const secondConfig = { ...structuredClone(DEFAULT_MACHINE), id: "previous-selected", name: "previous-selected", ip: "192.168.76.11" };
const interrupted = { id: firstConfig.id, status: "running", updatedAt: Date.now() - 1_000 };
const seed = validateWorkspaceManifest({
  schema: "terrarium.workspace/v1", revision: 5, updatedAt: Date.now(), activeId: secondConfig.id,
  vpcs: structuredClone(DEFAULT_VPCS), machines: [firstConfig, secondConfig], activity: [interrupted],
});
storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(seed));
const { MachineWorkspace, workspace } = await import("../src/lib/machines.ts");
const owners = [workspace];
const artifacts = [];
let releaseWrite;
let pendingWrite;
const report = (name, extra = {}) => console.log(JSON.stringify({ name, passed: true, ...extra }));
const manifest = () => { const loaded = loadWorkspaceManifest(storage); assert.equal(loaded.error, null); return loaded.manifest; };

async function ownershipReleased() {
  const deadline = Date.now() + 2_000;
  while ((await workerThreads.locks.query()).held.some((lock) => lock.name === WORKSPACE_LOCK)) {
    if (Date.now() >= deadline) throw new Error("The simulated old page did not release its ownership lock.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function checkpoint() {
  const state = Array.from({ length: 94 }, () => null);
  state[0] = 128 * 1024 * 1024; state[1] = { __state_type__: "Uint8Array", buffer_id: 0 }; state[52] = [2 * 1024 * 1024];
  for (const index of [54, 79, 80, 81]) state[index] = [];
  const metadata = new TextEncoder().encode(JSON.stringify({ state, buffer_infos: [{ offset: 0, length: 8 }] }));
  const buffer = new ArrayBuffer(Math.ceil((16 + metadata.length) / 4) * 4 + 8), header = new DataView(buffer);
  header.setUint32(0, 0x86768676, true); header.setUint32(4, 6, true); header.setUint32(8, buffer.byteLength, true); header.setUint32(12, metadata.length, true);
  new Uint8Array(buffer, 16, metadata.length).set(metadata); return buffer;
}

try {
  await workspace.takeControl();
  assert.equal(workspace.getSnapshot().persistence.mode, "writable");
  assert.equal(workspace.getSnapshot().activeId, secondConfig.id);
  assert.deepEqual(workspace.getSnapshot().recovery, [interrupted]);
  assert.deepEqual(manifest().activity, [interrupted]);
  assert(workspace.list().every((entry) => entry.runtime.getSnapshot().status === "idle"));
  workspace.select(firstConfig.id);
  assert.equal(manifest().activeId, firstConfig.id);
  assert.deepEqual(manifest().activity, [interrupted]);
  workspace.select(secondConfig.id);

  const second = new MachineWorkspace(); owners.push(second);
  await assert.rejects(second.takeControl(), /Another Terrarium tab owns/);
  assert.equal(second.getSnapshot().persistence.mode, "read-only");
  assert.equal(second.getSnapshot().activeId, secondConfig.id);
  assert.deepEqual(second.getSnapshot().recovery, [interrupted]);
  assert.throws(() => second.add("forbidden", "x86"), /Another Terrarium tab owns/);
  assert.throws(() => second.get(firstConfig.id).runtime.boot(), /Another Terrarium tab owns/);
  workspace.acknowledgeRecovery(firstConfig.id);
  assert.deepEqual(workspace.getSnapshot().recovery, []);
  assert.deepEqual(manifest().activity, []);
  report("real ownership lock blocks a second manager; saved selection and prior activity survive loading until explicit acknowledgment");

  await workspace.remove(firstConfig.id);
  await workspace.remove(secondConfig.id);
  assert.deepEqual(manifest().machines, []);
  assert.equal(second.list().length, 2, "A read-only view remains stale until it takes ownership and adopts the current manifest.");
  // Test-only page-destruction simulation: the production method is not exposed.
  assert.equal(typeof workspace.releaseOwnership, "function");
  workspace.releaseOwnership();
  await ownershipReleased();
  await second.takeControl();
  assert.equal(second.getSnapshot().persistence.mode, "writable");
  assert.deepEqual(second.list(), []);
  assert.deepEqual(second.getSnapshot().recovery, []);
  assert.equal(second.getSnapshot().activeId, "");
  report("after old-page lock release, the second manager adopts the latest empty manifest without resurrecting deleted resources");

  const waiting = new Promise((resolve) => { releaseWrite = resolve; });
  pendingWrite = withResourceMutation("snapshot", async () => {
    await waiting;
    const artifact = await storeSnapshot("Reload fence proof", checkpoint()); artifacts.push(artifact.id); return artifact;
  });
  await assert.rejects(second.prepareReload(), /saved resource changes/);
  assert.equal(second.getSnapshot().preparingReload, false);
  releaseWrite(); await pendingWrite;
  const idle = second.add("reload-fence", "x86");
  const preparing = second.prepareReload();
  assert.equal(second.getSnapshot().preparingReload, true);
  await assert.rejects(storeSnapshot("Must not start while reloading", checkpoint()), /safe reload/);
  await preparing;
  assert.equal(second.getSnapshot().preparingReload, false);
  assert.deepEqual(manifest().activity, []);
  await second.remove(idle.id);
  report("controlled reload refuses a deferred artifact write and fences new writes through shutdown, then releases normally");
  console.log("PASS: real Web Locks ownership transfer, activity recovery markers, atomic empty inventory and artifact reload fencing. Browser lifecycle events and storage are modeled in Node.");
} finally {
  releaseWrite?.(); await pendingWrite?.catch(() => {});
  for (const owner of owners) {
    for (const machine of owner.list()) {
      await machine.runtime.destroy().catch(() => {});
      for (const unsubscribe of machine.unsubscribe) unsubscribe();
      machine.runner.dispose(); machine.port.dispose();
    }
    owner.releaseOwnership?.(); // Test-only destruction of the modeled page.
  }
  await ownershipReleased();
  for (const id of artifacts) await deleteSnapshot(id).catch(() => {});
  hooks.deregister();
}
