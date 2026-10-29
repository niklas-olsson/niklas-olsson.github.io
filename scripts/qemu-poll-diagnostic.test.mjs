// SPDX-License-Identifier: Apache-2.0
// Fixtures only: no guest, Wasm execution, worker thread or real blocking wait.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { createQemuPollDiagnostic, pollExperimentEnable, validatePollExperimentRequest,
  POLL_REQUEST, POLL_RESPONSE, POLL_POLICY } from "./qemu-poll-diagnostic.mjs";
import { IO_REQUEST, IO_RESPONSE } from "./qemu-io-diagnostics.mjs";
import { LEGACY_QEMU_BUNDLE_ID } from "../public/runtime/qemu/catalog.js";
import { getQemuBundle } from "../public/runtime/qemu/bundles.js";

function fixture() {
  let time = 0, mask = 4, failure = null, waitFailure = null, initialized = 0, ioCalls = 0;
  const timers = new Map(), calls = [], waits = [];
  const stream = { fd: 0, flags: 34816 };
  const operations = { poll(...args) {
    assert.equal(this, operations); calls.push(args);
    if (failure) throw failure;
    return mask;
  } };
  stream.stream_ops = operations;
  const original = operations.poll;
  const pty = { get readable() { return mask === 5; }, read() { ioCalls++; }, write() { ioCalls++; } };
  const module = { FS: { getStream(fd) { assert.equal(fd, 0); return stream; } }, TTY: { stream_ops: operations } };
  const diagnostic = createQemuPollDiagnostic({ workerId: 3, bundleId: "fixture-runtime" }, {
    now: () => 1_700_000_000_000 + time, monotonic: () => time,
    wait(...args) { waits.push(args); if (waitFailure) throw waitFailure; time += 1.25; return "timed-out"; },
    schedule(callback, ms) { const token = {}; timers.set(token, { callback, ms }); return token; },
    unschedule(token) { timers.delete(token); },
  });
  const options = { pty, onRuntimeInitialized(...args) {
    assert.equal(this, module); assert.deepEqual(args, ["original-argument"]); initialized++;
    return "original-result";
  } };
  return { diagnostic, operations, stream, original, options, module, timers, calls, waits,
    initialize() { assert.equal(diagnostic.install(options), options); assert.equal(options.onRuntimeInitialized.call(module, "original-argument"), "original-result"); },
    mask(value) { mask = value; }, fail(value) { failure = value; }, waitFail(value) { waitFailure = value; },
    advance(value) { time += value; }, initialized: () => initialized, ioCalls: () => ioCalls,
  };
}

test("the experiment captures initialization without wrapping TTY until explicitly enabled", () => {
  const f = fixture();
  assert.throws(() => f.diagnostic.observe({ enable: false }), /not initialized/);
  f.initialize(); assert.equal(f.initialized(), 1); assert.equal(f.operations.poll, f.original);
  for (let i = 0; i < 32; i++) assert.equal(f.operations.poll(f.stream, -1), 4);
  assert.equal(f.waits.length, 0); assert.equal(f.timers.size, 0);
  const observation = f.diagnostic.observe({ enable: false });
  assert.equal(f.operations.poll, f.original); assert.equal(observation.observedPollCalls, 0);
  assert.equal(observation.readiness.mask, 4); assert.equal(observation.readiness.ptyReadable, false);
  assert.equal(observation.everEnabled, false); assert.equal(observation.causalIntervention, false);
  assert.equal(f.calls.length, 33, "Taking the sample invokes the real operation once");
  assert.deepEqual(f.calls.at(-1), [f.stream, -1]); assert.equal(f.ioCalls(), 0);
  assert.throws(() => f.diagnostic.install(f.options), /once/);
  f.diagnostic.dispose(); assert.equal(f.operations.poll, f.original);
});

test("only every sixteenth empty fd0 poll waits, preserving receiver, arguments and masks", () => {
  const f = fixture(); f.initialize();
  const before = f.diagnostic.observe({ enable: true });
  assert.equal(before.enabled, true); assert.equal(before.waits, 0);
  assert.notEqual(f.operations.poll, f.original); assert.equal([...f.timers.values()][0].ms, 10_000);
  for (let i = 0; i < 15; i++) assert.equal(f.operations.poll(f.stream, -1, "extra"), 4);
  assert.equal(f.waits.length, 0);
  assert.equal(f.operations.poll(f.stream, -1, "extra"), 4); assert.equal(f.waits.length, 1);
  assert.deepEqual(f.calls.at(-1), [f.stream, -1, "extra"]);
  const [word, index, expected, duration] = f.waits[0];
  assert.equal(word.buffer.byteLength, 4); assert.ok(word.buffer instanceof SharedArrayBuffer);
  assert.equal(index, 0); assert.equal(expected, 0); assert.equal(duration, 1);
  f.mask(5); for (let i = 0; i < 16; i++) assert.equal(f.operations.poll(f.stream, -1), 5);
  f.mask(16); assert.equal(f.operations.poll(f.stream, -1), 16);
  f.mask(4); for (let i = 0; i < 16; i++) assert.equal(f.operations.poll({ fd: 1 }, -1), 4);
  let getterCalls = 0;
  const unknown = Object.defineProperty({}, "fd", { get() { getterCalls++; return 0; } });
  assert.equal(f.operations.poll(unknown, -1), 4); assert.equal(getterCalls, 0);
  assert.equal(f.waits.length, 1);
  const after = f.diagnostic.observe({ enable: false });
  assert.equal(after.waits, 1); assert.equal(after.eligibleEmptyFd0Polls, 16);
  assert.equal(after.observedWaitTotalMs, 1.25); assert.equal(after.requestedWaitTotalMs, 1);
  assert.equal(after.restoredOriginal, true); assert.equal(after.disableReason, "disabled-by-request");
  assert.equal(f.operations.poll, f.original); assert.equal(f.timers.size, 0); assert.equal(f.ioCalls(), 0);
  after.waits = 99; assert.equal(f.diagnostic.observe({ enable: false }).waits, 1);
});

test("original exceptions remain exact, and a diagnostic wait failure restores the production operation", () => {
  const f = fixture(); f.initialize(); f.diagnostic.observe({ enable: true });
  for (const errno of [6, 1006]) {
    const error = Object.assign(new Error("original failure"), { errno }); f.fail(error);
    assert.throws(() => f.operations.poll(f.stream, -1), value => value === error);
  }
  f.fail(null); f.waitFail(new Error("wait unavailable"));
  for (let i = 0; i < 16; i++) assert.equal(f.operations.poll(f.stream, -1), 4);
  assert.equal(f.operations.poll, f.original);
  const after = f.diagnostic.observe({ enable: false });
  assert.equal(after.originalErrors, 2); assert.equal(after.lastOriginalError.errno, 1006);
  assert.equal(after.waits, 1); assert.equal(after.disableReason, "wait-failed");
  assert.match(after.diagnosticError.message, /unavailable/); assert.equal(after.enabled, false);
});

test("the one-shot intervention obeys lifetime wait and time limits without resetting them", () => {
  const count = fixture(); count.initialize(); count.diagnostic.observe({ enable: true });
  for (let i = 0; i < 8; i++) count.operations.poll(count.stream, -1);
  count.diagnostic.observe({ enable: true });
  for (let i = 8; i < 16_000; i++) count.operations.poll(count.stream, -1);
  const stopped = count.diagnostic.observe({ enable: false });
  assert.equal(stopped.waits, 1_000); assert.equal(stopped.requestedWaitTotalMs, 1_000);
  assert.equal(stopped.observedPollCalls, 16_000); assert.equal(stopped.disableReason, "wait-count-limit");
  assert.equal(count.operations.poll, count.original); assert.equal(count.timers.size, 0);
  assert.throws(() => count.diagnostic.observe({ enable: true }), /already used/);

  const timed = fixture(); timed.initialize(); timed.diagnostic.observe({ enable: true });
  timed.advance(10_000);
  for (let i = 0; i < 16; i++) timed.operations.poll(timed.stream, -1);
  assert.equal(timed.waits.length, 0); assert.equal(timed.operations.poll, timed.original);
  assert.equal(timed.diagnostic.observe({ enable: false }).disableReason, "duration-limit");

  const idle = fixture(); idle.initialize(); idle.diagnostic.observe({ enable: true });
  [...idle.timers.values()][0].callback();
  assert.equal(idle.operations.poll, idle.original); assert.equal(idle.timers.size, 0);
  assert.equal(idle.diagnostic.observe({ enable: false }).disableReason, "duration-limit");
});

test("cleanup restores only its own function and requests cannot supply timing or code settings", () => {
  const f = fixture(); f.initialize(); f.diagnostic.observe({ enable: true });
  const savedWrapper = f.operations.poll;
  f.diagnostic.dispose(); assert.equal(f.operations.poll, f.original); assert.equal(f.timers.size, 0);
  assert.equal(savedWrapper.call(f.operations, f.stream, -1), 4, "A stale wrapper keeps the captured original semantics without sleeping");
  assert.throws(() => f.diagnostic.observe({ enable: false }), /disposed/);

  const changed = fixture(); changed.initialize(); changed.diagnostic.observe({ enable: true });
  const unrelated = () => 5; changed.operations.poll = unrelated; changed.diagnostic.dispose();
  assert.equal(changed.operations.poll, unrelated, "Cleanup cannot overwrite a different owner");
  let getters = 0;
  for (const value of [null, {}, [], { enable: 1 }, { enable: true, delay: 1000 },
    Object.assign(Object.create({}), { enable: true }),
    Object.defineProperty({}, "enable", { get() { getters++; return true; } }),
    { enable: true, [Symbol("hidden")]: 1 }]) assert.throws(() => pollExperimentEnable(value));
  assert.equal(getters, 0); assert.equal(pollExperimentEnable({ enable: true }), true);
  assert.equal(pollExperimentEnable(Object.assign(Object.create(null), { enable: false })), false);
  const request = { type: POLL_REQUEST, id: 1, workerId: 3, runtimeBundleId: "fixture-runtime", enable: true };
  assert.equal(validatePollExperimentRequest(request, 3, "fixture-runtime"), true);
  for (const change of [{ workerId: 4 }, { runtimeBundleId: "other" }, { id: 0 }, { id: 1.1 }, { enable: "true" }, { delay: 1 }])
    assert.throws(() => validatePollExperimentRequest({ ...request, ...change }, 3, "fixture-runtime"), /Invalid/);
  assert.ok(Object.isFrozen(POLL_POLICY));
});

const adapterSource = await readFile(new URL("./qemu-node-adapter.mjs", import.meta.url), "utf8");
function adapterFixture(enabled = true) {
  const timers = new Map();
  class FixtureThread extends EventEmitter {
    messages = [];
    constructor(url, options) { super(); this.url = url; this.options = options; }
    postMessage(message) { this.messages.push(message); }
    async terminate() { return 0; }
  }
  const declaration = adapterSource.slice(adapterSource.indexOf("export function createNodeQemuWorkers"))
    .replace(/^export /, "").replace("import.meta.url", JSON.stringify(new URL("./qemu-node-adapter.mjs", import.meta.url).href));
  const create = vm.runInNewContext(`(() => { ${declaration}; return createNodeQemuWorkers; })()`, {
    assert, NodeWorker: FixtureThread, URL, getQemuBundle, LEGACY_QEMU_BUNDLE_ID,
    IO_REQUEST, IO_RESPONSE, POLL_REQUEST, POLL_RESPONSE, pollExperimentEnable,
    process: { env: enabled ? { TERRARIUM_QEMU_POLL_EXPERIMENT: "1" } : {} },
    setTimeout(callback, ms) { const token = {}; timers.set(token, { callback, ms }); return token; },
    clearTimeout(token) { timers.delete(token); }, console,
  });
  const adapter = create({ temporary: "/unused-fixture", manifest: {}, bundleId: LEGACY_QEMU_BUNDLE_ID });
  return { adapter, worker: new adapter.Worker("https://terrarium.invalid/runtime/qemu/worker.js", { type: "module" }), timers };
}

test("the real adapter requires opt-in and exact observation identities without forwarding harness traffic", async () => {
  const disabled = adapterFixture(false);
  await assert.rejects(disabled.worker.observePollExperiment({ enable: true }), /POLL_EXPERIMENT=1/);
  assert.equal(disabled.worker.thread.options.workerData.pollExperiment, false);
  assert.equal(disabled.worker.thread.messages.length, 0);
  disabled.worker.terminate(); await disabled.adapter.joinTeardown();

  const { adapter, worker, timers } = adapterFixture();
  const app = []; worker.onmessage = event => app.push(event.data);
  const pending = worker.observePollExperiment({ enable: false });
  const request = worker.thread.messages.at(-1);
  assert.equal(request.type, POLL_REQUEST); assert.equal(request.workerId, worker.id);
  assert.equal(request.runtimeBundleId, LEGACY_QEMU_BUNDLE_ID); assert.equal(request.enable, false);
  assert.equal([...timers.values()][0].ms, 2_000);
  const observation = { schema: "terrarium.node-poll-experiment/v1", workerId: worker.id, runtimeBundleId: LEGACY_QEMU_BUNDLE_ID };
  const response = { type: POLL_RESPONSE, id: request.id, workerId: worker.id, runtimeBundleId: LEGACY_QEMU_BUNDLE_ID, observation };
  worker.thread.emit("message", { ...response, id: request.id + 1 });
  assert.equal(timers.size, 1); assert.equal(app.length, 0);
  worker.thread.emit("message", response);
  const result = await pending; assert.equal(result.workerId, worker.id);
  assert.equal(result.adapter.postedGuestInputMessages, 0); assert.equal(result.adapter.resumeRequests, 0);
  assert.equal(result.adapter.ioDiagnosticsAlsoEnabled, false); assert.equal(timers.size, 0);
  worker.thread.emit("message", response); assert.equal(app.length, 0);
  const mismatch = worker.observePollExperiment({ enable: true });
  worker.thread.emit("message", { ...response, id: request.id + 1, workerId: worker.id + 1 });
  await assert.rejects(mismatch, /identity did not match/);
  worker.thread.emit("message", { type: "output", port: 0, data: "production-output" });
  assert.equal(app.length, 1);
  worker.terminate(); await adapter.joinTeardown();
});

test("adapter argument failures, timeouts and teardown preserve the two-second bound", async () => {
  const { adapter, worker, timers } = adapterFixture();
  await assert.rejects(worker.observePollExperiment({ enable: true, delay: 2 }), /only/);
  assert.equal(worker.thread.messages.length, 0);
  const pending = worker.observePollExperiment({ enable: false });
  await assert.rejects(worker.observePollExperiment({ enable: true }), /current Node poll/);
  const { callback, ms } = [...timers.values()][0]; assert.equal(ms, 2_000); timers.clear(); callback();
  await assert.rejects(pending, /within 2 seconds/);
  const interrupted = worker.observePollExperiment({ enable: true }); worker.terminate();
  await assert.rejects(interrupted, /terminated/); await adapter.joinTeardown();
  assert.equal(timers.size, 0); await assert.rejects(worker.observePollExperiment({ enable: false }), /terminated/);
});
