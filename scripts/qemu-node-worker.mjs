// SPDX-License-Identifier: Apache-2.0
// Node-only module bindings around the production worker protocol and engine.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { createQemuDispatcher } from "../public/runtime/qemu/dispatch.js";
import { adaptQemuModuleForNode } from "./qemu-node-glue.mjs";
import { createQemuIoObserver, IO_REQUEST, IO_RESPONSE } from "./qemu-io-diagnostics.mjs";
import { createQemuPollDiagnostic, validatePollExperimentRequest, POLL_REQUEST, POLL_RESPONSE } from "./qemu-poll-diagnostic.mjs";

assert.ok(parentPort, "The QEMU Node adapter must run in a worker thread.");
const ioObserver = workerData.ioDiagnostics === true
  ? createQemuIoObserver({ workerId: workerData.id, bundleId: workerData.bundleId }) : null;
const pollDiagnostic = workerData.pollExperiment === true
  ? createQemuPollDiagnostic({ workerId: workerData.id, bundleId: workerData.bundleId }) : null;
let lastPollRequest = 0;
const receive = createQemuDispatcher({
  emit: (message, transfer) => parentPort.postMessage(message, transfer),
  close: () => { pollDiagnostic?.dispose(); parentPort.close(); },
  isIsolated: () => true,
  async loadBundle(bundle) {
    assert.equal(bundle.id, workerData.bundleId, "The Node harness must explicitly identify its runtime bundle.");
    return { manifest: workerData.manifest, pthreadUrl: pathToFileURL(join(workerData.temporary, bundle.pthread.file)) };
  },
  async loadModule(bytes) {
    // Browser workers import the original verified bytes. These two edits only
    // adapt Node's OS enumeration and WebSocket binding inside this test thread.
    const source = adaptQemuModuleForNode(bytes, workerData.bundleId);
    const path = join(workerData.temporary, `runtime-${workerData.id}.mjs`);
    await writeFile(path, source);
    const url = pathToFileURL(path).href;
    const loaded = await import(url);
    return { factory: ioObserver || pollDiagnostic
      ? options => {
        if (ioObserver) ioObserver.install(options);
        if (pollDiagnostic) pollDiagnostic.install(options);
        return loaded.default(options);
      }
      : loaded.default, url };
  },
});
parentPort.on("message", (message) => {
  // This reserved test-only request never enters the production dispatcher.
  if (message?.type === IO_REQUEST) {
    if (!Number.isSafeInteger(message.id) || message.id <= 0) return;
    parentPort.postMessage({ type: IO_RESPONSE, id: message.id,
      ...(ioObserver ? { observation: ioObserver.snapshot() } : { error: "Node I/O diagnostics were not enabled." }),
    });
    return;
  }
  if (message?.type === POLL_REQUEST) {
    if (!Number.isSafeInteger(message.id) || message.id <= 0) return;
    const reply = { type: POLL_RESPONSE, id: message.id, workerId: workerData.id, runtimeBundleId: workerData.bundleId };
    try {
      const enable = validatePollExperimentRequest(message, workerData.id, workerData.bundleId);
      if (!pollDiagnostic) throw new Error("Node poll experiment was not enabled.");
      if (message.id <= lastPollRequest) throw new Error("Node poll experiment request ID was already used.");
      lastPollRequest = message.id;
      parentPort.postMessage({ ...reply, observation: pollDiagnostic.observe({ enable }) });
    } catch (error) { parentPort.postMessage({ ...reply, error: String(error?.message ?? error).slice(0, 1024) }); }
    return;
  }
  if (typeof message?.type === "string" && message.type.startsWith("terrarium-harness:")) return;
  if (message?.type === "destroy") pollDiagnostic?.dispose();
  ioObserver?.received(message);
  void receive(message);
});
