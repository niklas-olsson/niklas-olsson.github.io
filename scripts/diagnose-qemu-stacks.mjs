// SPDX-License-Identifier: Apache-2.0
// Intrusive, bounded stack diagnosis of a real guest. Never an acceptance test.
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { createNodeQemuWorkers } from "./qemu-node-adapter.mjs";
import { loadQemuTestAssets, installQemuTestPthread } from "./qemu-test-assets.mjs";
import { captureNodeWorkerStacks } from "./qemu-thread-stacks.mjs";
import { QemuRuntime } from "../src/lib/qemu-runtime.ts";
import { CommandRunner } from "../src/lib/command-runner.ts";
import { VirtualNetwork } from "../src/lib/network.ts";

assert.equal(process.env.TERRARIUM_QEMU_POLL_EXPERIMENT, "1", "Explicit read-only poll sampling opt-in is required.");
assert.notEqual(process.env.TERRARIUM_QEMU_DIAGNOSTICS, "1", "Keep the per-call I/O observer disabled.");
const started = performance.now();
const emit = (type, data) => console.log(JSON.stringify({ type, elapsedMs: Math.round(performance.now() - started), ...data }));
const native = Object.fromEntries(["fetch", "Worker", "document", "crossOriginIsolated", "isSecureContext", "WebSocket"].map(k => [k, globalThis[k]]));
const { bundle, manifest, pthread, assets } = await loadQemuTestAssets({ fetchAsset: native.fetch });
const temporary = await mkdtemp(join(tmpdir(), "terrarium-stack-experiment-"));
await installQemuTestPthread(temporary, bundle, pthread);
const { Worker, workers, joinTeardown } = createNodeQemuWorkers({ temporary, manifest, bundleId: bundle.id });
const context = vm.createContext({ console, performance, setTimeout, clearTimeout, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Headers, Response, Request, crypto, URL });
vm.runInContext(await readFile(new URL("../public/runtime/libv86.js", import.meta.url), "utf8"), context);
const network = new VirtualNetwork({
  factories: context.TerrariumNetworkAdapters,
  vpcs: [{ id: "stacks", name: "Stack diagnosis", cidr: "10.53.0.0/16", subnets: [{ id: "one", name: "One", cidr: "10.53.1.0/24" }] }],
  fetch: async () => { throw new Error("External access is outside this diagnostic procedure."); },
});
const port = network.createPort("stack-proof", "10.53.1.10", { vpcId: "stacks", subnetId: "one" });
globalThis.Worker = Worker;
globalThis.document = { baseURI: "https://terrarium.invalid/" };
globalThis.crossOriginIsolated = true;
globalThis.isSecureContext = true;
globalThis.fetch = async url => {
  const bytes = assets.get(String(url));
  if (!bytes) throw new Error(`Unexpected request: ${url}`);
  return new Response(Uint8Array.from(bytes));
};
const runtime = new QemuRuntime({ defaultBootBundleId: bundle.id, networkPort: port,
  initScript: "printf 'STACK_INIT_OK\\n' > /tmp/terrarium-stack-proof" });
const runner = new CommandRunner(runtime);
let tail = "", lastOutputAt = performance.now(), rootPromptAt = null, receivedBytes = 0;
let captureRequested = false, sampling = null, failed = false;
const previousThreads = new Map();
const unsubscribeOutput = runtime.onOutput(data => {
  if (!data) return;
  receivedBytes += Buffer.byteLength(data, "utf8"); lastOutputAt = performance.now();
  tail = (tail + data).slice(-32768);
  if (rootPromptAt === null && tail.includes("terrarium:~# ")) {
    rootPromptAt = performance.now(); emit("root-prompt", { receivedBytes });
  }
});
let lastStage;
const unsubscribeStage = runtime.subscribe(state => {
  const key = JSON.stringify([state.status, state.message]);
  if (key === lastStage) return;
  lastStage = key;
  emit("stage", { status: state.status, message: state.message });
});

async function sampleThreads(stage) {
  const at = performance.now();
  try {
    const tasks = (await readdir("/proc/self/task")).filter(x => /^\d+$/.test(x)).slice(0, 128);
    const records = [];
    for (const tid of tasks) {
      try {
        const stat = await readFile(`/proc/self/task/${tid}/stat`, "utf8");
        const end = stat.lastIndexOf(")");
        const fields = stat.slice(end + 2).trim().split(/\s+/);
        const status = await readFile(`/proc/self/task/${tid}/status`, "utf8");
        const switches = Object.fromEntries([...status.matchAll(/^(voluntary_ctxt_switches|nonvoluntary_ctxt_switches):\s+(\d+)/gm)].map(m => [m[1], Number(m[2])]));
        const record = { tid: Number(tid), name: stat.slice(stat.indexOf("(") + 1, end), state: fields[0],
          userTicks: Number(fields[11]), systemTicks: Number(fields[12]), ...switches };
        const previous = previousThreads.get(tid);
        if (previous) record.delta = {
          intervalMs: Math.round(at - previous.at),
          userTicks: record.userTicks - previous.record.userTicks,
          systemTicks: record.systemTicks - previous.record.systemTicks,
          voluntarySwitches: record.voluntary_ctxt_switches - previous.record.voluntary_ctxt_switches,
          involuntarySwitches: record.nonvoluntary_ctxt_switches - previous.record.nonvoluntary_ctxt_switches,
        };
        previousThreads.set(tid, { at, record }); records.push(record);
      } catch (error) { records.push({ tid: Number(tid), unavailable: error.code ?? error.message }); }
    }
    emit("native-thread-sample", { stage, pid: process.pid, records,
      limitation: "Native names, CPU ticks and context switches do not establish QEMU C roles or mutex ownership." });
  } catch (error) { emit("native-thread-sample-unavailable", { stage, error: error.message }); }
}

async function captureOnce(reason) {
  if (captureRequested) return;
  captureRequested = true;
  emit("stack-capture-request", { reason, ownerThreadIds: [...workers].map(w => w.thread.threadId),
    limitation: "Debugger attachment and interruption may change scheduling and release waits. Frames are not a coherent VM snapshot and cannot qualify guest execution." });
  const worker = [...workers][0];
  if (worker) {
    try { emit("poll-before-stack-capture", { observation: await worker.observePollExperiment({ enable: false }) }); }
    catch (error) { emit("poll-before-stack-capture-unavailable", { error: error.message }); }
  }
  // This process creates only the one QEMU owner and its verified pthread pool.
  // The helper records every selected inspector identity; it opens no socket.
  const observation = await captureNodeWorkerStacks({ timeoutMs: 8_000, maxWorkers: 8, maxFrames: 24 });
  emit("worker-stacks", { observation });
}

async function sampleAndMaybeCapture() {
  await sampleThreads(captureRequested ? "after-inspector" : "before-inspector");
  const idleMs = performance.now() - lastOutputAt;
  emit("progress", { status: runtime.getSnapshot().status, receivedBytes,
    noControlOutputMs: Math.round(idleMs), rootPromptObserved: rootPromptAt !== null,
    captureRequested, workerIds: [...workers].map(w => w.id) });
  const threshold = rootPromptAt === null ? 45_000 : 20_000;
  if (!captureRequested && receivedBytes > 0 && idleMs >= threshold)
    await captureOnce(`No control output for ${Math.round(idleMs)} ms; trigger only, not proof of failure.`);
}
const timer = setInterval(() => {
  if (sampling) return;
  sampling = sampleAndMaybeCapture().catch(error => emit("sampling-error", { error: error.message })).finally(() => { sampling = null; });
}, 5_000);
const deadline = setTimeout(() => { console.error("STACK_EXPERIMENT_OVERALL_DEADLINE"); process.exit(1); }, 420_000);

emit("experiment-contract", { runtime: bundle.id, image: bundle.guest, source: process.env.TERRARIUM_TESTED_SOURCE_ID,
  observerEnabled: false, pollInterventionEnabled: false, hostThreadSamplingMs: 5000,
  postPromptInactivityTriggerMs: 20000, prePromptInactivityTriggerMs: 45000, captureBudgetMs: 8000,
  productBootDeadlineMs: 240000, productSetupDeadlineMs: 60000,
  limitation: "Actual Linux in Node. Late internal inspector capture is intrusive diagnostic evidence only; it cannot pass S1-G4 or qualify unchanged-runtime behavior." });
try {
  await runtime.boot();
  emit("guest-ready", { status: runtime.getSnapshot().status, captureRequested });
  for (let index = 0; index < 8; index++) {
    const result = await runner.execute("cat /tmp/terrarium-stack-proof; printf 'STACK_COMMAND_OK\\n'", { timeoutMs: 30_000 });
    emit("guest-command", { index, result });
    assert.equal(result.status, "exited"); assert.equal(result.exitCode, 0);
    assert.equal(result.output, "STACK_INIT_OK\nSTACK_COMMAND_OK\n");
  }
} catch (error) {
  failed = true;
  emit("runtime-failed", { error: error.message, stack: error.stack, tail, captureRequested });
  if (!captureRequested && workers.size) {
    try { await captureOnce("Capture after runtime command failure, before owned teardown."); }
    catch (captureError) { emit("capture-unavailable", { error: captureError.message }); }
  }
} finally {
  clearInterval(timer); clearTimeout(deadline);
  if (sampling) await sampling;
  await sampleThreads("before-teardown");
  unsubscribeOutput(); unsubscribeStage(); runner.dispose();
  try { await runtime.destroy(); }
  catch (error) { failed = true; emit("teardown-failed", { error: error.message }); }
  port.dispose();
  for (const worker of [...workers]) worker.terminate();
  await joinTeardown();
  Object.assign(globalThis, native);
  await rm(temporary, { recursive: true, force: true });
}
emit("S1_STACK_EXPERIMENT_COMPLETE", { outcome: failed ? "runtime-failed" : "guest-responsive", captureRequested,
  ownedWorkersRemaining: workers.size, acceptanceGatePass: false });
process.exit(failed ? 1 : 0);
