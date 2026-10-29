// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { createNodeQemuWorkers } from "./qemu-node-adapter.mjs";
import { LEGACY_QEMU_BUNDLE_ID } from "../public/runtime/qemu/catalog.js";
import { getQemuBundle } from "../public/runtime/qemu/bundles.js";
import { IO_REQUEST, IO_RESPONSE } from "./qemu-io-diagnostics.mjs";
import { POLL_REQUEST, POLL_RESPONSE, pollExperimentEnable } from "./qemu-poll-diagnostic.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const adapterSource = await readFile(new URL("./qemu-node-adapter.mjs", import.meta.url), "utf8");
function fixture(termination) {
  class FixtureThread extends EventEmitter {
    terminations = 0;
    postMessage() {}
    terminate() { this.terminations++; return termination(this); }
  }
  const declaration = adapterSource.slice(adapterSource.indexOf("export function createNodeQemuWorkers"))
    .replace(/^export /, "").replace("import.meta.url", JSON.stringify(new URL("./qemu-node-adapter.mjs", import.meta.url).href));
  const create = vm.runInNewContext(`(() => { ${declaration}; return createNodeQemuWorkers; })()`, {
    assert, NodeWorker: FixtureThread, URL, getQemuBundle, LEGACY_QEMU_BUNDLE_ID, IO_REQUEST, IO_RESPONSE,
    POLL_REQUEST, POLL_RESPONSE, pollExperimentEnable,
    process: { env: {} }, setTimeout, clearTimeout, console,
  });
  const adapter = create({ temporary: "/unused-fixture", manifest: {}, bundleId: LEGACY_QEMU_BUNDLE_ID });
  const worker = new adapter.Worker("https://terrarium.invalid/runtime/qemu/worker.js", { type: "module" });
  return { adapter, worker };
}

test("native Node adapter termination is awaitable and ownership ends only after its real worker exits", async () => {
  // This creates a real Node worker running the actual dispatcher imports, but
  // sends no boot message and allocates no emulator/guest/Wasm memory.
  const adapter = createNodeQemuWorkers({ temporary: "/unused-native-fixture", manifest: {}, bundleId: LEGACY_QEMU_BUNDLE_ID });
  const worker = new adapter.Worker("https://terrarium.invalid/runtime/qemu/worker.js", { type: "module" });
  try {
    await once(worker.thread, "online");
    const stopped = worker.terminate();
    assert.equal(typeof stopped?.then, "function");
    assert.equal(worker.terminate(), stopped, "Repeated requests share the same native completion");
    assert.equal(worker.stopped, true);
    assert.equal(adapter.workers.has(worker), true, "Requested termination is not proof of exit");
    await stopped;
    assert.equal(worker.thread.threadId, -1);
    assert.equal(adapter.workers.size, 0);
    await adapter.joinTeardown();
  } finally { await worker.terminate(); await adapter.joinTeardown(); }
});

test("Node adapter retains pending termination ownership and rejects new input immediately", async () => {
  const nativeDone = deferred();
  const { adapter, worker } = fixture(() => nativeDone.promise);
  const stopped = worker.terminate();
  assert.equal(worker.terminate(), stopped);
  assert.equal(worker.thread.terminations, 1);
  assert.equal(adapter.workers.size, 1);
  assert.throws(() => worker.postMessage({ type: "input", text: "late" }), /terminated/);
  let joined = false;
  const joining = adapter.joinTeardown().then(() => { joined = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(joined, false);
  nativeDone.resolve(0); await stopped; await joining;
  assert.equal(adapter.workers.size, 0);
});

test("Node adapter retains thrown/rejected termination results for repeated ownership joins", async () => {
  for (const mode of ["throw", "reject"]) {
    const failure = new Error(`fixture native termination ${mode}`);
    const { adapter, worker } = fixture(() => { if (mode === "throw") throw failure; return Promise.reject(failure); });
    const stopped = worker.terminate();
    await assert.rejects(stopped, error => error === failure);
    assert.equal(adapter.workers.has(worker), true, "Unconfirmed execution ownership cannot vanish");
    assert.equal(worker.terminate(), stopped);
    assert.equal(worker.thread.terminations, 1);
    await assert.rejects(adapter.joinTeardown(), error => error === failure);
    await assert.rejects(adapter.joinTeardown(), error => error === failure);
  }
});

test("Node teardown join still waits for other native owners when one termination fails", async () => {
  const nativeDone = deferred(), failure = new Error("fixture first native termination failed");
  let calls = 0;
  const { adapter, worker } = fixture(() => ++calls === 1 ? Promise.reject(failure) : nativeDone.promise);
  const second = new adapter.Worker("https://terrarium.invalid/runtime/qemu/worker.js", { type: "module" });
  const firstRejected = assert.rejects(worker.terminate(), error => error === failure);
  const secondStopped = second.terminate();
  let settled = false;
  const joining = adapter.joinTeardown().finally(() => { settled = true; });
  const rejected = assert.rejects(joining, error => error === failure);
  await firstRejected; await Promise.resolve();
  assert.equal(settled, false, "One failed owner cannot skip the other owner's pending shutdown");
  nativeDone.resolve(0); await secondStopped; await rejected;
  assert.equal(adapter.workers.size, 1);
  assert.equal(adapter.workers.has(worker), true);
});
