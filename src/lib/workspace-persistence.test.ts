// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MACHINE, MACHINE_STORAGE_KEY, VPC_STORAGE_KEY } from "./machine-config.ts";
import { DEFAULT_VPCS } from "./vpc-config.ts";
import { commitWorkspaceManifest, loadWorkspaceManifest, validateWorkspaceManifest, WORKSPACE_STORAGE_KEY, type WorkspaceManifest } from "./workspace-persistence.ts";

class Storage {
  values = new Map<string, string>();
  failWrites = false;
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.failWrites) throw new Error("QuotaExceededError"); this.values.set(key, value); }
}
function update(manifest: WorkspaceManifest) {
  return { activeId: manifest.activeId, machines: manifest.machines, vpcs: manifest.vpcs, activity: manifest.activity };
}

test("one manifest migrates legacy configuration, preserving selection and committed empty inventories", () => {
  const storage = new Storage();
  storage.setItem(MACHINE_STORAGE_KEY, JSON.stringify([DEFAULT_MACHINE]));
  storage.setItem(VPC_STORAGE_KEY, JSON.stringify(DEFAULT_VPCS));
  const loaded = loadWorkspaceManifest(storage);
  assert.equal(loaded.error, null); assert.equal(loaded.migrated, true);
  const first = commitWorkspaceManifest(storage, loaded.manifest, update(loaded.manifest));
  const deleted = commitWorkspaceManifest(storage, first, { machines: [], vpcs: [], activeId: "", activity: [] });
  assert.equal(deleted.revision, 2);
  const reopened = loadWorkspaceManifest(storage);
  assert.equal(reopened.migrated, false);
  assert.deepEqual(reopened.manifest.machines, []);
  assert.deepEqual(reopened.manifest.vpcs, []);
  assert.equal(reopened.manifest.activeId, "");
  assert.ok(storage.getItem(MACHINE_STORAGE_KEY)?.includes("local-01"), "Legacy data remains but cannot resurrect a deleted definition");
});

test("legacy empty inventories are intentional, while absent storage gets the starter once", () => {
  const storage = new Storage();
  assert.equal(loadWorkspaceManifest(storage).manifest.machines.length, 1);
  storage.setItem(MACHINE_STORAGE_KEY, "[]"); storage.setItem(VPC_STORAGE_KEY, "[]");
  const loaded = loadWorkspaceManifest(storage);
  assert.equal(loaded.error, null); assert.deepEqual(loaded.manifest.machines, []); assert.deepEqual(loaded.manifest.vpcs, []);
});

test("failed atomic save leaves the last complete inventory available", () => {
  const storage = new Storage();
  const current = loadWorkspaceManifest(storage).manifest;
  const first = commitWorkspaceManifest(storage, current, update(current));
  const original = storage.getItem(WORKSPACE_STORAGE_KEY);
  storage.failWrites = true;
  assert.throws(() => commitWorkspaceManifest(storage, first, { machines: [], vpcs: [], activeId: "", activity: [] }), /not saved/);
  assert.equal(storage.getItem(WORKSPACE_STORAGE_KEY), original);
  assert.equal(loadWorkspaceManifest(storage).manifest.machines[0].id, DEFAULT_MACHINE.id);
});

test("a stale writer cannot reintroduce a deleted machine", () => {
  const storage = new Storage();
  const initial = loadWorkspaceManifest(storage).manifest;
  const first = commitWorkspaceManifest(storage, initial, update(initial));
  commitWorkspaceManifest(storage, first, { machines: [], vpcs: DEFAULT_VPCS, activeId: "", activity: [] });
  assert.throws(() => commitWorkspaceManifest(storage, first, update(first)), /another tab/);
  assert.deepEqual(loadWorkspaceManifest(storage).manifest.machines, []);
});

test("corrupt manifests are preserved and reported without defaults or legacy fallback", () => {
  const storage = new Storage();
  storage.setItem(MACHINE_STORAGE_KEY, JSON.stringify([DEFAULT_MACHINE]));
  for (const corrupt of ["{broken", JSON.stringify({ schema: "terrarium.workspace/v100" })]) {
    storage.setItem(WORKSPACE_STORAGE_KEY, corrupt);
    const loaded = loadWorkspaceManifest(storage);
    assert.ok(loaded.error); assert.deepEqual(loaded.manifest.machines, []); assert.deepEqual(loaded.manifest.vpcs, []);
    assert.equal(storage.getItem(WORKSPACE_STORAGE_KEY), corrupt);
  }
});

test("invalid individual entries or references fail visibly instead of skipping resources", () => {
  const storage = new Storage();
  const initial = loadWorkspaceManifest(storage).manifest;
  assert.throws(() => validateWorkspaceManifest({ ...initial, machines: [{ ...DEFAULT_MACHINE, vpcId: "missing" }] }), /invalid/);
  assert.throws(() => validateWorkspaceManifest({ ...initial, machines: [DEFAULT_MACHINE, DEFAULT_MACHINE] }), /invalid/);
  assert.throws(() => validateWorkspaceManifest({ ...initial, activeId: "missing" }), /selection/);
  assert.throws(() => validateWorkspaceManifest({ ...initial, activity: [{ id: "deleted", status: "running", updatedAt: 1 }] }), /session/);
});

test("active-session markers persist with their machine and cannot outlive deletion", () => {
  const storage = new Storage();
  const initial = loadWorkspaceManifest(storage).manifest;
  const activity = [{ id: DEFAULT_MACHINE.id, status: "running" as const, updatedAt: 12345 }];
  const first = commitWorkspaceManifest(storage, initial, { ...update(initial), activity });
  assert.deepEqual(loadWorkspaceManifest(storage).manifest.activity, activity);
  assert.throws(() => commitWorkspaceManifest(storage, first, { ...update(first), machines: [], activeId: "" }), /session/);
  commitWorkspaceManifest(storage, first, { machines: [], vpcs: DEFAULT_VPCS, activeId: "", activity: [] });
  assert.deepEqual(loadWorkspaceManifest(storage).manifest.activity, []);
});

test("commits copy input and never persist World network access", () => {
  const storage = new Storage();
  const initial = loadWorkspaceManifest(storage).manifest;
  const next = commitWorkspaceManifest(storage, initial, update(initial));
  initial.machines[0].name = "caller-changed";
  assert.equal(next.machines[0].name, DEFAULT_MACHINE.name);
  assert.throws(() => validateWorkspaceManifest({ ...next, machines: [{ ...DEFAULT_MACHINE, network: "world" }] }), /invalid/);
});
