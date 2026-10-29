// SPDX-License-Identifier: Apache-2.0
// A bounded causal experiment, never an unchanged-runtime acceptance test.
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { createNodeQemuWorkers } from "./qemu-node-adapter.mjs";
import { loadQemuTestAssets, installQemuTestPthread } from "./qemu-test-assets.mjs";
import { QemuRuntime } from "../src/lib/qemu-runtime.ts";
import { CommandRunner } from "../src/lib/command-runner.ts";
import { VirtualNetwork } from "../src/lib/network.ts";

assert.equal(process.env.TERRARIUM_QEMU_POLL_EXPERIMENT, "1", "Explicit diagnostic experiment opt-in required.");
assert.notEqual(process.env.TERRARIUM_QEMU_DIAGNOSTICS, "1", "The per-call I/O observer must remain disabled for this comparison.");
const started = performance.now();
const emit = (type, data) => console.log(JSON.stringify({ type, elapsedMs: Math.round(performance.now() - started), ...data }));
const native = Object.fromEntries(["fetch", "Worker", "document", "crossOriginIsolated", "isSecureContext", "WebSocket"].map(k => [k, globalThis[k]]));
const { bundle, manifest, pthread, assets } = await loadQemuTestAssets({ fetchAsset: native.fetch });
const temporary = await mkdtemp(join(tmpdir(), "terrarium-poll-experiment-"));
await installQemuTestPthread(temporary, bundle, pthread);
const { Worker, workers, joinTeardown } = createNodeQemuWorkers({ temporary, manifest, bundleId: bundle.id });
const context = vm.createContext({ console, performance, setTimeout, clearTimeout, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Headers, Response, Request, crypto, URL });
vm.runInContext(await readFile(new URL("../public/runtime/libv86.js", import.meta.url), "utf8"), context);
const network = new VirtualNetwork({
  factories: context.TerrariumNetworkAdapters,
  vpcs: [{ id: "poll", name: "Poll diagnosis", cidr: "10.52.0.0/16", subnets: [{ id: "one", name: "One", cidr: "10.52.1.0/24" }] }],
  fetch: async () => { throw new Error("External access is outside this diagnostic procedure."); },
});
const port = network.createPort("poll-proof", "10.52.1.10", { vpcId: "poll", subnetId: "one" });
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
  initScript: "printf 'POLL_INIT_OK\\n' > /tmp/terrarium-poll-proof" });
const runner = new CommandRunner(runtime);
let tail = "", lastOutputAt = performance.now(), rootPromptAt = null, receivedBytes = 0;
let intervention = null, interventionRequested = false, sampling = null, failed = false;
const previousThreads = new Map();
const followupTimers = new Set(), followupTasks = new Set();
function observeLater(worker, delay, enable) {
  const timer = setTimeout(() => {
    followupTimers.delete(timer);
    const task = worker.observePollExperiment({ enable })
      .then(observation => emit("poll-intervention-followup", { delayMs: delay, observation }))
      .catch(error => emit("poll-intervention-followup-unavailable", { delayMs: delay, error: error.message }))
      .finally(() => followupTasks.delete(task));
    followupTasks.add(task);
  }, delay);
  followupTimers.add(timer);
}
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
      limitation: "CPU ticks and context switches only. Native thread names do not establish QEMU C roles; no CPU percentage or mutex ownership is inferred." });
  } catch (error) { emit("native-thread-sample-unavailable", { stage, error: error.message }); }
}

async function sampleAndMaybeIntervene() {
  await sampleThreads(interventionRequested ? "after-intervention" : "before-intervention");
  emit("progress", { status: runtime.getSnapshot().status, receivedBytes,
    noControlOutputMs: Math.round(performance.now() - lastOutputAt), rootPromptObserved: rootPromptAt !== null,
    interventionRequested, workerIds: [...workers].map(w => w.id) });
  if (interventionRequested || rootPromptAt === null || performance.now() - lastOutputAt < 20_000) return;
  const worker = [...workers][0];
  if (!worker) return;
  interventionRequested = true;
  emit("intervention-request", { workerId: worker.id, reason: "At least 20 seconds without control output after the real root prompt; this is an observation trigger, not proof of a specific failure." });
  const before = await worker.observePollExperiment({ enable: false });
  emit("poll-before-intervention", { observation: before });
  intervention = await worker.observePollExperiment({ enable: true });
  emit("poll-intervention-enabled", { observation: intervention });
  observeLater(worker, 5_000, true);
  observeLater(worker, 11_000, false);
}
const timer = setInterval(() => {
  if (sampling) return;
  sampling = sampleAndMaybeIntervene().catch(error => emit("sampling-error", { error: error.message })).finally(() => { sampling = null; });
}, 5_000);
const deadline = setTimeout(() => { console.error("POLL_EXPERIMENT_OVERALL_DEADLINE"); process.exit(1); }, 420_000);

emit("experiment-contract", { runtime: bundle.id, image: bundle.guest, source: process.env.TERRARIUM_TESTED_SOURCE_ID,
  observerEnabled: false, hostThreadSamplingMs: 5000, inactivityTriggerMs: 20000,
  productBootDeadlineMs: 240000, productSetupDeadlineMs: 60000,
  limitation: "A successful run after intervention is diagnostic evidence only; it cannot pass S1-G4 or qualify the unchanged runtime." });
try {
  await runtime.boot();
  emit("guest-ready", { status: runtime.getSnapshot().status, interventionRequested });
  for (let index = 0; index < 3; index++) {
    const result = await runner.execute("cat /tmp/terrarium-poll-proof; printf 'POLL_COMMAND_OK\\n'", { timeoutMs: 30_000 });
    emit("guest-command", { index, result });
    assert.equal(result.status, "exited"); assert.equal(result.exitCode, 0);
    assert.equal(result.output, "POLL_INIT_OK\nPOLL_COMMAND_OK\n");
  }
} catch (error) {
  failed = true;
  emit("runtime-failed", { error: error.message, stack: error.stack, tail, interventionRequested });
} finally {
  clearInterval(timer); clearTimeout(deadline);
  if (sampling) await sampling;
  for (const timer of followupTimers) clearTimeout(timer);
  await Promise.all([...followupTasks]);
  for (const worker of workers) {
    try { emit("poll-final-observation", { observation: await worker.observePollExperiment({ enable: false }) }); }
    catch (error) { emit("poll-final-observation-unavailable", { error: error.message }); }
  }
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
emit("S1_POLL_EXPERIMENT_COMPLETE", { outcome: failed ? "runtime-failed" : "guest-responsive", interventionRequested,
  ownedWorkersRemaining: workers.size, acceptanceGatePass: false });
process.exit(failed ? 1 : 0);
