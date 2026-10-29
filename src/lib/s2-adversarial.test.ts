// SPDX-License-Identifier: Apache-2.0
// Adversarial unit fixtures. These do not execute Linux or qualify browser gates.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { DEFAULT_MACHINE, MACHINE_STORAGE_KEY, VPC_STORAGE_KEY } from "./machine-config.ts";
import { DEFAULT_VPCS } from "./vpc-config.ts";
import { loadWorkspaceManifest, validateWorkspaceManifest, WORKSPACE_STORAGE_KEY } from "./workspace-persistence.ts";
import { defaultX86MachineConfiguration } from "./x86-machine-config.ts";
import { OWNED_QEMU_BUNDLE_ID } from "./qemu-assets.ts";
import { fixtureComponents, fixtureManifest } from "./machine-image.test-fixtures.ts";
import { canonicalMachineImageManifest } from "./machine-image.ts";
import { startQemu } from "../../public/runtime/qemu/engine.js";
import { QemuRuntime } from "./qemu-runtime.ts";

class Storage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function machine(id: string, ip: string) {
  return { ...structuredClone(DEFAULT_MACHINE), id, name: id, profile: "alpine-x86_64" as const, ip,
    x86: defaultX86MachineConfiguration({ mac: "02:11:22:33:44:55" }) };
}

test("S2 migration rejects new hardware/image fields in historical keys and preserves exact input", () => {
  for (const x86 of [machine("first", "192.168.76.10").x86,
    defaultX86MachineConfiguration({ runtimeBundleId: OWNED_QEMU_BUNDLE_ID,
      image: { kind: "custom", id: "d".repeat(64) }, hostname: "parser-fixture" })]) {
    const storage = new Storage();
    const saved = JSON.stringify([{ ...machine("first", "192.168.76.10"), x86 }]);
    storage.setItem(MACHINE_STORAGE_KEY, saved);
    storage.setItem(VPC_STORAGE_KEY, JSON.stringify(DEFAULT_VPCS));
    const loaded = loadWorkspaceManifest(storage);
    assert.ok(loaded.error, "A pre-S2 key must not assign unverified S2 hardware or image identity.");
    assert.deepEqual(loaded.manifest.machines, []);
    assert.equal(storage.getItem(MACHINE_STORAGE_KEY), saved);
    assert.equal(storage.getItem(WORKSPACE_STORAGE_KEY), null);
  }
});

test("S2 authoritative inventory refuses duplicate NICs exactly as live configuration does", () => {
  const storage = new Storage();
  const saved = JSON.stringify({ schema: "terrarium.workspace/v2", revision: 12, updatedAt: 1,
    activeId: "first", vpcs: structuredClone(DEFAULT_VPCS), activity: [],
    machines: [machine("first", "192.168.76.10"), machine("second", "192.168.76.11")] });
  storage.setItem(WORKSPACE_STORAGE_KEY, saved);
  assert.throws(() => validateWorkspaceManifest(JSON.parse(saved)), /NIC|identity|identities/i);
  const loaded = loadWorkspaceManifest(storage);
  assert.ok(loaded.error);
  assert.deepEqual(loaded.manifest.machines, []);
  assert.equal(storage.getItem(WORKSPACE_STORAGE_KEY), saved);
});

test("S2 v0.4 legacy and v0.7 envelope shapes still migrate without mutating their source", () => {
  const first = machine("first", "192.168.76.10"), second = machine("second", "192.168.76.11");
  const old = [first, second].map(({ x86: _hardware, ...definition }) => definition);
  for (const envelope of [false, true]) {
    const storage = new Storage();
    const key = envelope ? WORKSPACE_STORAGE_KEY : MACHINE_STORAGE_KEY;
    const saved = JSON.stringify(envelope ? { schema: "terrarium.workspace/v1", revision: 8, updatedAt: 1,
      activeId: "second", vpcs: structuredClone(DEFAULT_VPCS), activity: [], machines: old } : old);
    storage.setItem(key, saved);
    if (!envelope) storage.setItem(VPC_STORAGE_KEY, JSON.stringify(DEFAULT_VPCS));
    const loaded = loadWorkspaceManifest(storage);
    assert.equal(loaded.error, null);
    assert.equal(loaded.manifest.schema, "terrarium.workspace/v2");
    assert.equal(loaded.manifest.machines.length, 2);
    assert.notEqual(loaded.manifest.machines[0].x86!.nic.mac, loaded.manifest.machines[1].x86!.nic.mac);
    assert.equal(storage.getItem(key), saved);
    assert.equal(loaded.manifest.activeId, envelope ? "second" : "first");
  }
});

test("S2 worker accepts the same effective default hostname as the image assignment contract", async () => {
  const bytes = fixtureComponents();
  const manifest = fixtureManifest(bytes);
  const withDefault = { ...manifest, boot: { ...manifest.boot, hostname: "terrarium" } };
  const id = createHash("sha256").update(canonicalMachineImageManifest(withDefault)).digest("hex");
  const configured = defaultX86MachineConfiguration({ runtimeBundleId: OWNED_QEMU_BUNDLE_ID,
    image: { kind: "custom", id } });
  assert.equal(configured.kernelSettings.hostname, undefined);
  let adapterReached = false;
  const before = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  try {
    await assert.rejects(startQemu({ runtimeBundleId: OWNED_QEMU_BUNDLE_ID, machine: configured,
      mac: configured.nic.mac, assets: {}, manifest: {}, customImage: { id, manifest: withDefault, ...bytes } }, {
      emit() {}, pthreadUrl: "fixture-unused",
      async loadModule() { adapterReached = true; throw new Error("ADAPTER_REACHED: synthetic bytes must never execute."); },
    }), /ADAPTER_REACHED/);
    assert.equal(adapterReached, true);
  } finally {
    if (before) Object.defineProperty(globalThis, "WebSocket", before); else Reflect.deleteProperty(globalThis, "WebSocket");
  }
});

test("S2 custom identity is labelled honestly before verification and capabilities follow configuration", async () => {
  const custom = defaultX86MachineConfiguration({ runtimeBundleId: OWNED_QEMU_BUNDLE_ID,
    image: { kind: "custom", id: "c".repeat(64) } });
  const runtime = new QemuRuntime({ machine: custom });
  try {
    assert.match(runtime.capabilities.label, /Custom Linux image cccccccccccc/);
    assert.match(runtime.getSnapshot().message, /Custom Linux image cccccccccccc/);
    assert.equal(runtime.capabilities.snapshots, false);
    const builtin = defaultX86MachineConfiguration({ runtimeBundleId: OWNED_QEMU_BUNDLE_ID, mac: custom.nic.mac });
    runtime.setMachineConfiguration(builtin);
    assert.doesNotMatch(runtime.capabilities.label, /Custom Linux image/);
    assert.equal(runtime.capabilities.snapshots, true);
    runtime.setMachineConfiguration(defaultX86MachineConfiguration({ presetId: "worker", mac: custom.nic.mac }));
    assert.equal(runtime.capabilities.snapshots, false);
    assert.equal(runtime.getSnapshot().machineConfiguration!.presetId, "worker");
    runtime.setMachineConfiguration(custom);
    assert.match(runtime.capabilities.label, /Custom Linux image cccccccccccc/);
    assert.equal(runtime.capabilities.snapshots, false);
  } finally { await runtime.destroy(); }
});
