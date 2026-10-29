// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { createQemuDispatcher, type QemuWorkerEngine } from "../../public/runtime/qemu/dispatch.js";
import { LEGACY_QEMU_BUNDLE_ID, getQemuBundle, type QemuRuntimeBundle } from "./qemu-assets.ts";
import { QEMU_JIT_FIXTURE_TEXT, QEMU_JIT_FIXTURE_STATS } from "./fixtures/qemu-jit.ts";
import { defaultX86MachineConfiguration } from "../../public/runtime/qemu/machine-config.js";
import { OWNED_QEMU_BUNDLE_ID } from "../../public/runtime/qemu/catalog.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const boot = { type: "boot", runtimeBundleId: LEGACY_QEMU_BUNDLE_ID, profileId: "alpine-x86_64", memoryMiB: 512 };
function manifestFixture(bundle: QemuRuntimeBundle = getQemuBundle(LEGACY_QEMU_BUNDLE_ID)) {
  return {
    schema: "terrarium.qemu-packages/v1",
    guest: { architecture: bundle.architecture, distribution: bundle.guest.userland, kernel: bundle.guest.kernel, rootBytes: bundle.guest.rootBytes },
    packages: Object.fromEntries(["kernel", "initramfs", "rom", "rootfs"].map((name) => {
      const asset = bundle.assets[name as keyof typeof bundle.assets];
      return [name, { bytes: asset.bytes, sha256: asset.sha256 }];
    })),
  };
}
function fixture(overrides: Partial<QemuWorkerEngine> = {}, isolated = true) {
  const events: { message: Record<string, unknown>; transfer: Transferable[] }[] = [];
  const calls: unknown[][] = [];
  let closed = 0;
  const checkpoint = new ArrayBuffer(16);
  const engine: QemuWorkerEngine = {
    input: (text, port) => { calls.push(["input", text, port]); },
    carrier: (enabled) => { calls.push(["carrier", enabled]); },
    network: (frame) => { calls.push(["network", [...frame]]); },
    pause: async () => { calls.push(["pause"]); },
    resume: async () => { calls.push(["resume"]); },
    flushDisks: async () => { calls.push(["flush"]); },
    saveCheckpoint: async () => { calls.push(["save"]); return checkpoint; },
    inspectRegisters: async () => { calls.push(["inspect"]); return "RIP=0000000000000010"; },
    inspectResources: async () => { calls.push(["resources"]); return { translationStats: QEMU_JIT_FIXTURE_STATS, monitorText: QEMU_JIT_FIXTURE_TEXT }; },
    restoreCheckpoint: async () => { calls.push(["restore"]); },
    destroy: async () => { calls.push(["destroy"]); },
    ...overrides,
  };
  const options = {
    emit: (message: Record<string, unknown>, transfer: Transferable[] = []) => events.push({ message, transfer }),
    close: () => { closed++; },
    isIsolated: () => isolated,
    loadBundle: async (bundle: QemuRuntimeBundle) => {
      calls.push(["bundle", bundle.id]);
      return { manifest: manifestFixture(bundle), pthreadUrl: "fixture:pthread" };
    },
    loadModule: async () => ({ factory: null, url: "fixture:module" }),
    start: async () => { calls.push(["start"]); return engine; },
  };
  return { receive: createQemuDispatcher(options), options, events, calls, closed: () => closed, engine, checkpoint };
}

test("worker validates shared memory and profile before loading an emulator and owns one boot", async () => {
  for (const [message, isolated, error] of [
    [{ ...boot, memoryMiB: 128 }, true, /profile/],
    [{ ...boot, profileId: "riscv64" }, true, /profile/],
    [{ ...boot, runtimeBundleId: "unknown" }, true, /compatibility identity/],
    [{ ...boot, runtimeBundleId: undefined }, true, /compatibility identity/],
    [boot, false, /isolation/],
  ] as const) {
    const f = fixture({}, isolated); await f.receive(message);
    assert.equal(f.calls.length, 0);
    assert.match(String(f.events.at(-1)?.message.message), error);
  }
  const f = fixture(); await f.receive(boot); await f.receive(boot);
  assert.equal(f.calls.filter(([name]) => name === "start").length, 1);
  assert.match(String(f.events.at(-1)?.message.message), /already owns/);
  await f.receive({ type: "destroy", id: 9 });
  assert.equal(f.closed(), 1);
});

test("worker refuses undeclared hardware and boot fields before loading catalog assets", async () => {
  let getterCalls = 0;
  for (const extra of [{ virtualCpus: 2 }, { architecture: "arm64" }, { arguments: ["-m", "8G"] },
    { manifest: {} }, { pthreadUrl: "https://unverified.invalid/worker.js" }, { assets: {} }, { defaultBootBundleId: LEGACY_QEMU_BUNDLE_ID }]) {
    const f = fixture(); await f.receive({ ...boot, ...extra });
    assert.equal(f.calls.length, 0);
    assert.match(String(f.events.at(-1)?.message.message), /unsupported option/);
  }
  for (const key of ["virtualCpus", Symbol("unknown")]) {
    const f = fixture(), message = Object.defineProperty({ ...boot }, key, {
      get() { getterCalls++; throw new Error("An unknown option getter must not execute"); },
    });
    await f.receive(message);
    assert.equal(f.calls.length, 0); assert.match(String(f.events.at(-1)?.message.message), /unsupported option/);
  }
  assert.equal(getterCalls, 0);
  const inherited = fixture(); await inherited.receive(Object.assign(Object.create({ virtualCpus: 2 }), boot));
  assert.equal(inherited.calls.length, 0); assert.match(String(inherited.events.at(-1)?.message.message), /plain options/);
});

test("worker binds fixed hardware, runtime, image and NIC identities before asset loading", async () => {
  const mac = "02:11:22:33:44:55";
  const machine = defaultX86MachineConfiguration({ presetId: "worker", runtimeBundleId: OWNED_QEMU_BUNDLE_ID, mac });
  const valid = { ...boot, runtimeBundleId: OWNED_QEMU_BUNDLE_ID, memoryMiB: 1024, mac, machine };
  for (const [change, error] of [
    [{ memoryMiB: 512 }, /profile/],
    [{ mac: "02:11:22:33:44:56" }, /NIC identity/],
    [{ runtimeBundleId: LEGACY_QEMU_BUNDLE_ID }, /runtime and NIC identity/],
    [{ customImage: { id: "0".repeat(64) } }, /boot image/],
    [{ checkpoint: new ArrayBuffer(0) }, /RAM checkpoints are unsupported/],
  ] as const) {
    const f = fixture(); await f.receive({ ...valid, ...change });
    assert.equal(f.calls.length, 0);
    assert.match(String(f.events.at(-1)?.message.message), error);
  }
  const good = fixture(); await good.receive(valid);
  assert.deepEqual(good.calls.slice(0, 2), [["bundle", OWNED_QEMU_BUNDLE_ID], ["start"]]);
  const old = fixture(); await old.receive({ ...boot, customImage: { id: "0".repeat(64) } });
  assert.equal(old.calls.length, 0);
  assert.match(String(old.events.at(-1)?.message.message), /versioned machine configuration/);
});

test("worker resolves only the requested catalog bundle and refuses a mismatched guest index", async () => {
  const f = fixture();
  let requested: QemuRuntimeBundle | undefined;
  const receive = createQemuDispatcher({ ...f.options, loadBundle: async (bundle) => {
    requested = bundle;
    const manifest = manifestFixture(bundle);
    manifest.guest.kernel = "foreign-kernel";
    return { manifest, pthreadUrl: "fixture:pthread" };
  } });
  await receive(boot);
  assert.equal(requested, getQemuBundle(LEGACY_QEMU_BUNDLE_ID));
  assert.equal(f.calls.some(([name]) => name === "start"), false);
  assert.match(String(f.events.at(-1)?.message.message), /manifest does not match/);

  let selected: { runtimeBundleId?: unknown; manifest?: unknown; pthreadUrl?: unknown } | undefined;
  const good = fixture();
  await createQemuDispatcher({ ...good.options, start: async (message, options) => {
    selected = { runtimeBundleId: message.runtimeBundleId, manifest: message.manifest, pthreadUrl: options.pthreadUrl };
    return good.engine;
  } })(boot);
  assert.equal(selected?.runtimeBundleId, LEGACY_QEMU_BUNDLE_ID);
  assert.deepEqual(selected?.manifest, manifestFixture());
  assert.equal(selected?.pthreadUrl, "fixture:pthread");
});

test("production worker routes all serial ports and waits for real control and disk completion", async () => {
  const pause = deferred<void>(); const flush = deferred<void>();
  const f = fixture({ pause: () => pause.promise, flushDisks: () => flush.promise });
  await f.receive({ type: "carrier", enabled: true }); await f.receive(boot);
  assert.deepEqual(f.calls.at(-1), ["carrier", true]);
  for (const port of [0, 1, 2, 3]) await f.receive({ type: "input", text: `port-${port}`, port });
  assert.deepEqual(f.calls.filter(([name]) => name === "input"), [0, 1, 2, 3].map((port) => ["input", `port-${port}`, port]));
  await f.receive({ type: "network", frame: new Uint8Array([1, 2, 3]).buffer });
  assert.deepEqual(f.calls.at(-1), ["network", [1, 2, 3]]);

  const paused = f.receive({ type: "pause", id: 2 });
  assert.equal(f.events.some(({ message }) => message.id === 2), false);
  pause.resolve(); await paused;
  assert.deepEqual(f.events.at(-1)?.message, { type: "ack", id: 2 });
  const flushed = f.receive({ type: "flush-disks", id: 3 });
  assert.equal(f.events.some(({ message }) => message.id === 3), false);
  flush.resolve(); await flushed;
  assert.deepEqual(f.events.at(-1)?.message, { type: "ack", id: 3 });
  await f.receive({ type: "save-checkpoint", id: 4 });
  assert.equal(f.events.at(-1)?.message.buffer, f.checkpoint);
  assert.deepEqual(f.events.at(-1)?.transfer, [f.checkpoint]);
  await f.receive({ type: "inspect-registers", id: 6 });
  assert.deepEqual(f.events.at(-1)?.message, { type: "ack", id: 6, registers: "RIP=0000000000000010" });
  await f.receive({ type: "destroy", id: 5 });
  const count = f.events.length; await f.receive({ type: "input", text: "late", port: 1 });
  assert.equal(f.events.length, count);
  assert.equal(f.calls.some((call) => call[1] === "late"), false);
});

test("paused checkpoint restore completes before initialized is reported", async () => {
  const restored = deferred<void>();
  const f = fixture({ restoreCheckpoint: () => restored.promise });
  const pending = f.receive({ ...boot, checkpoint: new ArrayBuffer(8) });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.events.length, 0);
  restored.resolve(); await pending;
  assert.deepEqual(f.events.at(-1)?.message, { type: "initialized" });
});

test("fixed resource inspection awaits the engine result and preserves its request identity", async () => {
  const observed = deferred<Awaited<ReturnType<QemuWorkerEngine["inspectResources"]>>>();
  const f = fixture({ inspectResources: () => observed.promise });
  await f.receive(boot);
  const pending = f.receive({ type: "inspect-resources", id: 42, command: "system_reset" });
  assert.equal(f.events.some(({ message }) => message.id === 42), false);
  const resources = { translationStats: QEMU_JIT_FIXTURE_STATS, monitorText: QEMU_JIT_FIXTURE_TEXT };
  observed.resolve(resources); await pending;
  assert.deepEqual(f.events.at(-1), { message: { type: "ack", id: 42, resources }, transfer: [] });
  assert.equal(f.calls.some(([name]) => ["input", "pause", "resume"].includes(String(name))), false);
  const rejected = fixture({ inspectResources: async () => { throw new Error("Pause the machine first."); } });
  await rejected.receive(boot); await rejected.receive({ type: "inspect-resources", id: 43 });
  assert.deepEqual(rejected.events.at(-1)?.message, { type: "error", message: "Pause the machine first." });
});

test("only an explicitly safe checkpoint refusal is a recoverable control error", async () => {
  const refusal = Object.assign(new Error("Disconnect an active transfer before saving."), { code: "checkpoint_rejected" });
  const f = fixture({ saveCheckpoint: async () => { throw refusal; } });
  await f.receive(boot);
  await f.receive({ type: "save-checkpoint", id: 7 });
  assert.deepEqual(f.events.at(-1)?.message, {
    type: "control-error", id: 7, code: "checkpoint_rejected", message: refusal.message,
  });
  await f.receive({ type: "resume", id: 8 });
  assert.deepEqual(f.events.at(-1)?.message, { type: "ack", id: 8 });
  assert.equal(f.closed(), 0);

  for (const [type, error] of [["save-checkpoint", new Error("Device state is uncertain.")], ["pause", refusal]] as const) {
    const fatal = fixture({
      saveCheckpoint: async () => { throw error; },
      pause: async () => { throw error; },
    });
    await fatal.receive(boot);
    await fatal.receive({ type, id: 9 });
    assert.deepEqual(fatal.events.at(-1)?.message, { type: "error", message: error.message });
  }
});

test("closing during asynchronous startup destroys a late engine without publishing readiness", async () => {
  const f = fixture(); const started = deferred<QemuWorkerEngine>();
  const receive = createQemuDispatcher({ ...f.options, start: () => started.promise });
  const pending = receive(boot);
  await Promise.resolve(); await Promise.resolve();
  await receive({ type: "destroy", id: 1 });
  started.resolve(f.engine); await pending;
  assert.equal(f.closed(), 1);
  assert.deepEqual(f.events.map(({ message }) => message), [{ type: "ack", id: 1 }]);
  assert.equal(f.calls.filter(([name]) => name === "destroy").length, 1);
});
