// SPDX-License-Identifier: Apache-2.0
// Fixtures prove the failure boundary and preservation of timeout/error/ownership.
// Inspector and real QEMU guest behavior require their separate executed checks.
import assert from "node:assert/strict";
import test from "node:test";
import { QemuRuntime } from "../src/lib/qemu-runtime.ts";
import { createFailureStackCapture } from "./qemu-failure-stacks.mjs";

const bundleId = "qemu@8.2.0-terrarium-0ef7b4e-s1-candidate-v2";
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture({ capture, deadlineAt = performance.now() + 90_000 } = {}) {
  const runtime = new QemuRuntime({ defaultBootBundleId: bundleId });
  const messages = [], records = [];
  const worker = { id: 1, stopped: false, thread: { threadId: 42 }, guestInputMessages: 0,
    postMessage: message => { messages.push(message); worker.guestInputMessages++; } };
  runtime.worker = worker;
  runtime.snapshot = { ...runtime.getSnapshot(), status: "booting" };
  const workers = new Set([worker]);
  const diagnosis = createFailureStackCapture({ workers, bundleId, deadlineAt, capture,
    emit: record => records.push(record) });
  return { runtime, worker, workers, messages, records, diagnosis };
}

test("original 60-second startup rejection is captured before teardown, rethrown identically and captured once", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let releaseCapture, captures = 0, originalError = null, teardown = 0;
  const captured = new Promise(resolve => { releaseCapture = resolve; });
  const f = fixture({ capture: async options => {
    captures++; assert.equal(options.timeoutMs, 8000);
    assert.equal(f.runtime.startup, null, "the production startup timer already rejected");
    assert.equal(f.runtime.worker, f.worker); assert.equal(teardown, 0);
    await captured;
    return { completed: true, workers: [], fixtureOnly: true };
  } });
  const nativeStartup = f.runtime.runStartupCommand;
  f.runtime.runStartupCommand = function (...args) {
    return Reflect.apply(nativeStartup, this, args).catch(error => { originalError = error; throw error; });
  };
  const before = f.runtime.runStartupCommand;
  const restore = f.diagnosis.instrumentStartup(f.runtime, "fixture startup");
  let caught = null;
  const operation = f.runtime.runStartupCommand("printf fixture", f.runtime.generation, f.worker)
    .catch(error => { caught = error; teardown++; });
  assert.equal(f.messages.length, 1);
  t.mock.timers.tick(59_999); await flush(); assert.equal(captures, 0); assert.equal(teardown, 0);
  t.mock.timers.tick(1); await flush(); assert.equal(captures, 1); assert.equal(teardown, 0);
  assert.match(originalError.message, /within 60 seconds/);
  releaseCapture(); await operation;
  assert.equal(caught, originalError); assert.equal(teardown, 1);
  await f.diagnosis.captureFailure({ runtime: f.runtime, error: caught, reason: "outer catch" });
  assert.equal(captures, 1); assert.equal(f.messages.length, 1, "diagnosis sent no worker or guest input");
  assert.ok(f.records.some(record => record.status === "captured"));
  assert.ok(f.records.every(record => record.acceptanceEligible === false));
  restore(); assert.equal(f.runtime.runStartupCommand, before);
  console.log("FAILURE_STACK_BOUNDARY_60S_IDENTITY_OK");
});

test("a stale startup generation never attaches even when the worker object still matches", async () => {
  let captures = 0;
  const f = fixture({ capture: async () => { captures++; } });
  const originalError = new Error("fixture original failure");
  f.runtime.runStartupCommand = async () => { f.runtime.generation++; throw originalError; };
  const restore = f.diagnosis.instrumentStartup(f.runtime, "stale fixture");
  await assert.rejects(f.runtime.runStartupCommand("fixture", f.runtime.generation, f.worker), error => error === originalError);
  assert.equal(captures, 0);
  assert.ok(f.records.some(record => record.status === "not-captured-owner-unavailable"
    && record.capturedGeneration !== record.currentGeneration));
  restore();
});

test("another owned guest or unavailable owner refuses process-wide capture", async () => {
  let captures = 0;
  const f = fixture({ capture: async () => { captures++; } });
  f.workers.add({ id: 2, stopped: false, thread: { threadId: 43 } });
  const result = await f.diagnosis.captureFailure({ runtime: f.runtime, error: new Error("fixture failure"), reason: "two guests" });
  assert.equal(result.status, "not-captured-owner-unavailable"); assert.equal(captures, 0);
});

test("insufficient original watchdog budget skips capture without extending the deadline", async () => {
  let captures = 0;
  const f = fixture({ capture: async () => { captures++; }, deadlineAt: performance.now() + 300 });
  const result = await f.diagnosis.captureFailure({ runtime: f.runtime, error: new Error("fixture failure"), reason: "watchdog" });
  assert.equal(result.status, "not-captured-smoke-deadline"); assert.equal(captures, 0);
});

test("capture failure cannot replace the original rejection and a success never invokes capture", async () => {
  let captures = 0;
  const originalError = new Error("original"), diagnosticError = new Error("inspector unavailable");
  const f = fixture({ capture: async () => { captures++; throw diagnosticError; } });
  f.runtime.runStartupCommand = async function (command) { assert.equal(this, f.runtime); if (command === "fail") throw originalError; return "unchanged success"; };
  const restore = f.diagnosis.instrumentStartup(f.runtime, "failure fixture");
  assert.equal(await f.runtime.runStartupCommand("ok", f.runtime.generation, f.worker), "unchanged success");
  assert.equal(captures, 0);
  await assert.rejects(f.runtime.runStartupCommand("fail", f.runtime.generation, f.worker), error => error === originalError);
  assert.equal(captures, 1); assert.ok(f.records.some(record => record.status === "capture-threw" && record.diagnosticError.message === diagnosticError.message));
  f.diagnosis.reportComplete(); assert.equal(f.records.at(-1).captureRequested, true);
  restore();
});
