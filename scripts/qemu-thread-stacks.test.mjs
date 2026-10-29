// SPDX-License-Identifier: Apache-2.0
// Real native Node/Wasm synchronization fixtures, not a QEMU/Linux guest pass.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { url as inspectorUrl } from "node:inspector";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { captureNodeWorkerStacks } from "./qemu-thread-stacks.mjs";

// One function blocks in native memory.atomic.wait32, with exported shared RAM
// so the parent can prove debugger cleanup by waking it after the capture.
const WASM = Uint8Array.from([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,
  5,4,1,3,1,1,7,17,2,4,119,97,105,116,0,0,6,109,101,109,111,114,121,2,0,
  10,14,1,12,0,65,0,65,0,66,127,254,1,2,0,11]);
const wasmHash = createHash("sha256").update(WASM).digest("hex");
function bounded(promise, ms = 3000) {
  let handle;
  return Promise.race([promise, new Promise((_, reject) => { handle = setTimeout(() => reject(new Error("Fixture deadline exceeded")), ms); })])
    .finally(() => clearTimeout(handle));
}
async function blockedPair() {
  const parentBuffer = new SharedArrayBuffer(4);
  const nested = `const {parentPort,threadId}=require('node:worker_threads');
    const instance=new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(${JSON.stringify([...WASM])})));
    parentPort.postMessage({type:'native-wait-ready',threadId,memory:instance.exports.memory.buffer});
    const result=instance.exports.wait(); parentPort.postMessage({type:'native-wait-returned',result});`;
  const source = `const {parentPort,workerData,Worker,threadId}=require('node:worker_threads');
    const child=new Worker(${JSON.stringify(nested)},{eval:true,name:'terrarium-native-wait-fixture'});
    child.on('message',message=>{ parentPort.postMessage({...message,parentThreadId:threadId});
      if(message.type==='native-wait-ready') { Atomics.wait(new Int32Array(workerData),0,0); parentPort.postMessage({type:'parent-wait-returned'}); }
    }); child.on('error',error=>{throw error});`;
  const worker = new Worker(source, { eval: true, workerData: parentBuffer, name: "terrarium-parent-wait-fixture" });
  try {
    const [ready] = await bounded(once(worker, "message"));
    assert.equal(ready.type, "native-wait-ready");
    // Inspector is deliberately not enabled until both workers have entered
    // their native blocking operations, unlike the original early-attach probe.
    await new Promise(resolve => setTimeout(resolve, 50));
    return { worker, ready, parentBuffer };
  } catch (error) { await worker.terminate(); throw error; }
}

test("invalid capture arguments are rejected before opening an inspector session", async () => {
  const before = inspectorUrl(); let getterCalls = 0;
  for (const value of [null, [], { timeoutMs: 499 }, { timeoutMs: Infinity }, { maxWorkers: 9 }, { maxFrames: 0 },
    { allowedWorkerIds: [null] }, { evaluate: "1+1" }, Object.defineProperty({}, "timeoutMs", { get() { getterCalls++; return 8000; } })])
    await assert.rejects(captureNodeWorkerStacks(value));
  assert.equal(getterCalls, 0); assert.equal(inspectorUrl(), before);
});

test("late internal inspection captures existing nested native-Wasm waits, hashes bytecode and resumes both workers", { timeout: 15_000 }, async () => {
  const f = await blockedPair();
  try {
    const report = await captureNodeWorkerStacks({ timeoutMs: 8000, maxFrames: 12 });
    assert.equal(report.schema, "terrarium.node-worker-stacks/v1");
    assert.equal(report.intrusive, true); assert.equal(report.acceptanceGatePass, false);
    assert.equal(report.workers.length, 2); assert.equal(report.completed, true, JSON.stringify(report));
    assert.ok(report.workers.every(worker => worker.status === "captured" && worker.pause.frames.length <= 12));
    const native = report.workers.find(worker => worker.title?.includes("terrarium-native-wait-fixture"));
    assert.ok(native, JSON.stringify(report.discoveredWorkers));
    assert.ok(native.pause.frames.some(frame => frame.functionName?.includes("wasm") || frame.location?.scriptId), JSON.stringify(native));
    assert.ok(native.scripts.some(script => script.bytecode?.sha256 === wasmHash && script.bytecode.bytes === WASM.length), JSON.stringify(native));
    assert.ok(native.scripts.every(script => !Object.hasOwn(script, "scriptSource") && typeof script.bytecode?.bytecode !== "string"));
    assert.equal(report.cleanup.timersRemaining, 0); assert.equal(report.cleanup.domainDisabled, true); assert.equal(report.cleanup.disconnected, true);
    assert.ok(report.workers.every(worker => worker.cleanup.resumeAcknowledged && worker.cleanup.debuggerDisabled));
    assert.equal(report.inspector.opensNetworkListener, false); assert.equal(inspectorUrl(), undefined);
    const messages = [];
    const resumed = new Promise(resolve => f.worker.on("message", message => { messages.push(message); if (messages.some(x => x.type === "parent-wait-returned") && messages.some(x => x.type === "native-wait-returned")) resolve(); }));
    Atomics.store(new Int32Array(f.parentBuffer), 0, 1); Atomics.notify(new Int32Array(f.parentBuffer), 0);
    Atomics.store(new Int32Array(f.ready.memory), 0, 1); Atomics.notify(new Int32Array(f.ready.memory), 0);
    await bounded(resumed);
    assert.equal(messages.find(x => x.type === "native-wait-returned").result, 0);
    console.log("NATIVE_WASM_STACK_CAPTURE", JSON.stringify({ bytes: WASM.length, sha256: wasmHash,
      workers: report.workers.map(worker => ({ workerId: worker.workerId, status: worker.status, scripts: worker.scripts })), durationMs: report.durationMs, cleanup: report.cleanup }));
  } finally { await f.worker.terminate(); }
});

test("idle-worker pause requests remain bounded and cleanup cancels a latent pause", { timeout: 5000 }, async () => {
  const worker = new Worker(`const{parentPort}=require('node:worker_threads'); parentPort.on('message',m=>parentPort.postMessage(m)); parentPort.postMessage('idle-ready');`, { eval: true, name: "terrarium-idle-inspector-fixture" });
  try {
    await bounded(once(worker, "message"));
    const began = performance.now();
    const report = await captureNodeWorkerStacks({ timeoutMs: 600, maxFrames: 3 });
    assert.ok(performance.now() - began < 2000, JSON.stringify(report));
    assert.equal(report.workers.length, 1); assert.equal(report.workers[0].cleanup.resumeAttempted, true);
    assert.equal(report.workers[0].cleanup.debuggerDisabled, true, JSON.stringify(report));
    assert.equal(report.cleanup.domainDisabled, true); assert.equal(report.cleanup.disconnected, true); assert.equal(report.cleanup.timersRemaining, 0);
    const reply = bounded(once(worker, "message")); worker.postMessage("after-cleanup"); assert.deepEqual(await reply, ["after-cleanup"]);
  } finally { await worker.terminate(); }
});

test("an exact allowlist and maxWorkers bound leave other existing blocked workers untargeted", { timeout: 12_000 }, async () => {
  const f = await blockedPair();
  try {
    const discovery = await captureNodeWorkerStacks({ maxWorkers: 1, maxFrames: 2 });
    assert.equal(discovery.workers.length, 1); assert.equal(discovery.discoveredWorkers.length, 2);
    const exactInspectorId = discovery.workers[0].workerId;
    // Inspector IDs are protocol identities, not worker_threads.threadId.
    const report = await captureNodeWorkerStacks({ allowedWorkerIds: [exactInspectorId], maxWorkers: 1, maxFrames: 2 });
    assert.equal(report.workers.length, 1); assert.equal(report.workers[0].workerId, exactInspectorId);
    assert.equal(report.workers[0].pause.frames.length, 2); assert.equal(report.completed, true, JSON.stringify(report));
    assert.ok(report.discoveredWorkers.some(worker => worker.workerId !== exactInspectorId && worker.selected === false));
    assert.equal(report.commands.filter(command => command.method === "Debugger.pause").length, 1);
    assert.equal(report.cleanup.timersRemaining, 0);
  } finally { await f.worker.terminate(); }
});
