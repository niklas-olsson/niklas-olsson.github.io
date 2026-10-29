// SPDX-License-Identifier: Apache-2.0
// Actual MachineWorkspace + installed page API, with two real Linux guests.
// Node mocks browser storage; this does not measure browser memory capacity.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import "fake-indexeddb/auto";
import { V86 } from "v86";
import "../public/runtime/libv86.js";

// The application uses Vite's extensionless imports. Resolve only this repo's
// relative source imports in the Node harness; do not rewrite application code.
const sourceRoot = new URL("../src/", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith(".") && !/\.[a-zA-Z0-9]+$/.test(specifier))
      return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

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
async function verifiedAsset(file) {
  const asset = provenance.externalGuestAssets.find((entry) => entry.file === file);
  assert.ok(asset, "Missing pinned asset: " + file);
  let bytes;
  if (process.env.TERRARIUM_VM_ASSET_DIR) {
    bytes = await readFile(resolve(process.env.TERRARIUM_VM_ASSET_DIR, file === "buildroot-bzimage68.bin" ? file : "bios/" + file));
  } else {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(60_000), credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok || !response.body) throw new Error("Unable to fetch " + file);
    bytes = new Uint8Array(asset.bytes);
    let count = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (count + value.byteLength > bytes.length) throw new Error("Guest asset exceeded its expected size.");
        bytes.set(value, count); count += value.byteLength;
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    assert.equal(count, asset.bytes, "Incomplete guest asset");
  }
  assert.equal(bytes.byteLength, asset.bytes, "Unexpected size: " + file);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256, "Unexpected digest: " + file);
  return [asset.url, bytes];
}
const assets = new Map(await Promise.all(["buildroot-bzimage68.bin", "seabios.bin", "vgabios.bin"].map(verifiedAsset)));
let emulatorCount = 0;
class HostV86 extends V86 {
  constructor(options) { super({ ...options, wasm_path: fileURLToPath(options.wasm_path) }); emulatorCount++; }
}
globalThis.window = { setTimeout, clearTimeout, V86: HostV86, localStorage: storage, indexedDB: globalThis.indexedDB };
globalThis.document = { baseURI: new URL("../public/", import.meta.url).href };
globalThis.fetch = async (url) => {
  const asset = assets.get(String(url));
  if (!asset) throw new Error("Unexpected URL: " + url);
  return new Response(asset);
};
const { MachineWorkspace, workspace } = await import("../src/lib/machines.ts");
const { installAgentBridge } = await import("../src/lib/agent-bridge.ts");
const { parseMachineConfigs } = await import("../src/lib/machine-config.ts");
const { WORKSPACE_STORAGE_KEY, loadWorkspaceManifest, validateWorkspaceManifest } = await import("../src/lib/workspace-persistence.ts");
const report = (name, details = {}) => console.log(JSON.stringify({ name, passed: true, ...details }));
let restored;
const stops = [];
try {
  assert.ok(workspace instanceof MachineWorkspace);
  assert.equal(workspace.list().length, 1);
  for (let number = 2; number <= 6; number++) workspace.add(`fleet-${String(number).padStart(2, "0")}`, "x86");
  assert.equal(workspace.list().length, 6);
  assert.equal(emulatorCount, 0, "Definitions must not allocate running VMs");
  const configs = workspace.list().map((entry) => entry.config);
  const ids = configs.map((config) => config.id);
  const stored = validateWorkspaceManifest(JSON.parse(storage.getItem(WORKSPACE_STORAGE_KEY)));
  assert.deepEqual(stored.machines.map((config) => config.id), ids);
  assert.deepEqual(parseMachineConfigs(stored.machines, stored.vpcs).map((config) => config.id), ids);
  assert.deepEqual(loadWorkspaceManifest(storage).manifest.machines.map((config) => config.id), ids);
  restored = new MachineWorkspace();
  assert.deepEqual(restored.list().map((entry) => entry.id), ids);
  assert.equal(restored.getSnapshot().storageAvailable, true);
  assert.equal(emulatorCount, 0);
  report("six actual manager definitions survive save, parse, load, and a new workspace instance", { definitions: ids.length, emulatorInstances: emulatorCount });

  installAgentBridge({ active: restored.active, list: restored.list, get: (id) => restored.list().find((entry) => entry.id === id) });
  assert.equal(window.terrarium.list().length, 6);
  const fifth = window.terrarium.get(ids[4]);
  const sixth = window.terrarium.get(ids[5]);
  const live = ["", ""];
  stops.push(fifth.subscribeOutput((event) => { if (event.type === "data") live[0] = (live[0] + event.data).slice(-262144); }));
  stops.push(sixth.subscribeOutput((event) => { if (event.type === "data") live[1] = (live[1] + event.data).slice(-262144); }));
  assert.equal((await fifth.boot()).status, "running");
  assert.equal((await sixth.boot()).status, "running");
  assert.equal(emulatorCount, 2, "Only fifth and sixth definitions should boot");
  assert.ok(restored.list().slice(0, 4).every((entry) => entry.runtime.getSnapshot().status === "idle"));
  const results = await Promise.all([
    fifth.exec("printf 'fifth\\n' > /root/workspace-proof; uname -a"),
    sixth.exec("printf 'sixth\\n' > /root/workspace-proof; uname -a"),
  ]);
  for (const result of results) {
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /^Linux .*i686/);
  }
  assert.equal((await fifth.exec("cat /root/workspace-proof")).output, "fifth\n");
  assert.equal((await sixth.exec("cat /root/workspace-proof")).output, "sixth\n");
  assert.ok(live.every((text) => text.includes("Linux (none)")));
  restored.select(ids[4]);
  assert.equal((await window.terrarium.exec("cat /root/workspace-proof")).output, "fifth\n");
  assert.equal(window.terrarium.list().filter((entry) => entry.status === "running").length, 2);
  assert.deepEqual(loadWorkspaceManifest(storage).manifest.machines.map((config) => config.id), ids);
  assert.equal(loadWorkspaceManifest(storage).manifest.activeId, ids[4]);
  report("fifth and sixth machines boot and execute real Linux independently through the installed page API", { names: restored.list().slice(4).map((entry) => entry.name), emulatorInstances: emulatorCount, outputs: results.map((result) => result.output.trim()) });
  report("workspace beyond-four regression smoke complete", { savedDefinitions: 6, runningGuests: 2 });
} finally {
  for (const stop of stops) stop();
  for (const owner of [workspace, restored]) {
    if (!owner) continue;
    for (const machine of owner.list()) {
      await machine.runtime.destroy();
      for (const unsubscribe of machine.unsubscribe) unsubscribe();
      machine.runner.dispose();
      machine.port.dispose();
    }
  }
  hooks.deregister();
}
