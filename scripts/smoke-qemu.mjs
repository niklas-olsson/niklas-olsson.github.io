// SPDX-License-Identifier: Apache-2.0
// Real x86_64 Linux through the production QemuRuntime, engine and command runner.
// Browser headers/service-worker behavior are not tested by this Node harness.
// Optional: TERRARIUM_QEMU_ASSET_DIR=/path/to/verified/packs
// Optional: TERRARIUM_QEMU_BUNDLE_ID=<registered compatibility ID>
// Optional: TERRARIUM_QEMU_CHECKPOINT_OUT=/path/to/new/fixture.bin
// Run: node --experimental-strip-types scripts/smoke-qemu.mjs
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { createNodeQemuWorkers } from "./qemu-node-adapter.mjs";
import { QemuRuntime } from "../src/lib/qemu-runtime.ts";
import { LEGACY_QEMU_BUNDLE_ID } from "../src/lib/qemu-assets.ts";
import { loadQemuTestAssets, installQemuTestPthread } from "./qemu-test-assets.mjs";
import { CommandRunner } from "../src/lib/command-runner.ts";
import { parseCommandFrame } from "../src/lib/command-protocol.ts";
import { VirtualNetwork } from "../src/lib/network.ts";
import { buildGuestCapabilityProbe, parseGuestCapabilityReport } from "../src/lib/guest-capabilities.ts";
import { isSessionPrompt } from "../src/lib/guest-startup.ts";
import { inspectCheckpoint } from "../src/lib/checkpoint-format.ts";
import { decodeEvidenceBytes } from "../src/lib/evidence.ts";

const native = {
  fetch: globalThis.fetch,
  Worker: globalThis.Worker,
  document: globalThis.document,
  WebSocket: globalThis.WebSocket,
  crossOriginIsolated: globalThis.crossOriginIsolated,
  isSecureContext: globalThis.isSecureContext,
};
const { bundle, manifest, pthread, assets } = await loadQemuTestAssets({ fetchAsset: native.fetch });
const temporary = await mkdtemp(join(tmpdir(), "terrarium-qemu-smoke-"));
await installQemuTestPthread(temporary, bundle, pthread);
const { Worker: RealWorker, workers, joinTeardown: joinWorkerTeardown } = createNodeQemuWorkers({ temporary, manifest, bundleId: bundle.id });
function logMemory(stage) {
  try {
    console.log(`Node memory ${stage} (bytes):`, JSON.stringify(process.memoryUsage()));
  } catch (error) {
    // Managed runners can hide /proc even when the guest runs successfully.
    // A missing host RSS observation must not erase the actual guest results.
    console.log(`Node memory ${stage}: unavailable (${error.code || error.message}).`);
  }
}


const adapterContext = vm.createContext({ console, performance, setTimeout, clearTimeout, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Headers, Response, Request, crypto, URL });
vm.runInContext(await readFile(new URL("../public/runtime/libv86.js", import.meta.url), "utf8"), adapterContext);
assert.ok(adapterContext.TerrariumNetworkAdapters, "Run npm run runtime:prepare first.");
const requests = [];
const network = new VirtualNetwork({
  factories: adapterContext.TerrariumNetworkAdapters,
  vpcs: [{ id: "qemu", name: "x86_64 verification", cidr: "10.44.0.0/16", subnets: [{ id: "nodes", name: "Nodes", cidr: "10.44.7.0/24" }] }],
  fetch: async (url) => {
    assert.equal(String(url), "https://example.com/qemu-smoke");
    requests.push(String(url));
    return new Response("QEMU_PACKET_HTTP_OK\n", { status: 200 });
  },
});
globalThis.Worker = RealWorker;
globalThis.document = { baseURI: "https://terrarium.invalid/" };
globalThis.crossOriginIsolated = true;
globalThis.isSecureContext = true;
globalThis.fetch = async (url) => {
  const bytes = assets.get(String(url));
  if (!bytes) throw new Error(`Unexpected host request: ${url}`);
  return new Response(Uint8Array.from(bytes), { status: 200 });
};

const port = network.createPort("x64-proof", "10.44.7.10", { vpcId: "qemu", subnetId: "nodes" });
port.setMode("world");
port.setCapture(true);
const runtime = new QemuRuntime({ defaultBootBundleId: bundle.id, networkPort: port, initScript: "runs=0\nif [ -f /tmp/terrarium-init-count ]; then read -r runs < /tmp/terrarium-init-count; fi\nprintf '%s\\n' \"$((runs + 1))\" > /tmp/terrarium-init-count\nprintf 'x64-init' > /tmp/terrarium-init-proof\nprintf 'X64_INIT_OK\\n'" });
const runner = new CommandRunner(runtime);
let tail = "";
// Counts re-encoded, decoded ttyS0 text, not raw UART bytes or guest input.
const controlOutput = { receivedUtf8Bytes: 0, lastOutputAt: null };
const serialOutput = ["", "", "", ""];
const serialListeners = new Set();
const unsubscribers = [0, 1, 2, 3].map((serialPort) => runtime.onOutput((data) => {
  serialOutput[serialPort] = (serialOutput[serialPort] + data).slice(-256 * 1024);
  if (serialPort === 0) {
    tail = (tail + data).slice(-16_384);
    controlOutput.receivedUtf8Bytes += Buffer.byteLength(data, "utf8");
    if (data.length) controlOutput.lastOutputAt = new Date().toISOString();
  }
  if (process.env.TERRARIUM_QEMU_VERBOSE === "1") process.stdout.write(`[ttyS${serialPort}] ${data}`);
  for (const check of serialListeners) check();
}, serialPort));
let commandSequence = 0;
for (const method of ["execute", "executeInternal"]) {
  const execute = runner[method];
  runner[method] = async (...args) => {
    const sequence = ++commandSequence;
    const startedAt = new Date().toISOString();
    const startedMonotonic = performance.now();
    const observedWorkers = [...workers];
    const describeWorker = (worker) => ({
      id: worker.id, stopped: worker.stopped, guestInputMessages: worker.guestInputMessages,
    });
    const before = {
      workers: observedWorkers.map(describeWorker), ttyS0: { ...controlOutput },
    };
    const markers = new Map();
    let markerTail = "";
    let markerLimitReached = false;
    let acceptOutput = false;
    const unsubscribe = runtime.onOutput((data) => {
      // Ignore the historical transcript replayed synchronously on subscribe.
      if (!acceptOutput) return;
      const lines = (markerTail + data.replace(/\r/g, "")).split("\n");
      markerTail = lines.pop().slice(-256);
      for (const line of lines) {
        // Exact completed lines cannot mistake an echoed printf for execution.
        const match = /^__TRM_(BEGIN|END)_([a-f0-9]{32})__(?::(-?\d+))?$/.exec(line);
        if (!match || (match[1] === "BEGIN" && match[3] !== undefined)
          || (match[1] === "END" && match[3] === undefined)) continue;
        if (!markers.has(match[2])) {
          if (markers.size >= 32) { markerLimitReached = true; continue; }
          markers.set(match[2], { beginObserved: false, endObserved: false });
        }
        markers.get(match[2])[match[1] === "BEGIN" ? "beginObserved" : "endObserved"] = true;
      }
    });
    console.log("QEMU_COMMAND_START " + JSON.stringify({
      sequence, method, startedAt, commandUtf8Bytes: Buffer.byteLength(args[0], "utf8"),
      requestedTimeoutMs: args[1]?.timeoutMs ?? null, before,
    }));
    acceptOutput = true;
    let result;
    let rejected;
    try {
      result = await execute(...args);
      return result;
    } catch (error) {
      rejected = { name: error.name, message: error.message, stack: error.stack };
      throw error;
    } finally {
      unsubscribe();
      const afterWorkers = [...new Set([...observedWorkers, ...workers])].map(describeWorker);
      const beforeById = new Map(before.workers.map((worker) => [worker.id, worker.guestInputMessages]));
      const observed = result && markers.get(result.id);
      console.log("QEMU_COMMAND_END " + JSON.stringify({
        sequence, method, startedAt, endedAt: new Date().toISOString(),
        observedElapsedMs: Math.round(performance.now() - startedMonotonic),
        before,
        after: { workers: afterWorkers, ttyS0: { ...controlOutput } },
        // These counts prove host posting only, not worker consumption or guest execution.
        postedGuestInputMessages: afterWorkers.map((worker) => ({
          workerId: worker.id, delta: worker.guestInputMessages - (beforeById.get(worker.id) ?? 0),
        })),
        ttyS0ReceivedUtf8Bytes: controlOutput.receivedUtf8Bytes - before.ttyS0.receivedUtf8Bytes,
        beginObserved: observed?.beginObserved ?? (markerLimitReached ? null : false),
        endObserved: observed?.endObserved ?? (markerLimitReached ? null : false),
        markerLimitReached,
        ...(result ? {
          result: result.status !== "exited" || result.exitCode !== 0 ? result : {
            id: result.id, status: result.status, exitCode: result.exitCode,
            startedAt: result.startedAt, durationMs: result.durationMs,
            recovery: result.recovery, message: result.message,
          },
        } : { rejected }),
      }));
    }
  };
}
function waitForSerial(predicate, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      serialListeners.delete(check);
      reject(new Error("Timed out waiting for the real interactive shell."));
    }, timeoutMs);
    const check = () => {
      const result = predicate();
      if (result) { clearTimeout(timeout); serialListeners.delete(check); resolve(result); }
    };
    serialListeners.add(check); check();
  });
}
async function interactive(serialPort, command, timeoutMs = 30_000) {
  const token = randomUUID().replaceAll("-", "");
  const start = serialOutput[serialPort].length;
  const pending = waitForSerial(() => parseCommandFrame(serialOutput[serialPort].slice(start), token), timeoutMs);
  runtime.send(`printf '\\n__TRM_BEGIN_${token}__\\n'; ${command}; _trm_rc=$?; printf '\\n__TRM_END_${token}__:%s\\n' "$_trm_rc"\n`, serialPort);
  const result = await pending;
  await waitForSerial(() => isSessionPrompt(serialOutput[serialPort].slice(-2048), serialPort), timeoutMs);
  return result;
}
const started = performance.now();
let lastStage = "";
unsubscribers.push(runtime.subscribe(() => {
  const state = runtime.getSnapshot();
  const stage = JSON.stringify([state.status, state.message, state.resourceObservation?.observedWasmMemoryBytes]);
  if (stage === lastStage) return;
  lastStage = stage;
  console.log("QEMU_STAGE " + JSON.stringify({
    elapsedMs: Math.round(performance.now() - started), status: state.status,
    message: state.message, resourceObservation: state.resourceObservation ?? null,
  }));
}));
const deadline = setTimeout(() => { console.error("QEMU smoke timed out. Recent guest output:\n" + tail); process.exit(1); }, 900_000);
// Read-only, opt-in observations retain startup evidence before the product's
// unchanged deadline tears a failed worker down. They send no guest input.
let periodicObservation = null;
const observationTimer = process.env.TERRARIUM_QEMU_DIAGNOSTICS === "1" ? setInterval(() => {
  if (periodicObservation) return;
  periodicObservation = (async () => {
    for (const worker of [...workers]) {
      try {
        console.log("QEMU_IO_PROGRESS " + JSON.stringify({
          elapsedMs: Math.round(performance.now() - started), status: runtime.getSnapshot().status,
          observation: await worker.observeIo(),
        }));
      } catch (error) {
        console.log("QEMU_IO_PROGRESS " + JSON.stringify({ workerId: worker.id, error: String(error) }));
      }
    }
  })().finally(() => { periodicObservation = null; });
}, 15_000) : null;
let failed = false;
try {
  await runtime.boot();
  console.log(`Real x86_64 boot and setup completed in ${Math.round(performance.now() - started)} ms.`);
  logMemory("at guest ready");
  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.status, "running", snapshot.message);
  assert.equal(snapshot.controlReady, true);
  assert.equal(snapshot.init.status, "succeeded", snapshot.init.output);
  assert.equal(snapshot.init.output, "X64_INIT_OK\n");
  assert.equal(snapshot.guestCapabilities?.architecture, "x86_64", snapshot.guestCapabilityError);
  assert.equal(snapshot.guestCapabilities?.kernelRelease, bundle.guest.kernel);
  assert.equal(snapshot.runtimeBundle?.defaultBootBundleId, bundle.id);
  assert.equal(snapshot.runtimeBundle?.activeBundleId, bundle.id);
  assert.equal(snapshot.guestCapabilities?.kubernetesExecution, "not-verified");
  assert.equal(snapshot.resourceObservation?.source, "emulator-memory-buffer");
  assert.equal(snapshot.resourceObservation.observedWasmMemoryBytes, 2300 * 1024 * 1024);
  assert.equal(snapshot.resourceObservation.configuredGuestMemoryMiB, 512);
  console.log("Observed emulator linear memory (not process RSS):", JSON.stringify(snapshot.resourceObservation));
  console.log("Observed guest capabilities:", JSON.stringify(snapshot.guestCapabilities));

  const controlTty = await runner.execute("stty -F /dev/ttyS0 -a");
  assert.equal(controlTty.exitCode, 0, controlTty.output);
  assert.match(controlTty.output, /(?:^|\s)-ixon(?:\s|;|$)/);
  assert.match(controlTty.output, /(?:^|\s)-ixoff(?:\s|;|$)/);
  console.log("PASS: framed commands preserve disabled control-console software flow control.");

  const identity = await runner.execute("uname -m; uname -r; cat /etc/alpine-release; cat /tmp/terrarium-init-proof", { timeoutMs: 30_000 });
  assert.equal(identity.exitCode, 0, identity.output);
  assert.ok(identity.output.includes(`x86_64\n${bundle.guest.kernel}\n${bundle.guest.userland.replace(/^Alpine Linux /, "")}\nx64-init`), identity.output);
  assert.equal((await runner.execute("cat /tmp/terrarium-init-count")).output, "1\n", "Init script must run exactly once per boot");
  assert.equal((await runner.execute("exit 7")).exitCode, 7);
  const timedOut = await runner.execute("printf 'X64_TIMEOUT_STARTED\\n'; sleep 30", { timeoutMs: 3_000 });
  assert.match(timedOut.output, /X64_TIMEOUT_STARTED/);
  assert.equal(timedOut.status, "timed_out", JSON.stringify(timedOut));
  assert.equal(timedOut.exitCode, null);
  assert.equal(timedOut.recovery, "recovered", JSON.stringify(timedOut));
  assert.equal((await runner.execute("printf 'X64_AFTER_TIMEOUT\\n'")).output, "X64_AFTER_TIMEOUT\n");
  const recoveredTty = await runner.execute("stty -F /dev/ttyS0 -a");
  assert.equal(recoveredTty.exitCode, 0, recoveredTty.output);
  assert.match(recoveredTty.output, /(?:^|\s)-ixon(?:\s|;|$)/);
  assert.match(recoveredTty.output, /(?:^|\s)-ixoff(?:\s|;|$)/);
  console.log("PASS: a running guest command times out, acknowledges recovery, accepts the next command and preserves disabled software flow control.");
  const kernelMessage = "TRM_KERNEL_LOG_" + randomUUID().replaceAll("-", "");
  const kernelLogging = await runner.execute([
    "set -e",
    "_trm_level=$(cat /proc/sys/kernel/printk)",
    '_trm_level=${_trm_level%%[[:space:]]*}',
    '[ "$_trm_level" = 0 ]',
    `printf '<4>${kernelMessage}\\n' > /dev/kmsg`,
    "printf 'command-output-only'",
  ].join("\n"));
  assert.equal(kernelLogging.exitCode, 0, JSON.stringify(kernelLogging));
  assert.equal(kernelLogging.output, "command-output-only", "Kernel messages must not contaminate ordinary command stdout.");
  const retainedKernelLog = await runner.execute(`dmesg | grep -F '${kernelMessage}'`);
  assert.equal(retainedKernelLog.exitCode, 0, JSON.stringify(retainedKernelLog));
  assert.match(retainedKernelLog.output, new RegExp(kernelMessage));
  console.log("PASS: an actual injected kernel warning stays in dmesg and does not enter framed command stdout.");
  const text = "λ雪🙂".repeat(40);
  const unicode = await runner.execute(`printf '%s' '${text}' > /tmp/terrarium-unicode; cat /tmp/terrarium-unicode`);
  assert.equal(unicode.exitCode, 0, unicode.output);
  assert.equal(unicode.output, text);
  const probe = await runner.execute(buildGuestCapabilityProbe("real_x64_again"), { timeoutMs: 30_000 });
  assert.equal(probe.exitCode, 0, JSON.stringify(probe));
  assert.equal(parseGuestCapabilityReport(probe.output, "real_x64_again").architecture, "x86_64");
  const legacyBootGuard = bundle.id === LEGACY_QEMU_BUNDLE_ID ? "grep '^# Terrarium unused build boot partition:' /etc/fstab || exit 14; " : "";
  const demoCleanup = await runner.execute("cat /root/.profile; for service in /etc/runlevels/*/setup-wasm-networking; do test ! -L \"$service\" || exit 13; done; " + legacyBootGuard + "env | grep -E '^(http_proxy|https_proxy|HTTP_PROXY|HTTPS_PROXY|SSL_CERT_FILE)=' || true");
  assert.equal(demoCleanup.exitCode, 0, demoCleanup.output);
  assert.match(demoCleanup.output, /export TERM=xterm-256color/);
  if (bundle.id === LEGACY_QEMU_BUNDLE_ID) assert.match(demoCleanup.output, /# Terrarium unused build boot partition: UUID=37dd7022/);
  assert.doesNotMatch(demoCleanup.output, /192\.168\.127\.253|SSL_CERT_FILE=/);
  console.log("PASS: production command runner, init output, actual exit codes, Unicode/file writes, capability framing and demo cleanup.");

  assert.deepEqual(snapshot.sessions.map((session) => [session.port, session.status]), [[1, "ready"], [2, "ready"], [3, "ready"]]);
  const shellPids = [];
  for (const serialPort of [1, 2, 3]) {
    const shell = await interactive(serialPort, 'printf "%s\\n" "$$"; tty; set -o | grep monitor');
    assert.equal(shell.exitCode, 0, shell.output);
    assert.match(shell.output, new RegExp(`/dev/ttyS${serialPort}`));
    assert.match(shell.output, /monitor\s+on/);
    shellPids.push(shell.output.split("\n")[0]);
  }
  assert.equal(new Set(shellPids).size, 3);
  await interactive(1, "export TRM_SESSION=one; cd /tmp");
  assert.deepEqual(await interactive(1, 'printf "%s:" "$TRM_SESSION"; pwd'), { output: "one:/tmp\n", exitCode: 0 });
  assert.deepEqual(await interactive(2, 'printf "%s:" "${TRM_SESSION-unset}"; pwd'), { output: "unset:/root\n", exitCode: 0 });
  assert.equal((await runner.execute("stty -F /dev/ttyS2 rows 31 cols 96")).exitCode, 0);
  assert.deepEqual(await interactive(2, "stty size"), { output: "31 96\n", exitCode: 0 });

  const jobStart = serialOutput[1].length;
  runtime.send("/bin/sh -c 'sleep 20'\n", 1);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(await interactive(2, "printf other-shell"), { output: "other-shell", exitCode: 0 });
  assert.equal((await runner.execute("printf control-channel")).output, "control-channel");
  runtime.send("\x1a", 1);
  await waitForSerial(() => /Stopped/.test(serialOutput[1].slice(jobStart)) && isSessionPrompt(serialOutput[1].slice(-2048), 1));
  assert.match((await interactive(1, "jobs")).output, /Stopped/);
  runtime.send("fg\n", 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const interruptStart = serialOutput[1].length;
  runtime.send("\x03", 1);
  await waitForSerial(() => serialOutput[1].slice(interruptStart).includes("shell-1> "));

  assert.equal((await runner.execute("stty -F /dev/ttyS3 rows 29 cols 91 && printf '29 91\\n' > /run/terrarium/ttyS3.size")).exitCode, 0);
  const beforeExit = (await interactive(3, 'printf "%s" "$$"')).output;
  const exitStart = serialOutput[3].length;
  runtime.send("exit\n", 3);
  await waitForSerial(() => serialOutput[3].slice(exitStart).includes("shell-3> "));
  assert.notEqual((await interactive(3, 'printf "%s" "$$"')).output, beforeExit);
  assert.deepEqual(await interactive(3, "stty size"), { output: "29 91\n", exitCode: 0 });
  console.log("PASS: three real controlling terminals, independent shell state, concurrent control, resize, job control and shell respawn.");

  const dns = await runner.execute("nslookup example.com", { timeoutMs: 30_000 });
  assert.equal(dns.exitCode, 0, dns.output);
  const web = await runner.execute("wget -T 10 -qO- http://example.com/qemu-smoke", { timeoutMs: 30_000 });
  assert.equal(web.exitCode, 0, web.output);
  assert.equal(web.output, "QEMU_PACKET_HTTP_OK\n");
  assert.equal(requests.length, 1);
  assert.ok(port.getSnapshot().capture.packets > 0);
  port.setMode("isolated");
  const isolated = await runner.execute("wget -T 2 -qO- http://example.com/qemu-smoke", { timeoutMs: 15_000 });
  assert.notEqual(isolated.exitCode, 0);
  assert.equal(requests.length, 1, "Isolated networking cannot reach the host HTTP fixture");
  console.log("PASS: actual VirtIO Ethernet, DNS and HTTP packets through the production network, capture and isolation gates.");

  await runtime.pause();
  assert.equal(runtime.getSnapshot().status, "paused");
  const resourceWorkers = [...workers].map(worker => ({ worker, input: worker.guestInputMessages, resume: worker.resumeRequests }));
  const resourceStarted = performance.now();
  const translationResources = await runtime.inspectResources();
  assert.equal(translationResources.source, "qemu-hmp-info-jit");
  assert.equal(translationResources.runtimeBundleId, bundle.id);
  assert.equal(translationResources.cpuState, "paused");
  assert.equal(translationResources.configuredTranslationCacheMiB, 500);
  assert.ok(translationResources.translationStats.generatedCodeUsedBytes > 0);
  assert.ok(translationResources.translationStats.generatedCodeCapacityBytes <= 500 * 1024 * 1024);
  assert.ok(translationResources.translationStats.translationBlockCount > 0);
  assert.equal(runtime.getSnapshot().status, "paused");
  for (const { worker, input, resume } of resourceWorkers) {
    assert.equal(worker.guestInputMessages, input, "Paused resource inspection must not send guest input.");
    assert.equal(worker.resumeRequests, resume, "Paused resource inspection must not resume the CPU.");
  }
  console.log("QEMU_TRANSLATION_RESOURCES " + JSON.stringify({
    queryDurationMs: Math.round(performance.now() - resourceStarted), observation: translationResources,
  }));
  logMemory("during acknowledged pause after translation-buffer observation");
  await assert.rejects(runner.execute("true"), /ready|paused|Boot/i);
  await runtime.resume();
  assert.equal(runtime.getSnapshot().status, "running");
  assert.equal((await runner.execute("cat /tmp/terrarium-unicode")).output, text);
  assert.equal((await runner.execute("cat /tmp/terrarium-init-count")).output, "1\n", "Resume must preserve the guest without rerunning init");
  const checkpointPids = [];
  for (const serialPort of [1, 2, 3]) checkpointPids.push((await interactive(serialPort, 'printf "%s" "$$"')).output);
  assert.equal((await runner.execute("printf 'saved-state' > /tmp/terrarium-checkpoint-proof")).exitCode, 0);
  assert.equal((await runner.execute("printf '\\000\\001\\377' > /tmp/terrarium-binary-proof")).exitCode, 0);
  const checkpoint = await runtime.save();
  assert.equal(runtime.getSnapshot().status, "running", "Saving a running machine must restore its prior execution state");
  const checkpointDigest = createHash("sha256").update(new Uint8Array(checkpoint)).digest("hex");
  const inspection = await inspectCheckpoint(checkpoint);
  assert.equal(inspection.kind, "qemu-checkpoint");
  assert.equal(inspection.runtimeVersion, bundle.id);
  assert.equal(inspection.cpuSource, "captured-monitor");
  assert.notEqual(inspection.cpu.instructionPointer, null);
  assert.equal(inspection.sha256, checkpointDigest);
  if (process.env.TERRARIUM_QEMU_CHECKPOINT_OUT) {
    await mkdir(dirname(process.env.TERRARIUM_QEMU_CHECKPOINT_OUT), { recursive: true });
    await writeFile(process.env.TERRARIUM_QEMU_CHECKPOINT_OUT, new Uint8Array(checkpoint), { flag: "wx" });
    console.log("QEMU_CHECKPOINT_FIXTURE " + JSON.stringify({ path: process.env.TERRARIUM_QEMU_CHECKPOINT_OUT, runtimeBundleId: bundle.id, bytes: checkpoint.byteLength, sha256: checkpointDigest }));
  }
  console.log(`PASS: real checkpoint capture (${checkpoint.byteLength} bytes), SHA-256 and paused monitor register observation.`);
  assert.equal((await runner.execute("printf 'changed-after-save' > /tmp/terrarium-checkpoint-proof")).exitCode, 0);
  await interactive(1, "export TRM_SESSION=changed; cd /");
  await runtime.destroy();
  await joinWorkerTeardown();
  assert.equal(workers.size, 0);

  port.quarantine("Checkpoint investigation verification");
  assert.throws(() => port.setMode("world"), /quarantin/i);
  runtime.setInitScript("printf 'unexpected' > /tmp/terrarium-unexpected-init");
  await runtime.restore(checkpoint, { paused: true });
  const restoredWorker = [...workers][0];
  assert.ok(restoredWorker);
  assert.equal(runtime.getSnapshot().status, "paused");
  assert.equal(runtime.getSnapshot().runtimeBundle?.activeBundleId, bundle.id);
  assert.equal(runtime.getSnapshot().runtimeBundle?.activeBundleId, bundle.id);
  assert.equal(runtime.getSnapshot().passiveRestore, true);
  assert.equal(runtime.getSnapshot().init.status, "skipped");
  assert.equal(restoredWorker.guestInputMessages, 0, "Paused restore must not send guest commands or terminal input");
  assert.equal(restoredWorker.resumeRequests, 0, "Paused restore must not continue the CPU");
  await assert.rejects(runner.execute("true"), /ready|paused|Boot/i);
  await runtime.resume();
  assert.equal((await runner.execute("cat /tmp/terrarium-checkpoint-proof")).output, "saved-state");
  assert.equal((await runner.execute("cat /tmp/terrarium-init-count; test ! -e /tmp/terrarium-unexpected-init")).output, "1\n");
  assert.equal((await runner.execute("test ! -e /tmp/terrarium-unexpected-init")).exitCode, 0);
  assert.deepEqual(await interactive(1, 'printf "%s:" "$TRM_SESSION"; pwd'), { output: "one:/tmp\n", exitCode: 0 });
  assert.deepEqual(await interactive(2, "stty size"), { output: "31 96\n", exitCode: 0 });
  assert.deepEqual(await interactive(3, "stty size"), { output: "29 91\n", exitCode: 0 });
  const restoredPids = [];
  for (const serialPort of [1, 2, 3]) restoredPids.push((await interactive(serialPort, 'printf "%s" "$$"')).output);
  assert.deepEqual(restoredPids, checkpointPids, "Checkpoint restore must preserve the actual independent shell processes");
  assert.equal(createHash("sha256").update(new Uint8Array(checkpoint)).digest("hex"), checkpointDigest, "Source checkpoint bytes must remain unchanged");
  console.log("PASS: cold paused checkpoint restore, zero startup input, explicit resume, preserved files/shell state/PIDs and skipped init.");
  const evidence = await runtime.captureEvidence([
    "/tmp/terrarium-checkpoint-proof", "/tmp/terrarium-unicode", "/tmp/terrarium-binary-proof",
  ], (command) => runner.executeInternal(command, { timeoutMs: 30_000 }), {
    title: "Quarantined x86_64 logical capture", machineId: "x64-proof", checkpointSha256: checkpointDigest,
  });
  assert.equal(evidence.source.checkpointSha256, checkpointDigest);
  const evidenceFiles = new Map(evidence.files.map((file) => [file.path, decodeEvidenceBytes(file)]));
  assert.equal(new TextDecoder().decode(evidenceFiles.get("/tmp/terrarium-checkpoint-proof")), "saved-state");
  assert.equal(new TextDecoder().decode(evidenceFiles.get("/tmp/terrarium-unicode")), text);
  assert.deepEqual(evidenceFiles.get("/tmp/terrarium-binary-proof"), new Uint8Array([0, 1, 255]));
  assert.equal(port.getSnapshot().quarantined, true);
  assert.equal(requests.length, 1);
  assert.equal(createHash("sha256").update(new Uint8Array(checkpoint)).digest("hex"), checkpointDigest);
  console.log("PASS: host-quarantined guest-assisted file capture, exact Unicode/binary bytes and preserved checkpoint provenance.");
  await runtime.destroy();
  assert.equal(runtime.getSnapshot().status, "idle");
  assert.equal(workers.size, 0);
  await joinWorkerTeardown();
  console.log("PASS: private monitor pause/resume, preserved live state and owned worker teardown.");
  logMemory("after guest teardown");
} catch (error) {
  failed = true;
  console.error("Recent guest output:\n" + tail);
  console.error(error);
  if (process.env.TERRARIUM_QEMU_DIAGNOSTICS === "1") {
    for (const worker of workers) {
      try {
        console.error("QEMU_IO_DIAGNOSIS " + JSON.stringify({ workerId: worker.id, observation: await worker.observeIo() }));
      } catch (diagnosticError) {
        console.error("QEMU_IO_DIAGNOSIS " + JSON.stringify({ workerId: worker.id, error: String(diagnosticError) }));
      }
    }
  }
  if (runtime.getSnapshot().status === "running") {
    if (process.env.TERRARIUM_QEMU_DIAGNOSTICS === "1"
      && runtime.getSnapshot().sessions?.some(session => session.port === 1 && session.status === "ready")) {
      const diagnosticCommand = "printf 'CONTROL_TTY\\n'; stty -F /dev/ttyS0 -a; printf 'SERIAL_DRIVER\\n'; cat /proc/tty/driver/serial; printf 'INTERRUPTS\\n'; cat /proc/interrupts; printf 'UPTIME\\n'; cat /proc/uptime; printf 'PROCESSES\\n'; ps";
      try {
        // A diagnostic after an already failed test, never a recovery retry.
        // Bound both its command-frame and subsequent prompt waits to 5 seconds.
        const result = await interactive(1, diagnosticCommand, 5_000);
        console.error("QEMU_TTY_DIAGNOSIS " + JSON.stringify({ command: diagnosticCommand, result }));
      } catch (error) {
        console.error("QEMU_TTY_DIAGNOSIS " + JSON.stringify({ command: diagnosticCommand, error: String(error), tail: serialOutput[1].slice(-8192) }));
      }
    }
    try {
      // This changes an already failed run only. A bounded private monitor
      // observation distinguishes a responsive reactor from a guest/input stall;
      // it can never turn the missing command completion into a parity pass.
      await runtime.pause();
      const observed = await runtime.control("inspect-registers");
      console.error("QEMU_FAILURE_DIAGNOSIS " + JSON.stringify({
        paused: runtime.getSnapshot().status === "paused",
        registers: observed.registers,
        workers: [...workers].map((worker) => ({ id: worker.id, guestInputMessages: worker.guestInputMessages })),
      }));
      console.error("QEMU_FAILURE_RESOURCE_OBSERVATION " + JSON.stringify(await runtime.inspectResources()));
    } catch (diagnosticError) {
      console.error("QEMU_FAILURE_DIAGNOSIS " + JSON.stringify({ error: String(diagnosticError) }));
    }
  }
} finally {
  if (observationTimer !== null) clearInterval(observationTimer);
  if (periodicObservation) await periodicObservation;
  clearTimeout(deadline);
  for (const unsubscribe of unsubscribers) unsubscribe();
  runner.dispose();
  await runtime.destroy(); port.dispose();
  for (const worker of [...workers]) worker.terminate();
  await joinWorkerTeardown();
  Object.assign(globalThis, native);
  await rm(temporary, { recursive: true, force: true });
}
if (!failed) console.log("PASS: complete x86_64 parity and restored-checkpoint investigation, including owned teardown.");
process.exit(failed ? 1 : 0);
