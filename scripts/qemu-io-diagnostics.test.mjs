// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { createQemuIoObserver, IO_REQUEST, IO_RESPONSE } from "./qemu-io-diagnostics.mjs";
import { LEGACY_QEMU_BUNDLE_ID } from "../public/runtime/qemu/catalog.js";
import { getQemuBundle } from "../public/runtime/qemu/bundles.js";

const adapterSource = await readFile(new URL("./qemu-node-adapter.mjs", import.meta.url), "utf8");
function adapterFixture(enabled = true) {
  const timers = new Map();
  class FixtureThread extends EventEmitter {
    messages = [];
    constructor(url, options) { super(); this.url = url; this.options = options; }
    postMessage(message) { this.messages.push(message); }
    async terminate() { return 0; }
  }
  // Exercise the actual adapter class with an inert event transport and clock.
  // No engine, guest, worker thread, or Wasm runtime runs in this fixture.
  const declaration = adapterSource.slice(adapterSource.indexOf("export function createNodeQemuWorkers"))
    .replace(/^export /, "").replace("import.meta.url", JSON.stringify(new URL("./qemu-node-adapter.mjs", import.meta.url).href));
  const create = vm.runInNewContext(`(() => { ${declaration}; return createNodeQemuWorkers; })()`, {
    assert, NodeWorker: FixtureThread, URL, getQemuBundle, LEGACY_QEMU_BUNDLE_ID, IO_REQUEST, IO_RESPONSE,
    process: { env: enabled ? { TERRARIUM_QEMU_DIAGNOSTICS: "1" } : {} },
    setTimeout(callback, ms) { const token = {}; timers.set(token, { callback, ms }); return token; },
    clearTimeout(token) { timers.delete(token); }, console,
  });
  const adapter = create({ temporary: "/unused-fixture", manifest: {}, bundleId: LEGACY_QEMU_BUNDLE_ID });
  const worker = new adapter.Worker("https://terrarium.invalid/runtime/qemu/worker.js", { type: "module" });
  return { adapter, worker, timers };
}

test("Node I/O observations preserve initialization, I/O results, arguments and receiver identities", () => {
  const observer = createQemuIoObserver({ workerId: 7, bundleId: "fixture-bundle" });
  const bytes = new Uint8Array([1, 2, 3]);
  let initialized = 0, input = true, readCalls = 0, writeCalls = 0;
  const pty = {
    get readable() { return input; },
    read(length) { assert.equal(this, pty); assert.equal(length, 8); readCalls++; input = false; return bytes; },
    write(value) { assert.equal(this, pty); assert.equal(value, bytes); writeCalls++; return "write-result"; },
  };
  const stream = { fd: 0, flags: 2048, stream_ops: {} };
  const module = { FS: { getStream(fd) { assert.equal(fd, 0); return stream; } }, TTY: { stream_ops: stream.stream_ops } };
  const args = [stream, new Uint8Array(8), 2, 4];
  const options = { pty, onRuntimeInitialized(value) {
    assert.equal(this, module); assert.equal(value, "init-argument"); initialized++;
    // The original startup hook supplies the actual operations before observation.
    this.TTY.stream_ops.read = function (...received) { assert.equal(this, stream.stream_ops); assert.deepEqual(received, args); return 3; };
    this.TTY.stream_ops.poll = function (...received) { assert.equal(this, stream.stream_ops); assert.deepEqual(received, [stream, -1]); return 5; };
    return "init-result";
  } };
  assert.equal(observer.install(options), options, "Retain the options object mutated by Emscripten for cleanup");
  assert.equal(options.onRuntimeInitialized.call(module, "init-argument"), "init-result");
  assert.equal(initialized, 1);
  observer.received({ type: "input", text: "λX", port: 0 });
  observer.received({ type: "input", text: "shell-one", port: 1 });
  assert.equal(pty.read(8), bytes); assert.equal(pty.write(bytes), "write-result");
  assert.equal(stream.stream_ops.read(...args), 3); assert.equal(stream.stream_ops.poll(stream, -1), 5);
  assert.equal(readCalls, 1); assert.equal(writeCalls, 1);
  const observed = observer.snapshot();
  assert.equal(observed.receivedInput[0].bytes, 3); assert.equal(observed.receivedInput[1].messages, 1);
  assert.equal(observed.ptyRead.bytes, 3); assert.equal(observed.ptyRead.lastRequestedBytes, 8);
  assert.equal(observed.ptyWrite.bytes, 3); assert.equal(observed.ttyRead.bytes, 3);
  assert.equal(observed.ttyRead.lastRequestedBytes, 4); assert.equal(observed.ttyPoll.lastMask, 5);
  assert.equal(observed.fd0Read.calls, 1); assert.equal(observed.fd0Read.bytes, 3);
  assert.equal(observed.fd0Read.lastRequestedBytes, 4); assert.equal(observed.fd0Read.positiveLengthZeroReads, 0);
  assert.equal(observed.fd0Poll.calls, 1); assert.equal(observed.fd0Poll.lastMask, 5);
  assert.equal(observed.ptyReadable, false); assert.equal(observed.stdin.usesObservedRead, true);
  assert.equal(observed.receivedMinusConsumedInputBytes, 0);
  assert.equal(observed.stdin.usesObservedPoll, true); assert.equal(observed.stdin.flags, 2048);
  assert.ok(observed.initializedAt); assert.ok(observed.ptyRead.lastAt);
  observed.ptyRead.bytes = 999;
  assert.equal(observer.snapshot().ptyRead.bytes, 3, "A returned snapshot cannot mutate later observations");
  assert.equal(JSON.stringify(observer.snapshot()).includes("shell-one"), false, "Guest text is never retained");
});

test("Node I/O observations preserve thrown errors and distinguish ordinary EAGAIN from xterm-pty waits", () => {
  const observer = createQemuIoObserver({ workerId: 1, bundleId: "fixture-bundle" });
  const ordinary = Object.assign(new Error("ordinary"), { errno: 6 });
  const special = Object.assign(new Error("special"), { errno: 1006 });
  const writeFailure = new Error("write failed");
  const options = { pty: { get readable() { return true; }, read() { throw ordinary; }, write() { throw writeFailure; } },
    onRuntimeInitialized() {
      this.TTY.stream_ops.read = () => { throw ordinary; };
      this.TTY.stream_ops.poll = () => { throw special; };
    },
  };
  const module = { FS: { getStream() { return null; } }, TTY: { stream_ops: {} } };
  observer.install(options); options.onRuntimeInitialized.call(module);
  assert.throws(() => options.pty.read(2), error => error === ordinary);
  assert.throws(() => options.pty.write(new Uint8Array(2)), error => error === writeFailure);
  assert.throws(() => module.TTY.stream_ops.read({}, new Uint8Array(2), 0, 2), error => error === ordinary);
  assert.throws(() => module.TTY.stream_ops.poll({}, -1), error => error === special);
  observer.received({ type: "input", port: 9, text: "invalid" });
  observer.received({ type: "carrier", enabled: true });
  const observed = observer.snapshot();
  assert.equal(observed.ptyRead.eagain6Errors, 1); assert.equal(observed.ttyRead.eagain6Errors, 1);
  assert.equal(observed.ttyPoll.specialWait1006Errors, 1); assert.equal(observed.ptyWrite.errors, 1);
  assert.equal(observed.ptyRead.lastBytes, null); assert.ok(observed.ttyPoll.lastErrorAt);
  assert.equal(observed.receivedInput.reduce((sum, entry) => sum + entry.messages, 0), 0);
  assert.equal(observed.stdin.present, false);
  assert.equal(observed.fd0Read.calls, 0); assert.equal(observed.fd0Poll.calls, 0);
});

test("fd0 observations distinguish shared TTY streams, unknown identities, zero-length reads and positive-length EOF", () => {
  const observer = createQemuIoObserver({ workerId: 8, bundleId: "fixture-bundle" });
  const stdin = { fd: 0 }, stdout = { fd: 1 }, buffer = new Uint8Array(16);
  let result = 0, failure = null, expectedStream, expectedLength, originalCalls = 0, getterCalls = 0;
  const ordinary = Object.assign(new Error("ordinary"), { errno: 6 });
  const special = Object.assign(new Error("special"), { errno: 1006 });
  const operations = {
    read(stream, bytes, offset, length) {
      assert.equal(this, operations); assert.equal(stream, expectedStream);
      assert.equal(bytes, buffer); assert.equal(offset, 2); assert.equal(length, expectedLength);
      originalCalls++; if (failure) throw failure; return result;
    },
    poll(stream, timeout) {
      assert.equal(this, operations); assert.equal(stream, expectedStream); assert.equal(timeout, -1);
      originalCalls++; if (failure) throw failure; return result;
    },
  };
  const module = { FS: { getStream() { return stdin; } }, TTY: { stream_ops: operations } };
  const options = { pty: { readable: true, read() {}, write() {} }, onRuntimeInitialized() {} };
  observer.install(options); options.onRuntimeInitialized.call(module);
  const read = (stream, length, returned) => {
    expectedStream = stream; expectedLength = length; result = returned;
    assert.equal(operations.read(stream, buffer, 2, length), returned);
  };
  const poll = (stream, returned) => {
    expectedStream = stream; result = returned;
    assert.equal(operations.poll(stream, -1), returned);
  };
  read(stdin, 0, 0); read(stdin, 8, 3); read(stdin, 8, 0);
  read(stdout, 8, 0);
  const unknown = [undefined, null, {}, { fd: null }, { fd: "0" }, { fd: -1 },
    Object.create({ fd: 0 }),
    Object.defineProperty({}, "fd", { get() { getterCalls++; throw new Error("Do not invoke a descriptor getter"); } }),
    new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("Descriptor unavailable"); } }),
  ];
  for (const stream of unknown) { read(stream, 8, 0); poll(stream, 16); }
  poll(stdin, 5); poll(stdout, 4);
  expectedStream = stdin; expectedLength = 2; failure = ordinary;
  assert.throws(() => operations.read(stdin, buffer, 2, 2), error => error === ordinary);
  failure = special;
  assert.throws(() => operations.poll(stdin, -1), error => error === special);
  const observed = observer.snapshot();
  assert.equal(getterCalls, 0, "Observation does not invoke an unknown fd getter");
  assert.equal(originalCalls, 8 + unknown.length * 2, "Each call reaches the original operation exactly once");
  assert.equal(observed.ttyRead.calls, 5 + unknown.length);
  assert.equal(observed.ttyRead.positiveLengthZeroReads, 2 + unknown.length);
  assert.equal(observed.fd0Read.calls, 4); assert.equal(observed.fd0Read.bytes, 3);
  assert.equal(observed.fd0Read.positiveLengthZeroReads, 1, "A valid zero-length read is not EOF evidence");
  assert.equal(observed.fd0Read.eagain6Errors, 1); assert.equal(observed.fd0Read.lastBytes, null);
  assert.equal(observed.ttyPoll.calls, 3 + unknown.length); assert.equal(observed.ttyPoll.lastMask, 4);
  assert.equal(observed.fd0Poll.calls, 2); assert.equal(observed.fd0Poll.lastMask, 5);
  assert.equal(observed.fd0Poll.specialWait1006Errors, 1);
  observed.fd0Read.positiveLengthZeroReads = 999;
  assert.equal(observer.snapshot().fd0Read.positiveLengthZeroReads, 1);
});

test("fd0 attribution records descriptor identity at call entry without altering descriptor changes", () => {
  const observer = createQemuIoObserver({ workerId: 9, bundleId: "fixture-bundle" });
  const stream = { fd: 0 };
  const operations = {
    read(received) { assert.equal(received, stream); stream.fd = 1; return 0; },
    poll(received) { assert.equal(received, stream); stream.fd = null; return 4; },
  };
  const module = { FS: { getStream() { return stream; } }, TTY: { stream_ops: operations } };
  const options = { pty: { readable: true, read() {}, write() {} }, onRuntimeInitialized() {} };
  observer.install(options); options.onRuntimeInitialized.call(module);
  assert.equal(operations.read(stream, new Uint8Array(1), 0, 1), 0); assert.equal(stream.fd, 1);
  stream.fd = 0;
  assert.equal(operations.poll(stream, -1), 4); assert.equal(stream.fd, null);
  const observed = observer.snapshot();
  assert.equal(observed.fd0Read.calls, 1); assert.equal(observed.fd0Read.positiveLengthZeroReads, 1);
  assert.equal(observed.fd0Poll.calls, 1); assert.equal(observed.fd0Poll.lastMask, 4);
});

test("Node observation replies match request and worker identities without entering the app protocol", async () => {
  const { adapter, worker, timers } = adapterFixture();
  const app = []; worker.onmessage = event => app.push(event.data);
  worker.postMessage({ type: "input", text: "x" });
  const pending = worker.observeIo();
  const request = worker.thread.messages.at(-1);
  assert.equal(request.type, IO_REQUEST); assert.equal([...timers.values()][0].ms, 2_000);
  const observation = { schema: "terrarium.node-io-observation/v1", workerId: worker.id, runtimeBundleId: LEGACY_QEMU_BUNDLE_ID };
  worker.thread.emit("message", { type: IO_RESPONSE, id: request.id + 1, observation });
  worker.thread.emit("message", { type: "terrarium-harness:unknown", id: request.id });
  assert.equal(timers.size, 1); assert.equal(app.length, 0);
  worker.thread.emit("message", { type: IO_RESPONSE, id: request.id, observation });
  const result = await pending;
  assert.equal(result.workerId, worker.id); assert.equal(result.adapter.postedGuestInputMessages, 1);
  assert.equal(timers.size, 0);
  worker.thread.emit("message", { type: IO_RESPONSE, id: request.id, observation });
  worker.thread.emit("message", { type: "output", port: 0, data: "real-protocol-output" });
  assert.equal(app.length, 1); assert.equal(app[0].type, "output");
  const wrongIdentity = worker.observeIo();
  const next = worker.thread.messages.at(-1);
  worker.thread.emit("message", { type: IO_RESPONSE, id: next.id, observation: { ...observation, workerId: worker.id + 1 } });
  await assert.rejects(wrongIdentity, /identity did not match/);
  assert.equal(timers.size, 0);
  worker.terminate(); await adapter.joinTeardown();
});

test("Node observations are opt-in and bounded; timeout and teardown clear pending requests", async () => {
  const disabled = adapterFixture(false);
  assert.equal(disabled.worker.thread.options.workerData.ioDiagnostics, false);
  await assert.rejects(disabled.worker.observeIo(), /TERRARIUM_QEMU_DIAGNOSTICS=1/);
  assert.equal(disabled.worker.thread.messages.length, 0);
  disabled.worker.terminate(); await disabled.adapter.joinTeardown();

  const { adapter, worker, timers } = adapterFixture();
  const pending = worker.observeIo();
  await assert.rejects(worker.observeIo(), /current Node I\/O observation/);
  const { callback, ms } = [...timers.values()][0]; assert.equal(ms, 2_000);
  timers.clear(); callback();
  await assert.rejects(pending, /within 2 seconds/);
  const interrupted = worker.observeIo();
  worker.terminate();
  await assert.rejects(interrupted, /terminated/);
  await adapter.joinTeardown(); assert.equal(timers.size, 0);
  await assert.rejects(worker.observeIo(), /terminated/);
});
