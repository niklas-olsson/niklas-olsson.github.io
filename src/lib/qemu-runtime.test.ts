// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import "fake-indexeddb/auto";
import type { NetworkPort } from "./network.ts";
import type { SerialPort } from "./runtime-types.ts";
import { DEFAULT_QEMU_BUNDLE_ID, LEGACY_QEMU_BUNDLE_ID, OWNED_QEMU_BUNDLE_ID, QEMU_BUNDLES,
  getQemuBundle, resolveQemuAssetUrl, type QemuAsset, type QemuBundleId } from "./qemu-assets.ts";
import { QemuRuntime as ProductionQemuRuntime } from "./qemu-runtime.ts";
import { createQemuCheckpoint, parseQemuCheckpoint } from "./qemu-checkpoint.ts";
import { RUNTIME_PROFILES } from "./runtime-profiles.ts";
import { QemuResourceBudget } from "./runtime-resources.ts";
import { QEMU_JIT_FIXTURE_TEXT, QEMU_JIT_FIXTURE_STATS } from "./fixtures/qemu-jit.ts";
import { defaultX86MachineConfiguration } from "./x86-machine-config.ts";
import { fixtureImage } from "./machine-image.test-fixtures.ts";
import { importMachineImage, deleteMachineImage } from "./machine-image-store.ts";

const lifecycleBytes = new TextEncoder().encode("QEMU lifecycle fixture");
const lifecycleHash = createHash("sha256").update(lifecycleBytes).digest("hex");
/** Substitute only small download contents; never mutate the production catalog. */
class QemuRuntime extends ProductionQemuRuntime {
  protected override loadVerifiedAsset(asset: QemuAsset, signal: AbortSignal, progress: (bytes: number) => void): Promise<ArrayBuffer> {
    return super.loadVerifiedAsset({ ...asset, bytes: lifecycleBytes.length, sha256: lifecycleHash }, signal, progress);
  }
}

const tick = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function capabilityOutput(command: string, kernel = "6.12.43-0-virt"): string {
  const token = /__TRM_CAPS_V1_([A-Za-z0-9_-]+)_BEGIN__/.exec(command)?.[1];
  if (!token) return "";
  return [
    `__TRM_CAPS_V1_${token}_BEGIN__`, "architecture\tx86_64", `kernel\t${kernel}`,
    "memory_kib\t491520", "cpus\t1", "cgroup_mode\tv2", "controllers\tcpu memory pids",
    "namespaces\tipc mnt net pid uts", "overlay\tregistered", "command_containerd\t0",
    "command_runc\t0", "command_k3s\t0", "command_kubectl\t0", "command_crictl\t0", "command_ctr\t0",
    `__TRM_CAPS_V1_${token}_END__`,
  ].join("\n");
}

interface SentMessage { type: string; id?: number; text?: string; port?: SerialPort; [key: string]: unknown }
interface FramedCommand { command: string; workerIndex: number; respond: (output?: string, exitCode?: number, suffix?: string) => void }

/** Structural qcow2 fixture. These bytes are never executed by an emulator. */
function checkpointPayload(): ArrayBuffer {
  const cluster = 65536, bytes = new Uint8Array(5 * cluster), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x514649fb); view.setUint32(4, 3); view.setUint32(20, 16);
  view.setBigUint64(24, 8n * 1024n * 1024n); view.setUint32(36, 1);
  view.setBigUint64(40, BigInt(3 * cluster)); view.setBigUint64(48, BigInt(cluster)); view.setUint32(56, 1);
  view.setUint32(60, 1); view.setBigUint64(64, BigInt(4 * cluster)); view.setUint32(96, 4); view.setUint32(100, 104);
  view.setBigUint64(cluster, BigInt(2 * cluster));
  view.setBigUint64(4 * cluster, BigInt(3 * cluster)); view.setUint32(4 * cluster + 8, 1);
  view.setUint16(4 * cluster + 12, 1); view.setUint16(4 * cluster + 14, 9); view.setUint32(4 * cluster + 16, 1); view.setUint32(4 * cluster + 36, 16);
  bytes.set(new TextEncoder().encode("1terrarium"), 4 * cluster + 56);
  return bytes.buffer;
}

/** Tiny verified fixtures exercise the owner lifecycle without emulating Linux. */
function harness(options: { manualCommands?: boolean; manualControls?: boolean; manualInspections?: boolean; manualShells?: boolean; corruptDownload?: boolean; isolated?: boolean; checkpoints?: boolean } = {}) {
  const fixture = lifecycleBytes;
  const assets = Object.values(QEMU_BUNDLES).flatMap((bundle) => Object.values(bundle.assets));
  const profileCapabilities = { ...RUNTIME_PROFILES["alpine-x86_64"].capabilities };
  if (options.checkpoints) Object.assign(RUNTIME_PROFILES["alpine-x86_64"].capabilities, { snapshots: true });
  const timers = new Set<{ callback: () => void; delay: number; cancelled: boolean }>();
  const created = deferred<MockWorker>();
  const workers: MockWorker[] = [];
  const workerWaiters = new Map<number, ReturnType<typeof deferred<MockWorker>>>();
  const commands: FramedCommand[] = [];
  const commandWaiters = new Map<number, ReturnType<typeof deferred<FramedCommand>>>();
  let fetchCount = 0;
  class MockWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    readonly sent: SentMessage[] = [];
    terminated = false;
    private bundleId: QemuBundleId = LEGACY_QEMU_BUNDLE_ID;
    constructor(url: string, settings: WorkerOptions) {
      assert.equal(url, "https://terrarium.test/runtime/qemu/worker.js");
      assert.equal(settings.type, "module");
      const index = workers.push(this) - 1; created.resolve(this); workerWaiters.get(index)?.resolve(this);
    }
    emit(data: SentMessage) { this.onmessage?.({ data } as MessageEvent); }
    fail(message: string) { this.onerror?.({ message, preventDefault() {} } as ErrorEvent); }
    postMessage(message: SentMessage) {
      assert.equal(this.terminated, false, "a stopped worker must not receive new commands");
      this.sent.push(message);
      if (message.type === "boot") this.bundleId = getQemuBundle(message.runtimeBundleId).id;
      if (message.type === "boot") queueMicrotask(() => this.emit(message.checkpoint instanceof ArrayBuffer
        ? { type: "initialized" }
        : { type: "output", port: 0, data: "\nterrarium:~# " }));
      if (["pause", "resume", "destroy", "flush-disks", "inspect-registers", "save-checkpoint", "inspect-resources"].includes(message.type)
        && !options.manualControls && !(message.type === "inspect-resources" && options.manualInspections))
        queueMicrotask(() => this.emit({ type: "ack", id: message.id,
          ...(message.type === "inspect-registers" ? { registers: "RIP=ffffffff81000100 CPL=0 HLT=1" } : {}),
          ...(message.type === "save-checkpoint" ? { buffer: checkpointPayload() } : {}),
          ...(message.type === "inspect-resources" ? { resources: { translationStats: { ...QEMU_JIT_FIXTURE_STATS }, monitorText: QEMU_JIT_FIXTURE_TEXT } } : {}),
        }));
      if (message.type !== "input" || typeof message.text !== "string") return;
      const token = /__TRM_BEGIN_([A-Za-z0-9]+)__/.exec(message.text)?.[1];
      if (!token) return;
      const chunks = [...message.text.matchAll(/printf '%s' '([^']*)' (?:>|>>) "\$_trm_dir\/payload"/g)].map((match) => match[1]);
      const command = Buffer.from(chunks.join(""), "base64").toString("utf8");
      const workerIndex = workers.indexOf(this);
      const firstCommand = !commands.some((entry) => entry.workerIndex === workerIndex);
      const frame = {
        command, workerIndex,
        respond: (output = capabilityOutput(command, getQemuBundle(this.bundleId).guest.kernel), exitCode = 0, suffix = "") => {
          this.emit({ type: "output", port: 0, data: `\n__TRM_BEGIN_${token}__\n${output}\n__TRM_END_${token}__:${exitCode}\n${suffix}` });
          if (firstCommand && !options.manualShells) queueMicrotask(() => {
            for (const port of [1, 2, 3] as const) this.emit({ type: "output", port, data: `\nshell-${port}> ` });
          });
        },
      };
      const index = commands.push(frame) - 1;
      commandWaiters.get(index)?.resolve(frame);
      if (!options.manualCommands) queueMicrotask(() => frame.respond());
    }
    terminate() { this.terminated = true; }
  }
  const values: Record<string, unknown> = {
    Worker: MockWorker, document: { baseURI: "https://terrarium.test/" },
    crossOriginIsolated: options.isolated !== false, isSecureContext: true,
    fetch: async (url: string, init: RequestInit) => {
      fetchCount++;
      assert.ok(assets.some((asset) => resolveQemuAssetUrl(asset, "https://terrarium.test/") === url), "only pinned runtime assets may be fetched");
      assert.equal(init.credentials, "omit");
      assert.ok(init.signal instanceof AbortSignal);
      const bytes = fixture.slice(); if (options.corruptDownload) bytes[0] ^= 255;
      return new Response(bytes);
    },
    setTimeout: (callback: () => void, delay: number) => { const timer = { callback, delay, cancelled: false }; timers.add(timer); return timer; },
    clearTimeout: (timer: { cancelled: boolean } | undefined) => { if (timer) timer.cancelled = true; },
  };
  const prior = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return {
    workers, commands, created: created.promise, fetchCount: () => fetchCount,
    waitForWorker(index: number): Promise<MockWorker> {
      if (workers[index]) return Promise.resolve(workers[index]);
      const waiter = deferred<MockWorker>(); workerWaiters.set(index, waiter); return waiter.promise;
    },
    waitForCommand(index: number): Promise<FramedCommand> {
      if (commands[index]) return Promise.resolve(commands[index]);
      const waiter = deferred<FramedCommand>(); commandWaiters.set(index, waiter); return waiter.promise;
    },
    fireTimeout(delay: number) {
      const timer = [...timers].find((item) => item.delay === delay && !item.cancelled);
      assert.ok(timer, `an active ${delay} ms deadline must exist`);
      timer.cancelled = true; timer.callback();
    },
    restore() {
      Object.assign(RUNTIME_PROFILES["alpine-x86_64"].capabilities, profileCapabilities);
      for (const [key, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

function networkHarness(attachment: Promise<void> = Promise.resolve(), setupCommand = ":") {
  const readiness: boolean[] = [];
  let detached = 0;
  return {
    readiness, detached: () => detached,
    port: {
      attachEthernet: () => attachment,
      setReady: (value: boolean) => readiness.push(value),
      detach: () => { detached++; },
      guestSetupCommand: () => setupCommand,
      getSnapshot: () => ({ gateway: "192.168.76.1" }),
    } as unknown as NetworkPort,
  };
}

test("x86_64 refuses unsupported shared memory and altered assets before creating a worker", async () => {
  for (const options of [{ isolated: false }, { corruptDownload: true }]) {
    const h = harness(options); const runtime = new QemuRuntime();
    try {
      await assert.rejects(runtime.boot(), options.isolated === false ? /Workspace & storage/ : /integrity check/);
      assert.equal(runtime.getSnapshot().status, "error");
      assert.equal(runtime.getSnapshot().controlReady, false);
      assert.equal(runtime.getSnapshot().runtimeBundle?.activeBundleId, null);
      assert.equal(h.workers.length, 0);
      if (options.isolated === false) assert.equal(h.fetchCount(), 0);
    } finally { await runtime.destroy(); h.restore(); }
  }
});

test("x86_64 construction rejects undeclared hardware and boot overrides before resource admission", async () => {
  const h = harness();
  const budget = new QemuResourceBudget({ id: "constructor-contract-fixture", maxActiveRuntimes: 1, maxReservedWasmMiB: 2300 });
  let getterCalls = 0;
  try {
    for (const extra of [{ memoryMiB: 1024 }, { virtualCpus: 2 }, { architecture: "arm64" },
      { arguments: ["-m", "8G"] }, { kernel: "https://unverified.invalid/kernel" }, { manifest: {} }])
      assert.throws(() => new QemuRuntime({ resourceBudget: budget, ...extra }), /unsupported option/);
    const getter = Object.defineProperty({ resourceBudget: budget }, "memoryMiB", {
      get() { getterCalls++; throw new Error("An unknown option getter must not execute"); },
    });
    assert.throws(() => new QemuRuntime(getter), /unsupported option "memoryMiB"/);
    assert.equal(getterCalls, 0);
    assert.throws(() => new QemuRuntime(Object.create({ memoryMiB: 1024 })), /plain options/);
    assert.throws(() => new QemuRuntime([] as never), /options object/);
    assert.throws(() => new QemuRuntime(null as never), /options object/);
    assert.equal(budget.getUsage().activeRuntimes, 0); assert.equal(h.fetchCount(), 0); assert.equal(h.workers.length, 0);
    const valid = new QemuRuntime(Object.assign(Object.create(null), {
      profileId: "alpine-x86_64", defaultBootBundleId: LEGACY_QEMU_BUNDLE_ID,
      initScript: "", volumes: [], resourceBudget: budget,
    }));
    assert.equal(valid.getSnapshot().status, "idle"); await valid.destroy();
  } finally { h.restore(); }
});

test("catalog identity follows the running legacy guest through save, restore, stop and reset", async () => {
  const h = harness({ checkpoints: true });
  const runtime = new QemuRuntime({ defaultBootBundleId: LEGACY_QEMU_BUNDLE_ID });
  try {
    assert.equal(new QemuRuntime().defaultBootBundleId, DEFAULT_QEMU_BUNDLE_ID);
    assert.deepEqual(runtime.getSnapshot().runtimeBundle, { defaultBootBundleId: LEGACY_QEMU_BUNDLE_ID, activeBundleId: null });
    assert.throws(() => new QemuRuntime({ defaultBootBundleId: "unbuilt-runtime" as never }), /compatibility identity/);
    await runtime.boot();
    assert.equal(h.workers[0].sent.find((message) => message.type === "boot")?.runtimeBundleId, LEGACY_QEMU_BUNDLE_ID);
    assert.equal(runtime.getSnapshot().runtimeBundle?.activeBundleId, LEGACY_QEMU_BUNDLE_ID);
    const checkpoint = await runtime.save();
    assert.equal((await parseQemuCheckpoint(checkpoint)).manifest.runtimeVersion, LEGACY_QEMU_BUNDLE_ID);
    await runtime.restore(checkpoint, { paused: true });
    assert.equal(runtime.getSnapshot().runtimeBundle?.activeBundleId, LEGACY_QEMU_BUNDLE_ID);
    assert.equal(h.workers[1].sent.find((message) => message.type === "boot")?.runtimeBundleId, LEGACY_QEMU_BUNDLE_ID);
    assert.equal((await parseQemuCheckpoint(await runtime.save())).manifest.runtimeVersion, LEGACY_QEMU_BUNDLE_ID);
    await runtime.destroy();
    assert.deepEqual(runtime.getSnapshot().runtimeBundle, { defaultBootBundleId: LEGACY_QEMU_BUNDLE_ID, activeBundleId: null });
    await runtime.boot();
    await runtime.reset();
    assert.equal(h.workers.at(-1)?.sent.find((message) => message.type === "boot")?.runtimeBundleId, runtime.defaultBootBundleId);
    assert.equal(runtime.getSnapshot().runtimeBundle?.activeBundleId, runtime.defaultBootBundleId);
  } finally { await runtime.destroy(); h.restore(); }
});

test("an owned boot default restores and resaves a legacy identity, then reset returns to the explicit default", async () => {
  const h = harness({ checkpoints: true });
  const runtime = new QemuRuntime({ defaultBootBundleId: OWNED_QEMU_BUNDLE_ID });
  try {
    await runtime.boot();
    assert.equal(h.workers[0].sent.find((message) => message.type === "boot")?.runtimeBundleId, OWNED_QEMU_BUNDLE_ID);
    assert.equal(runtime.getSnapshot().runtimeBundle?.activeBundleId, OWNED_QEMU_BUNDLE_ID);
    assert.equal((await parseQemuCheckpoint(await runtime.save())).manifest.runtimeVersion, OWNED_QEMU_BUNDLE_ID);
    const legacy = await createQemuCheckpoint(checkpointPayload(), { runtimeBundleId: LEGACY_QEMU_BUNDLE_ID, mac: "02:54:00:11:22:33" });
    await runtime.restore(legacy, { paused: true });
    assert.deepEqual(runtime.getSnapshot().runtimeBundle, { defaultBootBundleId: OWNED_QEMU_BUNDLE_ID, activeBundleId: LEGACY_QEMU_BUNDLE_ID });
    assert.equal(h.workers[1].sent.find((message) => message.type === "boot")?.runtimeBundleId, LEGACY_QEMU_BUNDLE_ID);
    const resaved = await parseQemuCheckpoint(await runtime.save());
    assert.equal(resaved.manifest.runtimeVersion, LEGACY_QEMU_BUNDLE_ID);
    assert.equal(resaved.manifest.emulatorSha256, getQemuBundle(LEGACY_QEMU_BUNDLE_ID).assets.wasm.sha256);
    await runtime.reset();
    assert.deepEqual(runtime.getSnapshot().runtimeBundle, { defaultBootBundleId: OWNED_QEMU_BUNDLE_ID, activeBundleId: OWNED_QEMU_BUNDLE_ID });
    assert.equal(h.workers[2].sent.find((message) => message.type === "boot")?.runtimeBundleId, OWNED_QEMU_BUNDLE_ID);
  } finally { await runtime.destroy(); h.restore(); }
});

test("control TTY flow settings are established before the first frame saves its baseline", async () => {
  const h = harness({ manualCommands: true }); const runtime = new QemuRuntime();
  try {
    const boot = runtime.boot();
    const setup = await h.waitForCommand(0);
    const controlInputs = h.workers[0].sent.filter((message) => message.type === "input" && (message.port ?? 0) === 0);
    const firstFrame = controlInputs.findIndex((message) => message.text?.includes("__TRM_BEGIN_"));
    assert.ok(firstFrame > 0, "the control TTY must be configured in raw shell input before the first encoded frame");
    const preamble = controlInputs.slice(0, firstFrame).map((message) => message.text ?? "").join("");
    assert.match(preamble, /(?:^|\n)stty -F \/dev\/ttyS0 sane -ixon -ixoff(?: |;|\n)/,
      "putting stty only inside the encoded setup is undone when its wrapper restores the old flags");
    assert.ok(preamble.endsWith("\n"), "the raw configuration must be a complete shell command before the frame begins");
    assert.match(controlInputs[firstFrame].text!, /^_trm_tty=\$\(stty -g\); stty -echo\n\{\n/);
    setup.respond();
    (await h.waitForCommand(1)).respond();
    await boot;
    assert.equal(runtime.getSnapshot().status, "running");
  } finally { await runtime.destroy(); h.restore(); }
});

test("boot measures capabilities after init completes, including when init exits nonzero", async () => {
  for (const initExitCode of [0, 7]) {
    const h = harness({ manualCommands: true });
    const network = networkHarness(Promise.resolve(), "printf network-setup");
    const runtime = new QemuRuntime({ initScript: "echo custom-init", networkPort: network.port });
    const seen: string[] = []; runtime.onOutput((data) => seen.push(data));
    let settled = false;
    try {
      const boot = runtime.boot().then(() => { settled = true; });
      const setup = await h.waitForCommand(0);
      assert.equal(runtime.getSnapshot().status, "booting");
      assert.equal(runtime.getSnapshot().controlReady, false);
      assert.equal(settled, false);
      assert.match(setup.command, /stty -F \/dev\/ttyS0 sane/);
      const sysfs = setup.command.indexOf("mountpoint -q /sys || mount -t sysfs sysfs /sys");
      assert.ok(sysfs >= 0, "Alpine needs sysfs mounted before device discovery");
      assert.ok(sysfs < setup.command.indexOf("printf network-setup"), "sysfs must be ready before network setup");
      assert.ok(sysfs < setup.command.indexOf("mkdir -p /run/terrarium"), "sysfs must be ready before session bootstrap");
      setup.respond();
      const init = await h.waitForCommand(1);
      assert.equal(init.command, "echo custom-init");
      assert.equal(runtime.getSnapshot().init?.status, "running");
      assert.equal(runtime.getSnapshot().guestCapabilities, undefined);
      assert.equal(settled, false); init.respond("custom-init\n", initExitCode);
      const probe = await h.waitForCommand(2);
      assert.match(probe.command, /__TRM_CAPS_V1_/, "capabilities must describe the state left by init");
      assert.equal(runtime.getSnapshot().init?.status, initExitCode === 0 ? "succeeded" : "failed");
      assert.equal(runtime.getSnapshot().init?.exitCode, initExitCode);
      assert.equal(runtime.getSnapshot().controlReady, false);
      assert.equal(runtime.getSnapshot().guestCapabilities, undefined);
      assert.equal(settled, false, "completed init does not skip the subsequent capability observation");
      probe.respond();
      await boot;
      assert.equal(runtime.getSnapshot().status, "running");
      assert.equal(runtime.getSnapshot().controlReady, true);
      assert.equal(runtime.getSnapshot().init?.exitCode, initExitCode);
      assert.equal(runtime.getSnapshot().guestCapabilities?.architecture, "x86_64");
      assert.equal(runtime.getSnapshot().guestCapabilities?.kubernetesExecution, "not-verified");
      assert.ok(seen.some((data) => data.includes("custom-init")));
      let replay = ""; runtime.onOutput((data) => { replay += data; });
      assert.match(replay, /custom-init/);
    } finally { await runtime.destroy(); h.restore(); }
  }
});

test("a failed guest prerequisite setup prevents init and leaves no live worker", async () => {
  const h = harness({ manualCommands: true });
  const runtime = new QemuRuntime({ initScript: "echo must-not-run" });
  try {
    const boot = runtime.boot();
    const rejected = assert.rejects(boot, /initialization failed.*exit 1/);
    const setup = await h.waitForCommand(0);
    assert.match(setup.command, /^set -e\n/);
    h.workers[0].emit({ type: "resource-observation", wasmMemoryBytes: 2411724800 });
    assert.ok(runtime.getSnapshot().resourceObservation);
    setup.respond("mount: sysfs preparation failed\n", 1);
    await rejected;
    assert.equal(h.commands.length, 1, "user init and observation must not follow failed setup");
    assert.equal(h.workers[0].terminated, true);
    assert.equal(runtime.getSnapshot().status, "error");
    assert.equal(runtime.getSnapshot().controlReady, false);
    assert.equal(runtime.getSnapshot().resourceObservation, undefined);
    assert.equal(runtime.getSnapshot().runtimeBundle?.activeBundleId, null);
  } finally { await runtime.destroy(); h.restore(); }
});

test("startup timeout clears its observed memory after terminating the worker", async () => {
  const h = harness({ manualCommands: true }); const runtime = new QemuRuntime();
  try {
    const boot = runtime.boot(), rejected = assert.rejects(boot, /did not finish within 60 seconds/);
    await h.waitForCommand(0);
    const worker = h.workers[0];
    worker.emit({ type: "resource-observation", wasmMemoryBytes: 2411724800 });
    assert.ok(runtime.getSnapshot().resourceObservation);
    h.fireTimeout(60_000); await rejected;
    assert.equal(worker.terminated, true); assert.equal(runtime.getSnapshot().status, "error");
    assert.equal(runtime.getSnapshot().runtimeBundle?.activeBundleId, null);
    assert.equal(runtime.getSnapshot().resourceObservation, undefined);
    worker.emit({ type: "resource-observation", wasmMemoryBytes: 2411724800 });
    assert.equal(runtime.getSnapshot().resourceObservation, undefined, "A late memory report cannot revive a stopped generation");
  } finally { await runtime.destroy(); h.restore(); }
});

test("all independent shells become ready before init and retain separate input and output", async () => {
  const h = harness({ manualCommands: true, manualShells: true });
  const runtime = new QemuRuntime({ initScript: "echo shell-init" });
  try {
    assert.deepEqual(runtime.capabilities.serialPorts, [0, 1, 2, 3]);
    assert.deepEqual(runtime.capabilities.interactivePorts, [1, 2, 3]);
    const boot = runtime.boot();
    const setup = await h.waitForCommand(0); setup.respond();
    const worker = h.workers[0];
    worker.emit({ type: "output", port: 1, data: "\nshell-1> " });
    worker.emit({ type: "output", port: 2, data: "\nshell-" });
    worker.emit({ type: "output", port: 2, data: "2> " });
    await tick(); await tick();
    assert.equal(runtime.getSnapshot().status, "booting");
    assert.equal(runtime.getSnapshot().controlReady, false);
    assert.equal(h.commands.length, 1, "init must wait for the remaining shell");
    assert.deepEqual(runtime.getSnapshot().sessions?.map((session) => session.status), ["ready", "ready", "starting"]);
    worker.emit({ type: "output", port: 3, data: "\nshell-3> " });
    const init = await h.waitForCommand(1);
    assert.equal(init.command, "echo shell-init"); init.respond("shell-init\n");
    (await h.waitForCommand(2)).respond();
    await boot;
    assert.deepEqual(runtime.getSnapshot().sessions?.map((session) => session.status), ["ready", "ready", "ready"]);

    const outputs = new Map<SerialPort, string>([0, 1, 2, 3].map((port) => [port as SerialPort, ""]));
    const unsubscribers = ([0, 1, 2, 3] as const).map((port) => runtime.onOutput((data) => outputs.set(port, outputs.get(port)! + data), port));
    runtime.onOutput(() => { throw new Error("observer failed"); }, 1);
    for (const port of [0, 1, 2, 3] as const) worker.emit({ type: "output", port, data: `unique-port-${port}\n` });
    for (const port of [0, 1, 2, 3] as const) {
      assert.match(outputs.get(port)!, new RegExp(`unique-port-${port}`));
      for (const other of [0, 1, 2, 3]) if (other !== port) assert.doesNotMatch(outputs.get(port)!, new RegExp(`unique-port-${other}`));
    }
    const initial = outputs.get(2);
    unsubscribers[2](); worker.emit({ type: "output", port: 2, data: "after-unsubscribe\n" });
    assert.equal(outputs.get(2), initial);
    let replay = ""; runtime.onOutput((data) => { replay += data; }, 2);
    assert.match(replay, /after-unsubscribe/); assert.doesNotMatch(replay, /unique-port-1|unique-port-3/);

    const sentBefore = worker.sent.length;
    for (const port of [0, 1, 2, 3] as const) runtime.send(`input-${port}\n`, port);
    assert.deepEqual(worker.sent.slice(sentBefore).map(({ type, text, port }) => ({ type, text, port })),
      [0, 1, 2, 3].map((port) => ({ type: "input", text: `input-${port}\n`, port })));
    assert.throws(() => runtime.send("invalid\n", 4 as SerialPort), /port|serial/i);
    for (const unsubscribe of unsubscribers) unsubscribe();
  } finally { await runtime.destroy(); h.restore(); }
});

test("fresh control bootstrap excludes delayed line-editor replies before queuing its payload", async () => {
  const h = harness({ manualCommands: true }); const runtime = new QemuRuntime();
  try {
    const boot = runtime.boot(); void boot.catch(() => {}); await h.waitForCommand(0); const worker = h.workers[0];
    const inputs = worker.sent.filter(message => message.type === "input");
    const before = worker.sent.length;
    worker.emit({ type: "output", port: 0, data: "\x1b[6n" });
    assert.equal(worker.sent.length, before, "A delayed interactive query must not append terminal bytes behind a queued control frame");
    assert.match(inputs[0].text ?? "", /stty -F \/dev\/ttyS0 sane -ixon -ixoff -echo/);
    (await h.waitForCommand(0)).respond(); (await h.waitForCommand(1)).respond(); await boot;
  } finally { await runtime.destroy(); h.restore(); }
});

test("fresh control suppresses delayed cursor replies; explicitly resumed query handling stays bounded", async () => {
  const h = harness({ manualCommands: true });
  const runtime = new QemuRuntime({ initScript: "echo init-for-query-order" });
  const reply = { type: "input", port: 0, text: "\x1b[1;1R" };
  try {
    const boot = runtime.boot();
    (await h.waitForCommand(0)).respond();
    const init = await h.waitForCommand(1), worker = h.workers[0], beforeCompletion = worker.sent.length;
    init.respond("init-for-query-order\n", 0, "\x1b[6n");
    const probe = await h.waitForCommand(2);
    const continuation = worker.sent.slice(beforeCompletion).filter((message) => message.type === "input");
    assert.equal(continuation.length, 1, "A delayed initial editor query must not inject bytes into the next frame");
    assert.match(continuation[0]?.text ?? "", /__TRM_BEGIN_/);
    probe.respond(); await boot;
    assert.equal(runtime.getSnapshot().status, "running");

    const afterBoot = worker.sent.length;
    worker.emit({ type: "output", port: 0, data: "\x1b[6n" });
    assert.equal(worker.sent.length, afterBoot, "The fresh control baseline remains free of editor replies");
    // Existing explicitly resumed/checkpoint query handling retains its parser,
    // port isolation and per-event response bounds.
    await runtime.pause(); await runtime.resume();
    const beforeSplit = worker.sent.length;
    for (const data of ["\x1b", "[6"]) {
      worker.emit({ type: "output", port: 0, data });
      assert.equal(worker.sent.length, beforeSplit, "an incomplete query must not send a reply");
    }
    worker.emit({ type: "output", port: 0, data: "n" });
    assert.deepEqual(worker.sent.slice(beforeSplit), [reply]);
    worker.emit({ type: "output", port: 0, data: "ordinary output\n\x1b[5n\x1b[?6n" });
    assert.equal(worker.sent.length, beforeSplit + 1, "completed queries are not replayed and other status queries are ignored");
    for (const port of [1, 2, 3] as const) worker.emit({ type: "output", port, data: "\x1b[6n" });
    assert.equal(worker.sent.length, beforeSplit + 1, "interactive terminal replies belong to xterm, not the runtime");

    const beforeFlood = worker.sent.length;
    worker.emit({ type: "output", port: 0, data: "\x1b[6n".repeat(64) });
    assert.deepEqual(worker.sent.slice(beforeFlood), [{ ...reply, text: reply.text.repeat(16) }]);
    worker.emit({ type: "output", port: 0, data: "ordinary output\n" });
    assert.equal(worker.sent.length, beforeFlood + 1, "excess queries must not create a deferred response flood");
    worker.emit({ type: "output", port: 0, data: "\x1b[6n" });
    assert.deepEqual(worker.sent.at(-1), reply, "the response bound applies to each event, not the lifetime of the channel");
  } finally { await runtime.destroy(); h.restore(); }
});

test("control cursor replies stop while pausing or paused and return after explicit resume", async () => {
  const h = harness(); const runtime = new QemuRuntime();
  try {
    await runtime.boot();
    const worker = h.workers[0];
    const pausing = runtime.pause(), beforePausedQuery = worker.sent.length;
    worker.emit({ type: "output", port: 0, data: "\x1b[6n" });
    assert.equal(worker.sent.length, beforePausedQuery, "pause disables replies before its acknowledgment arrives");
    await pausing;
    worker.emit({ type: "output", port: 0, data: "\x1b[" });
    worker.emit({ type: "output", port: 0, data: "6n" });
    assert.equal(worker.sent.length, beforePausedQuery);
    await runtime.resume();
    const beforeResumedQuery = worker.sent.length;
    worker.emit({ type: "output", port: 0, data: "\x1b[6n" });
    assert.deepEqual(worker.sent.slice(beforeResumedQuery), [{ type: "input", port: 0, text: "\x1b[1;1R" }]);

    const stopping = runtime.destroy(); await tick();
    const beforeStoppingQuery = worker.sent.length;
    worker.emit({ type: "output", port: 0, data: "\x1b[6n" });
    assert.equal(worker.sent.length, beforeStoppingQuery);
    await stopping;
    worker.emit({ type: "output", port: 0, data: "\x1b[6n" });
    assert.equal(worker.sent.length, beforeStoppingQuery, "late output from a stopped worker cannot send input");
  } finally { await runtime.destroy(); h.restore(); }
});

test("a missing serial shell fails boot before user init or capability claims", async () => {
  const h = harness({ manualCommands: true, manualShells: true });
  const runtime = new QemuRuntime({ initScript: "echo must-not-run" });
  try {
    const boot = runtime.boot();
    const rejected = assert.rejects(boot, /shell|serial|session/i);
    (await h.waitForCommand(0)).respond();
    const worker = h.workers[0];
    worker.emit({ type: "output", port: 1, data: "\nshell-1> " });
    worker.emit({ type: "output", port: 2, data: "\nshell-2> " });
    worker.emit({ type: "resource-observation", wasmMemoryBytes: 2411724800 });
    await tick(); await tick();
    h.fireTimeout(15_000); await rejected;
    assert.equal(worker.terminated, true);
    assert.equal(runtime.getSnapshot().status, "error");
    assert.equal(runtime.getSnapshot().controlReady, false);
    assert.equal(runtime.getSnapshot().guestCapabilities, undefined);
    assert.equal(runtime.getSnapshot().resourceObservation, undefined);
    assert.equal(h.commands.length, 1);
    assert.notEqual(runtime.getSnapshot().sessions?.find((session) => session.port === 3)?.status, "ready");
  } finally { await runtime.destroy(); h.restore(); }
});

test("invalid checkpoint validation leaves the running machine and worker untouched", async () => {
  const h = harness(); const runtime = new QemuRuntime();
  try {
    await runtime.boot();
    const worker = h.workers[0], sent = worker.sent.length, fetched = h.fetchCount();
    worker.emit({ type: "resource-observation", wasmMemoryBytes: 2411724800 });
    const observation = runtime.getSnapshot().resourceObservation;
    await assert.rejects(runtime.restore(new ArrayBuffer(64)), /checkpoint|header|format/i);
    const original = await createQemuCheckpoint(checkpointPayload(), { runtimeBundleId: LEGACY_QEMU_BUNDLE_ID, mac: "02:54:00:11:22:33" });
    for (const field of ["runtimeVersion", "emulatorSha256"] as const) {
      const rejected = original.slice(0), length = new DataView(rejected).getUint32(12, true);
      const manifest = JSON.parse(new TextDecoder().decode(new Uint8Array(rejected, 24, length)));
      manifest[field] = "x" + manifest[field].slice(1);
      const encoded = new TextEncoder().encode(JSON.stringify(manifest));
      assert.equal(encoded.length, length);
      new Uint8Array(rejected, 24, length).set(encoded);
      await assert.rejects(runtime.restore(rejected), /runtime|differs/);
    }
    assert.equal(runtime.getSnapshot().status, "running");
    assert.equal(runtime.getSnapshot().controlReady, true);
    assert.equal(runtime.getSnapshot().operation, null);
    assert.equal(worker.sent.length, sent);
    assert.equal(worker.terminated, false);
    assert.equal(h.fetchCount(), fetched);
    assert.equal(runtime.getSnapshot().runtimeBundle?.activeBundleId, DEFAULT_QEMU_BUNDLE_ID);
    assert.equal(runtime.getSnapshot().resourceObservation, observation, "Refusing invalid input preserves the still-live machine's observation");
  } finally { await runtime.destroy(); h.restore(); }
});

test("checkpoint capture preserves prior execution state and includes observed monitor registers", async () => {
  const h = harness({ checkpoints: true }); const runtime = new QemuRuntime();
  try {
    await runtime.boot();
    const worker = h.workers[0], before = worker.sent.length;
    const buffer = await runtime.save();
    assert.deepEqual(worker.sent.slice(before).map((message) => message.type), ["pause", "inspect-registers", "save-checkpoint", "resume"]);
    assert.equal(runtime.getSnapshot().status, "running");
    assert.equal(runtime.getSnapshot().controlReady, true);
    const checkpoint = await parseQemuCheckpoint(buffer);
    assert.equal(checkpoint.manifest.registers, "RIP=ffffffff81000100 CPL=0 HLT=1");
    assert.deepEqual(checkpoint.payload, checkpointPayload());
    await runtime.pause();
    const pausedBefore = worker.sent.length;
    await runtime.save();
    assert.deepEqual(worker.sent.slice(pausedBefore).map((message) => message.type), ["inspect-registers", "save-checkpoint"]);
    assert.equal(runtime.getSnapshot().status, "paused");
  } finally { await runtime.destroy(); h.restore(); }
});

test("a safe checkpoint refusal preserves the machine and permits a later save", async () => {
  for (const initiallyPaused of [false, true]) {
    const h = harness({ checkpoints: true }); const runtime = new QemuRuntime();
    try {
      await runtime.boot();
      if (initiallyPaused) await runtime.pause();
      const worker = h.workers[0], originalPost = worker.postMessage.bind(worker), before = worker.sent.length;
      worker.postMessage = (message) => {
        if (message.type !== "save-checkpoint") return originalPost(message);
        worker.sent.push(message);
        queueMicrotask(() => worker.emit({ type: "control-error", id: message.id, code: "checkpoint_rejected", message: "Active external transfer." }));
      };
      await assert.rejects(runtime.save(), /checkpoint could not be saved: Active external transfer/);
      assert.equal(runtime.getSnapshot().status, initiallyPaused ? "paused" : "running");
      assert.equal(runtime.getSnapshot().controlReady, !initiallyPaused);
      assert.equal(runtime.getSnapshot().operation, null);
      assert.equal(worker.terminated, false);
      assert.equal(h.workers.length, 1);
      assert.deepEqual(worker.sent.slice(before).map((message) => message.type), initiallyPaused
        ? ["inspect-registers", "save-checkpoint"]
        : ["pause", "inspect-registers", "save-checkpoint", "resume"]);
      worker.postMessage = originalPost;
      const saved = await runtime.save();
      assert.deepEqual((await parseQemuCheckpoint(saved)).payload, checkpointPayload());
      assert.equal(runtime.getSnapshot().status, initiallyPaused ? "paused" : "running");
    } finally { await runtime.destroy(); h.restore(); }
  }
});

test("cold checkpoint restore sends no guest input before explicit resume and never reruns init", async () => {
  const h = harness({ checkpoints: true }); const network = networkHarness();
  const runtime = new QemuRuntime({ networkPort: network.port, initScript: "echo must-not-rerun" });
  try {
    const buffer = await createQemuCheckpoint(checkpointPayload(), { runtimeBundleId: LEGACY_QEMU_BUNDLE_ID, mac: "02:54:00:11:22:33" });
    const restoring = runtime.restore(buffer, { paused: true });
    const worker = await h.created;
    worker.emit({ type: "output", port: 0, data: "\x1b[" });
    worker.emit({ type: "output", port: 0, data: "6n" });
    assert.equal(worker.sent.some((message) => message.type === "input"), false, "loading a checkpoint must not answer terminal queries");
    await restoring;
    worker.emit({ type: "output", port: 0, data: "\x1b[6n" });
    assert.equal(runtime.getSnapshot().status, "paused");
    assert.equal(runtime.getSnapshot().passiveRestore, true);
    assert.equal(runtime.getSnapshot().init?.status, "skipped");
    assert.equal(runtime.getSnapshot().controlReady, false);
    assert.equal(h.commands.length, 0);
    assert.equal(worker.sent.some((message) => message.type === "input" || message.type === "resume"), false);
    assert.equal(worker.sent.find((message) => message.type === "boot")?.mac, "02:54:00:11:22:33");
    assert.equal(network.readiness.includes(true), false);
    runtime.send("must-not-execute\n", 1);
    assert.equal(worker.sent.some((message) => message.type === "input"), false);
    await runtime.resume();
    assert.equal(runtime.getSnapshot().status, "running");
    assert.equal(runtime.getSnapshot().passiveRestore, false);
    assert.equal(runtime.getSnapshot().controlReady, true);
    assert.equal(runtime.getSnapshot().guestCapabilities?.architecture, "x86_64");
    assert.equal(h.commands.length, 2, "resume performs network setup and observation only");
    assert.ok(h.commands.every(({ command }) => !command.includes("must-not-rerun") && !command.includes("/etc/inittab")), "restoring must preserve the existing shell processes and init outcome");
    assert.equal(network.readiness.at(-1), true);
    const beforeQuery = worker.sent.length;
    worker.emit({ type: "output", port: 0, data: "\x1b[6n" });
    assert.deepEqual(worker.sent.slice(beforeQuery), [{ type: "input", port: 0, text: "\x1b[1;1R" }]);
  } finally { await runtime.destroy(); h.restore(); }
});

test("cancelling from an init output observer cannot send stale startup work into a replacement", async () => {
  const h = harness({ manualCommands: true });
  const runtime = new QemuRuntime({ initScript: "echo old-init" });
  let replacement: Promise<void> | undefined;
  const stop = runtime.onOutput((data) => {
    if (!data.includes("CANCEL_AFTER_INIT") || replacement) return;
    runtime.setInitScript("echo replacement-init");
    replacement = runtime.destroy().then(() => runtime.boot());
    void replacement.catch(() => undefined);
  });
  const oldBoot = runtime.boot();
  const oldRejected = assert.rejects(oldBoot, /cancelled|stopped|worker changed/i);
  try {
    (await h.waitForCommand(0)).respond();
    const init = await h.waitForCommand(1);
    assert.equal(init.command, "echo old-init");
    init.respond("CANCEL_AFTER_INIT\n");
    await oldRejected;
    await h.waitForWorker(1);
    const setup = await h.waitForCommand(2);
    assert.equal(setup.workerIndex, 1, "a cancelled generation must not enqueue its capability probe");
    assert.equal(h.commands.filter((entry) => entry.workerIndex === 0).length, 2);
    assert.match(setup.command, /stty -F \/dev\/ttyS0 sane/); setup.respond();
    const newInit = await h.waitForCommand(3);
    assert.equal(newInit.command, "echo replacement-init"); newInit.respond("replacement-init\n");
    (await h.waitForCommand(4)).respond();
    await replacement;
    assert.equal(runtime.getSnapshot().status, "running");
    assert.equal(runtime.getSnapshot().init?.output, "replacement-init\n");
    assert.equal(h.workers[0].terminated, true);
    assert.equal(h.workers[1].terminated, false);
  } finally {
    stop(); await runtime.destroy();
    await oldBoot.catch(() => undefined); await replacement?.catch(() => undefined); h.restore();
  }
});

test("a worker failure while hashing a paused restore cannot publish ready checkpoint state", async () => {
  const h = harness({ checkpoints: true }); const runtime = new QemuRuntime();
  const subtle = crypto.subtle;
  const priorDigest = Object.getOwnPropertyDescriptor(subtle, "digest");
  const digest = subtle.digest.bind(subtle);
  const hashing = deferred<void>(), release = deferred<void>();
  try {
    const buffer = await createQemuCheckpoint(checkpointPayload(), { runtimeBundleId: LEGACY_QEMU_BUNDLE_ID, mac: "02:54:00:11:22:33" });
    let intercepted = false;
    Object.defineProperty(subtle, "digest", { configurable: true, value: (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      if (!intercepted && data.byteLength === buffer.byteLength) {
        intercepted = true; hashing.resolve();
        return release.promise.then(() => digest(algorithm, data));
      }
      return digest(algorithm, data);
    } });
    const restoring = runtime.restore(buffer, { paused: true });
    const rejected = assert.rejects(restoring, /cancelled|worker|failed/i);
    await hashing.promise;
    h.workers[0].fail("fixture worker failed during checkpoint hash");
    release.resolve(); await rejected;
    assert.equal(runtime.getSnapshot().status, "error");
    assert.equal(runtime.getSnapshot().controlReady, false);
    assert.equal(runtime.getSnapshot().passiveRestore, false);
    assert.equal(h.workers[0].terminated, true);
  } finally {
    release.resolve();
    if (priorDigest) Object.defineProperty(subtle, "digest", priorDigest); else Reflect.deleteProperty(subtle, "digest");
    await runtime.destroy(); h.restore();
  }
});

test("a storage bridge failure is reported by teardown before a deliberate retry can succeed", async () => {
  const h = harness(); const runtime = new QemuRuntime();
  try {
    await runtime.boot();
    const worker = h.workers[0];
    worker.emit({ type: "disk-request", operation: "flush", slot: 0, sequence: 1, offset: 0, length: 0 });
    await tick(); await tick();
    assert.equal(runtime.getSnapshot().status, "error");
    assert.equal(worker.terminated, true);
    await assert.rejects(runtime.destroy(), /unattached disk/);
    assert.equal(runtime.getSnapshot().status, "error");
    assert.match(runtime.getSnapshot().message, /disk teardown failed/);
    await runtime.destroy();
    assert.equal(runtime.getSnapshot().status, "idle");
  } finally { await runtime.destroy(); h.restore(); }
});

test("worker failure and boot deadline interrupt an unresolved asynchronous network attachment", async () => {
  for (const reason of ["worker", "timeout"] as const) {
    const h = harness(); const attached = deferred<void>(); const network = networkHarness(attached.promise);
    const runtime = new QemuRuntime({ networkPort: network.port });
    try {
      const boot = runtime.boot();
      const rejected = assert.rejects(boot, reason === "worker" ? /fixture worker failed/ : /boot timed out/);
      const worker = await h.created;
      if (reason === "worker") worker.fail("fixture worker failed"); else h.fireTimeout(240_000);
      await rejected;
      assert.equal(worker.terminated, true);
      assert.equal(runtime.getSnapshot().status, "error");
      assert.equal(network.readiness.at(-1), false);
      attached.resolve(); await tick(); await tick();
      assert.equal(worker.sent.some((message) => message.type === "boot"), false);
      assert.ok(network.detached() > 0);
    } finally { attached.resolve(); await runtime.destroy(); h.restore(); }
  }
});

test("late attachment discards cancelled payload ownership without clearing a replacement boot", async () => {
  const h = harness(), oldAttachment = deferred<void>(), newAttachment = deferred<void>();
  const network = networkHarness(); let calls = 0;
  network.port.attachEthernet = () => (++calls === 1 ? oldAttachment.promise : newAttachment.promise);
  const budget = new QemuResourceBudget({ id: "pending-transfer-fixture", maxActiveRuntimes: 1, maxReservedWasmMiB: 2300 });
  const runtime = new QemuRuntime({ networkPort: network.port, resourceBudget: budget });
  type OwnedInputs = { buffers: Record<string, ArrayBuffer> | null; customImage?: unknown };
  const inspectOwner = () => (runtime as unknown as { pendingBootInputs: OwnedInputs | null }).pendingBootInputs;
  let replacement: Promise<void> | undefined;
  try {
    const rejected = assert.rejects(runtime.boot(), /stopped|cancelled/);
    const oldWorker = await h.created, oldOwner = inspectOwner();
    assert.ok(oldOwner?.buffers && Object.values(oldOwner.buffers).length > 0);
    await runtime.destroy(); await rejected;
    assert.equal(oldOwner.buffers, null, "The still-pending attachment must no longer own original input buffers");
    assert.equal(oldOwner.customImage, undefined);
    assert.equal(budget.getUsage().activeRuntimes, 0);
    replacement = runtime.boot();
    const newWorker = await h.waitForWorker(1), newOwner = inspectOwner();
    assert.ok(newOwner?.buffers); assert.notEqual(newOwner, oldOwner);
    oldAttachment.resolve(); await tick(); await tick();
    assert.equal(oldWorker.sent.some(message => message.type === "boot"), false);
    assert.equal(inspectOwner(), newOwner, "A late old callback cannot discard a new generation's payload");
    assert.ok(newOwner.buffers); assert.equal(budget.getUsage().activeRuntimes, 1);
    newAttachment.resolve(); await replacement;
    assert.equal(newWorker.sent.filter(message => message.type === "boot").length, 1);
    assert.equal(runtime.getSnapshot().status, "running");
    assert.equal(newOwner.buffers, null, "The page drops its transfer holder after dispatch");
    assert.equal(inspectOwner(), null);
  } finally { oldAttachment.resolve(); newAttachment.resolve(); await replacement; await runtime.destroy(); h.restore(); }
});

test("stop cancels a boot in progress and late worker output cannot resurrect the machine", async () => {
  const h = harness({ manualCommands: true }); const runtime = new QemuRuntime();
  try {
    const boot = runtime.boot(); const rejected = assert.rejects(boot, /stopped|cancelled/);
    await h.waitForCommand(0); const worker = h.workers[0];
    await runtime.destroy(); await rejected;
    assert.equal(runtime.getSnapshot().status, "idle");
    assert.equal(worker.terminated, true);
    worker.emit({ type: "output", data: "\nlate-root:~# " }); worker.fail("late stale failure");
    assert.equal(runtime.getSnapshot().status, "idle");
    assert.equal(runtime.getSnapshot().guestCapabilities, undefined);
  } finally { await runtime.destroy(); h.restore(); }
});

test("pause, resume and graceful destroy require the matching worker acknowledgment", async () => {
  const h = harness({ manualControls: true }); const network = networkHarness();
  const runtime = new QemuRuntime({ networkPort: network.port });
  try {
    await runtime.boot(); const worker = h.workers[0];
    const paused = runtime.pause(); const pause = worker.sent.at(-1)!;
    assert.equal(pause.type, "pause");
    assert.equal(runtime.getSnapshot().status, "running");
    assert.equal(runtime.getSnapshot().controlReady, false);
    assert.equal(network.readiness.at(-1), false);
    worker.emit({ type: "ack", id: (pause.id ?? 0) + 100 }); await tick();
    assert.equal(runtime.getSnapshot().status, "running");
    await assert.rejects(runtime.resume(), /current machine control/);
    worker.emit({ type: "ack", id: pause.id }); await paused;
    assert.equal(runtime.getSnapshot().status, "paused");
    const resumed = runtime.resume(); const resume = worker.sent.at(-1)!;
    assert.equal(resume.type, "resume"); assert.equal(runtime.getSnapshot().status, "paused");
    worker.emit({ type: "ack", id: resume.id }); await resumed;
    assert.equal(runtime.getSnapshot().status, "running");
    assert.equal(network.readiness.at(-1), true);
    const stopped = runtime.destroy(); await tick(); const destroy = worker.sent.at(-1)!;
    assert.equal(destroy.type, "destroy");
    assert.equal(runtime.destroy(), stopped, "teardown is idempotent while acknowledgment is pending");
    await assert.rejects(runtime.boot(), /finish stopping/);
    assert.equal(worker.terminated, false);
    worker.emit({ type: "ack", id: destroy.id }); await stopped;
    assert.equal(worker.terminated, true);
    assert.equal(runtime.getSnapshot().status, "idle");
    assert.equal(runtime.getSnapshot().guestCapabilities, undefined);
  } finally {
    if (runtime.getSnapshot().status !== "idle") { const stopped = runtime.destroy(); await tick(); h.fireTimeout(20_000); await stopped; }
    h.restore();
  }
});

test("a missing control acknowledgment fails closed and terminates the worker", async () => {
  const h = harness({ manualControls: true }); const network = networkHarness();
  const runtime = new QemuRuntime({ networkPort: network.port });
  try {
    await runtime.boot(); const paused = assert.rejects(runtime.pause(), /did not acknowledge/);
    h.fireTimeout(20_000); await paused;
    assert.equal(runtime.getSnapshot().status, "error");
    assert.equal(runtime.getSnapshot().controlReady, false);
    assert.equal(network.readiness.at(-1), false);
    assert.equal(h.workers[0].terminated, true);
  } finally { await runtime.destroy(); h.restore(); }
});

test("shared admission rejects a further boot before fetching and keeps a paused machine reserved", async () => {
  const h = harness();
  const budget = new QemuResourceBudget({ id: "one-runtime-fixture", maxActiveRuntimes: 1, maxReservedWasmMiB: 2300 });
  const first = new QemuRuntime({ resourceBudget: budget }), second = new QemuRuntime({ resourceBudget: budget });
  const idle = Array.from({ length: 20 }, () => new QemuRuntime({ resourceBudget: budget }));
  try {
    assert.equal(budget.getUsage().activeRuntimes, 0, "idle definitions do not reserve emulator memory");
    await first.boot(); await first.pause();
    const fetched = h.fetchCount();
    await assert.rejects(second.boot(), /resource budget.*full/);
    assert.equal(h.fetchCount(), fetched, "admission precedes asset allocation/download");
    assert.equal(h.workers.length, 1);
    assert.equal(first.getSnapshot().status, "paused");
    assert.equal(budget.getUsage().activeRuntimes, 1);
    await first.destroy();
    assert.equal(budget.getUsage().activeRuntimes, 0);
    await second.boot();
    assert.equal(second.getSnapshot().status, "running");
  } finally {
    await first.destroy(); await second.destroy();
    await Promise.all(idle.map((runtime) => runtime.destroy())); h.restore();
  }
});

test("cancelling a boot releases admission and stale worker callbacks cannot release a replacement", async () => {
  const h = harness({ manualCommands: true });
  const budget = new QemuResourceBudget({ id: "cancel-fixture", maxActiveRuntimes: 1, maxReservedWasmMiB: 2300 });
  const first = new QemuRuntime({ resourceBudget: budget }), second = new QemuRuntime({ resourceBudget: budget });
  try {
    const boot = first.boot(), rejected = assert.rejects(boot, /stopped|cancelled/);
    await h.waitForCommand(0);
    assert.equal(budget.getUsage().activeRuntimes, 1);
    const oldWorker = h.workers[0];
    await first.destroy(); await rejected;
    assert.equal(budget.getUsage().activeRuntimes, 0);
    const replacement = second.boot();
    (await h.waitForCommand(1)).respond();
    (await h.waitForCommand(2)).respond();
    await replacement;
    oldWorker.fail("late failure after cancellation");
    oldWorker.emit({ type: "output", data: "\nlate-root:~# " });
    assert.equal(budget.getUsage().activeRuntimes, 1);
    assert.equal(second.getSnapshot().status, "running");
  } finally { await first.destroy(); await second.destroy(); h.restore(); }
});

test("cancelled input reads keep admission until their actual settlement before any worker exists", async () => {
  const h = harness(), started = deferred<void>(), input = deferred<ArrayBuffer>();
  const budget = new QemuResourceBudget({ id: "pending-input-fixture", maxActiveRuntimes: 1, maxReservedWasmMiB: 2300 });
  let intercepted = false;
  class PendingInputRuntime extends QemuRuntime {
    protected override loadVerifiedAsset(asset: QemuAsset, signal: AbortSignal, progress: (bytes: number) => void): Promise<ArrayBuffer> {
      if (!intercepted) { intercepted = true; started.resolve(); return input.promise; }
      return super.loadVerifiedAsset(asset, signal, progress);
    }
  }
  const first = new PendingInputRuntime({ resourceBudget: budget }), second = new QemuRuntime({ resourceBudget: budget });
  let stopping: Promise<void> | undefined;
  try {
    const bootRejected = assert.rejects(first.boot(), /abort|stopped|cancelled/i);
    await started.promise;
    let stopped = false;
    stopping = first.destroy().then(() => { stopped = true; });
    await tick(); await tick(); await tick();
    assert.equal(h.workers.length, 0);
    assert.equal(stopped, false, "Abort does not imply that a non-abortable input read has settled");
    assert.equal(budget.getUsage().activeRuntimes, 1);
    const fetched = h.fetchCount();
    await assert.rejects(first.boot(), /finish stopping/);
    await assert.rejects(second.boot(), /resource budget.*full/);
    assert.equal(h.fetchCount(), fetched);
    input.resolve(lifecycleBytes.slice().buffer);
    await stopping; await bootRejected;
    assert.equal(budget.getUsage().activeRuntimes, 0);
    assert.equal(first.getSnapshot().status, "idle");
    assert.equal(h.workers.length, 0, "Late input completion cannot activate the cancelled generation");
    await second.boot();
    assert.equal(budget.getUsage().activeRuntimes, 1);
    assert.equal(second.getSnapshot().status, "running");
  } finally { input.resolve(lifecycleBytes.slice().buffer); await stopping; await first.destroy(); await second.destroy(); h.restore(); }
});

test("one failed asset aborts siblings but cannot release their pending input ownership", async () => {
  const h = harness(), started = deferred<void>(), input = deferred<ArrayBuffer>();
  const budget = new QemuResourceBudget({ id: "failed-input-fixture", maxActiveRuntimes: 1, maxReservedWasmMiB: 2300 });
  let count = 0, observedSignal: AbortSignal | undefined;
  class FailingInputRuntime extends QemuRuntime {
    protected override loadVerifiedAsset(asset: QemuAsset, signal: AbortSignal, progress: (bytes: number) => void): Promise<ArrayBuffer> {
      count++;
      if (count === 1) { observedSignal = signal; started.resolve(); return input.promise; }
      if (count === 2) return Promise.reject(new Error("fixture asset integrity failure"));
      return super.loadVerifiedAsset(asset, signal, progress);
    }
  }
  const first = new FailingInputRuntime({ resourceBudget: budget }), second = new QemuRuntime({ resourceBudget: budget });
  let bootRejected: Promise<void> | undefined;
  try {
    let completed = false;
    bootRejected = assert.rejects(first.boot(), /fixture asset integrity failure/).then(() => { completed = true; });
    await started.promise; await tick(); await tick();
    assert.equal(observedSignal?.aborted, true, "Siblings are asked to abort promptly");
    assert.equal(completed, false);
    assert.equal(budget.getUsage().activeRuntimes, 1);
    await assert.rejects(second.boot(), /resource budget.*full/);
    input.resolve(lifecycleBytes.slice().buffer);
    await bootRejected; await first.destroy();
    assert.equal(budget.getUsage().activeRuntimes, 0);
    assert.equal(h.workers.length, 0);
    await second.boot(); assert.equal(second.getSnapshot().status, "running");
  } finally { input.resolve(lifecycleBytes.slice().buffer); await bootRejected; await first.destroy(); await second.destroy(); h.restore(); }
});

test("cancelled custom Blob materialization retains admission on both late read success and failure (modeled lifecycle)", async () => {
  for (const outcome of ["resolve", "reject"] as const) {
    const image = await fixtureImage(`cancelled-custom-read-${outcome}`);
    await importMachineImage(image.blob);
    const h = harness(), started = deferred<void>(), released = deferred<void>();
    const original = Blob.prototype.arrayBuffer;
    const budget = new QemuResourceBudget({ id: `custom-read-${outcome}-fixture`, maxActiveRuntimes: 1, maxReservedWasmMiB: 2300 });
    const machine = defaultX86MachineConfiguration({ runtimeBundleId: OWNED_QEMU_BUNDLE_ID,
      image: { kind: "custom", id: image.id }, hostname: image.manifest.boot.hostname });
    const first = new QemuRuntime({ machine, resourceBudget: budget }), second = new QemuRuntime({ resourceBudget: budget });
    let intercepted = false, stopping: Promise<void> | undefined, rejected: Promise<void> | undefined;
    Blob.prototype.arrayBuffer = async function () {
      // Validation hashes at most 1 MiB slices. Intercept only the production
      // full-root materialization, never parser validation or IndexedDB itself.
      if (!intercepted && this.size === image.manifest.components.rootfs.bytes) {
        intercepted = true; started.resolve(); await released.promise;
        if (outcome === "reject") throw new Error("fixture late Blob read failure");
      }
      return original.call(this);
    };
    try {
      rejected = assert.rejects(first.boot(), /abort|cancelled|late Blob read failure/i);
      await started.promise;
      let stopped = false;
      stopping = first.destroy().then(() => { stopped = true; });
      await tick(); await tick(); await tick();
      assert.equal(stopped, false); assert.equal(h.workers.length, 0);
      assert.equal(budget.getUsage().activeRuntimes, 1);
      await assert.rejects(second.boot(), /resource budget.*full/);
      released.resolve(); await stopping; await rejected;
      assert.equal(first.getSnapshot().status, "idle", "Cancelled input errors are not misreported as failed disk teardown");
      assert.equal(budget.getUsage().activeRuntimes, 0);
      assert.equal(h.workers.length, 0);
      await second.boot(); assert.equal(second.getSnapshot().status, "running");
    } finally {
      released.resolve(); await stopping; await rejected;
      Blob.prototype.arrayBuffer = original;
      await first.destroy(); await second.destroy(); h.restore();
      await deleteMachineImage(image.id, { assertUnreferenced: () => {} });
    }
  }
});

test("checkpoint replacement retains its reservation and an idle restore cannot exceed admission", async () => {
  const h = harness({ checkpoints: true });
  const budget = new QemuResourceBudget({ id: "restore-fixture", maxActiveRuntimes: 1, maxReservedWasmMiB: 2300 });
  const first = new QemuRuntime({ resourceBudget: budget }), second = new QemuRuntime({ resourceBudget: budget });
  try {
    const checkpoint = await createQemuCheckpoint(checkpointPayload(), { runtimeBundleId: LEGACY_QEMU_BUNDLE_ID, mac: "02:54:00:11:22:33" });
    await first.boot();
    const fetched = h.fetchCount(), oldWorker = h.workers[0];
    await assert.rejects(second.restore(checkpoint, { paused: true }), /resource budget.*full/);
    assert.equal(second.getSnapshot().status, "idle");
    assert.equal(second.getSnapshot().operation, null);
    assert.equal(h.fetchCount(), fetched);
    assert.equal(oldWorker.terminated, false);
    await first.restore(checkpoint, { paused: true });
    assert.equal(oldWorker.terminated, true);
    assert.equal(first.getSnapshot().status, "paused");
    assert.equal(budget.getUsage().activeRuntimes, 1);
    await first.destroy();
    await second.restore(checkpoint, { paused: true });
    assert.equal(second.getSnapshot().status, "paused");
    assert.equal(budget.getUsage().activeRuntimes, 1);
  } finally { await first.destroy(); await second.destroy(); h.restore(); }
});

test("admission remains held until pending disk teardown settles, including failed cleanup", async () => {
  for (const fail of [false, true]) {
    const h = harness();
    const budget = new QemuResourceBudget({ id: "drain-fixture", maxActiveRuntimes: 1, maxReservedWasmMiB: 2300 });
    const first = new QemuRuntime({ resourceBudget: budget }), second = new QemuRuntime({ resourceBudget: budget });
    const release = deferred<void>();
    // Hold the existing disk-owner teardown boundary; no guest/storage success
    // is inferred from this lifecycle fixture.
    const volumes = (first as unknown as { volumes: { close: () => Promise<void> } }).volumes;
    const close = volumes.close;
    try {
      await first.boot();
      h.workers[0].emit({ type: "resource-observation", wasmMemoryBytes: 2411724800 });
      assert.ok(first.getSnapshot().resourceObservation);
      volumes.close = async () => { await release.promise; await close(); if (fail) throw new Error("fixture disk teardown failure"); };
      const stopped = first.destroy();
      const observed = fail ? assert.rejects(stopped, /disk teardown failure/) : stopped;
      await tick(); await tick(); await tick();
      assert.equal(h.workers[0].terminated, true);
      assert.equal(budget.getUsage().activeRuntimes, 1, "worker termination alone does not finish storage ownership");
      await assert.rejects(second.boot(), /resource budget.*full/);
      release.resolve(); await observed;
      assert.equal(budget.getUsage().activeRuntimes, 0);
      assert.equal(first.getSnapshot().resourceObservation, undefined, "Successful and failed completed teardown both invalidate memory samples");
      assert.equal(first.getSnapshot().runtimeBundle?.activeBundleId, null);
      await second.boot();
      assert.equal(second.getSnapshot().status, "running");
      if (fail) assert.equal(first.getSnapshot().status, "error", "failed storage cleanup remains visible");
    } finally {
      release.resolve(); volumes.close = close;
      await first.destroy(); await second.destroy(); h.restore();
    }
  }
});

test("emulator memory observations are bounded, separately labelled and invalidated on teardown", async () => {
  const h = harness(); const runtime = new QemuRuntime();
  try {
    await runtime.boot();
    const worker = h.workers[0];
    assert.equal(runtime.getSnapshot().resourceObservation, undefined, "no value is invented when a worker has not reported its buffer");
    worker.emit({ type: "resource-observation", wasmMemoryBytes: 2411724800 });
    const observation = runtime.getSnapshot().resourceObservation!;
    assert.equal(observation.source, "emulator-memory-buffer");
    assert.equal(observation.observedWasmMemoryBytes, 2411724800);
    assert.equal(observation.configuredGuestMemoryMiB, 512);
    assert.equal(observation.configuredTranslationCacheMiB, 500);
    assert.equal(observation.accountedWasmReservationMiB, 2300);
    assert.equal(observation.budgetId, "small-x86_64-two-active-v1");
    assert.ok(Number.isSafeInteger(observation.sampledAt));
    assert.ok(Object.isFrozen(observation));
    await runtime.destroy();
    assert.equal(runtime.getSnapshot().resourceObservation, undefined);
    worker.emit({ type: "resource-observation", wasmMemoryBytes: 2411724800 });
    assert.equal(runtime.getSnapshot().resourceObservation, undefined, "a terminated generation cannot republish measurements");
  } finally { await runtime.destroy(); h.restore(); }
});

test("paused resource inspection returns an identified immutable sample without guest execution or retained live state", async () => {
  const h = harness({ checkpoints: true });
  const runtime = new QemuRuntime({ defaultBootBundleId: OWNED_QEMU_BUNDLE_ID });
  try {
    await assert.rejects(runtime.inspectResources(), /Pause the machine/);
    await runtime.boot();
    const beforeRefusal = h.workers[0].sent.length;
    await assert.rejects(runtime.inspectResources(), /Pause the machine/);
    assert.equal(h.workers[0].sent.length, beforeRefusal);
    await runtime.pause();
    const snapshot = runtime.getSnapshot(), before = h.workers[0].sent.length, start = Date.now();
    const observed = await runtime.inspectResources();
    assert.deepEqual(h.workers[0].sent.slice(before).map(message => message.type), ["inspect-resources"]);
    assert.equal(runtime.getSnapshot(), snapshot, "A one-shot query must not publish a stale live snapshot field.");
    assert.equal(observed.runtimeBundleId, OWNED_QEMU_BUNDLE_ID);
    assert.equal(observed.source, "qemu-hmp-info-jit");
    assert.equal(observed.cpuState, "paused");
    assert.equal(observed.configuredTranslationCacheMiB, 500);
    assert.equal(observed.excludedMemory, "engine-native-compiled-wasm-and-process-overhead");
    assert.ok(observed.sampledAt >= start && observed.sampledAt <= Date.now());
    assert.deepEqual(observed.translationStats, QEMU_JIT_FIXTURE_STATS);
    assert.equal(observed.monitorText, QEMU_JIT_FIXTURE_TEXT);
    assert.ok(Object.isFrozen(observed)); assert.ok(Object.isFrozen(observed.translationStats));
    const saving = runtime.save();
    await assert.rejects(runtime.inspectResources(), /current machine operation/);
    await saving;
    const legacy = await createQemuCheckpoint(checkpointPayload(), { runtimeBundleId: LEGACY_QEMU_BUNDLE_ID, mac: "02:54:00:11:22:33" });
    await runtime.restore(legacy, { paused: true });
    const restoredWorker = h.workers.at(-1)!;
    assert.equal(runtime.getSnapshot().passiveRestore, true);
    assert.equal((await runtime.inspectResources()).runtimeBundleId, LEGACY_QEMU_BUNDLE_ID);
    assert.equal(runtime.getSnapshot().passiveRestore, true);
    assert.equal(restoredWorker.sent.some(message => message.type === "input" || message.type === "resume"), false);
  } finally { await runtime.destroy(); h.restore(); }
});

test("resource replies must match the active request and agree with their bounded monitor evidence", async () => {
  const valid = { translationStats: { ...QEMU_JIT_FIXTURE_STATS }, monitorText: QEMU_JIT_FIXTURE_TEXT };
  for (const resources of [
    undefined,
    { ...valid, extra: true },
    { ...valid, translationStats: { ...valid.translationStats, generatedCodeUsedBytes: 1 } },
    { ...valid, translationStats: { ...valid.translationStats, hidden: 0 } },
    { ...valid, monitorText: "x".repeat(65_537) },
    { translationStats: { ...valid.translationStats, generatedCodeCapacityBytes: 536870912 },
      monitorText: valid.monitorText.replace("/524221440", "/536870912") },
  ]) {
    const h = harness({ manualInspections: true }); const runtime = new QemuRuntime();
    try {
      await runtime.boot(); await runtime.pause();
      const worker = h.workers[0];
      let settled = false;
      const sample = runtime.inspectResources().finally(() => { settled = true; });
      const rejected = assert.rejects(sample, /invalid translation-resource|translation-buffer statistics/);
      const request = worker.sent.at(-1)!;
      worker.emit({ type: "ack", id: request.id! + 100, resources: valid });
      await tick(); assert.equal(settled, false, "An unrelated acknowledgment cannot supply a resource sample.");
      worker.emit({ type: "ack", id: request.id, resources });
      await rejected;
      assert.equal(runtime.getSnapshot().status, "error"); assert.equal(worker.terminated, true);
    } finally { await runtime.destroy(); h.restore(); }
  }
});

test("resource inspection excludes concurrent controls and discards a stopped generation", async () => {
  const h = harness({ manualInspections: true }); const runtime = new QemuRuntime();
  try {
    await runtime.boot(); await runtime.pause();
    const worker = h.workers[0], late = worker.onmessage;
    const sample = runtime.inspectResources(), rejected = assert.rejects(sample, /stopped|cancelled/);
    const request = worker.sent.at(-1)!;
    await assert.rejects(runtime.inspectResources(), /current machine operation/);
    await assert.rejects(runtime.resume(), /current machine control/);
    await runtime.destroy(); await rejected;
    await runtime.boot();
    late?.({ data: { type: "ack", id: request.id,
      resources: { translationStats: QEMU_JIT_FIXTURE_STATS, monitorText: QEMU_JIT_FIXTURE_TEXT } } } as MessageEvent);
    assert.equal(runtime.getSnapshot().status, "running");
    assert.equal(h.workers[1].sent.some(message => message.type === "inspect-resources"), false);
  } finally { await runtime.destroy(); h.restore(); }
});

test("an unacknowledged resource query keeps the existing bounded control deadline", async () => {
  const h = harness({ manualInspections: true }); const runtime = new QemuRuntime();
  try {
    await runtime.boot(); await runtime.pause();
    const rejected = assert.rejects(runtime.inspectResources(), /did not acknowledge/);
    h.fireTimeout(20_000); await rejected;
    assert.equal(runtime.getSnapshot().status, "error");
    assert.equal(h.workers[0].terminated, true);
  } finally { await runtime.destroy(); h.restore(); }
});

test("invalid or under-accounted emulator memory fails closed and returns its lease after teardown", async () => {
  for (const bytes of [0, 1, 2411724800 + 65536, NaN, "2411724800"]) {
    const h = harness();
    const budget = new QemuResourceBudget({ id: "memory-event-fixture", maxActiveRuntimes: 1, maxReservedWasmMiB: 2300 });
    const runtime = new QemuRuntime({ resourceBudget: budget });
    try {
      await runtime.boot();
      h.workers[0].emit({ type: "resource-observation", wasmMemoryBytes: bytes });
      assert.equal(runtime.getSnapshot().status, "error");
      assert.match(runtime.getSnapshot().message, /outside its admitted/);
      assert.equal(h.workers[0].terminated, true);
      assert.equal(runtime.getSnapshot().resourceObservation, undefined);
      await runtime.destroy();
      assert.equal(budget.getUsage().activeRuntimes, 0);
    } finally { await runtime.destroy(); h.restore(); }
  }
});

test("a direct retry after worker failure cannot observe a cleared drain with its stale admission lease", async () => {
  for (let offset = 0; offset < 8; offset++) {
    const h = harness();
    const budget = new QemuResourceBudget({ id: "drain-order-fixture", maxActiveRuntimes: 1, maxReservedWasmMiB: 2300 });
    const runtime = new QemuRuntime({ resourceBudget: budget });
    const volumes = (runtime as unknown as { volumes: { close: () => Promise<void> } }).volumes;
    const close = volumes.close, release = deferred<void>();
    try {
      await runtime.boot();
      volumes.close = () => release.promise;
      h.workers[0].fail("fixture worker failure");
      release.resolve();
      // Exercise the promise reactions around disk close, guard clearing and
      // lease release. Formerly offsets 2..4 falsely rejected a free host slot.
      for (let step = 0; step < offset; step++) await Promise.resolve();
      try { await runtime.boot(); }
      catch (error) {
        assert.match((error as Error).message, /Wait for the current data-disk operation/);
        assert.doesNotMatch((error as Error).message, /resource budget/);
      }
    } finally {
      release.resolve(); volumes.close = close;
      await runtime.destroy();
      assert.equal(budget.getUsage().activeRuntimes, 0);
      h.restore();
    }
  }
});

test("reset waits for asynchronous native termination before replacement or admission reuse", async () => {
  const h = harness();
  const budget = new QemuResourceBudget({ id: "native-reset-fixture", maxActiveRuntimes: 1, maxReservedWasmMiB: 2300 });
  const runtime = new QemuRuntime({ resourceBudget: budget }), other = new QemuRuntime({ resourceBudget: budget });
  const requested = deferred<void>(), terminated = deferred<void>();
  let resetting: Promise<void> | undefined;
  try {
    await runtime.boot();
    const oldWorker = h.workers[0], staleMessage = oldWorker.onmessage;
    const fetched = h.fetchCount();
    oldWorker.terminate = () => { oldWorker.terminated = true; requested.resolve(); return terminated.promise; };
    let completed = false;
    resetting = runtime.reset().then(() => { completed = true; });
    await requested.promise;
    for (let step = 0; step < 12; step++) await tick();
    assert.equal(completed, false, "Reset cannot finish while the prior native worker still owns execution resources");
    assert.equal(h.fetchCount(), fetched, "Replacement download/admission must wait for native termination");
    assert.equal(h.workers.length, 1, "A replacement must not start while native termination is pending");
    assert.equal(budget.getUsage().activeRuntimes, 1);
    await assert.rejects(other.boot(), /resource budget.*full/);
    assert.equal(h.workers.length, 1);
    terminated.resolve();
    await resetting;
    assert.equal(h.workers.length, 2);
    const current = runtime.getSnapshot();
    staleMessage?.({ data: { type: "output", data: "\nstale-root:~# " } } as MessageEvent);
    oldWorker.fail("stale native worker failure");
    assert.equal(runtime.getSnapshot(), current, "Old events cannot mutate the replacement generation");
    assert.equal(budget.getUsage().activeRuntimes, 1, "Old completion cannot release the replacement reservation");
  } finally {
    terminated.resolve(); await resetting?.catch(() => undefined); await runtime.destroy(); await other.destroy(); h.restore();
  }
});

test("checkpoint replacement waits for native termination while retaining its existing reservation", async () => {
  const h = harness({ checkpoints: true });
  const budget = new QemuResourceBudget({ id: "native-restore-fixture", maxActiveRuntimes: 1, maxReservedWasmMiB: 2300 });
  const runtime = new QemuRuntime({ resourceBudget: budget }), other = new QemuRuntime({ resourceBudget: budget });
  const requested = deferred<void>(), terminated = deferred<void>();
  let restoring: Promise<void> | undefined;
  try {
    const checkpoint = await createQemuCheckpoint(checkpointPayload(), { runtimeBundleId: LEGACY_QEMU_BUNDLE_ID, mac: "02:54:00:11:22:33" });
    await runtime.boot();
    const oldWorker = h.workers[0];
    const fetched = h.fetchCount();
    oldWorker.terminate = () => { oldWorker.terminated = true; requested.resolve(); return terminated.promise; };
    restoring = runtime.restore(checkpoint, { paused: true });
    await requested.promise;
    for (let step = 0; step < 12; step++) await tick();
    assert.equal(h.fetchCount(), fetched, "Checkpoint replacement cannot allocate/download before native termination");
    assert.equal(h.workers.length, 1);
    assert.equal(budget.getUsage().activeRuntimes, 1);
    await assert.rejects(other.boot(), /resource budget.*full/);
    terminated.resolve(); await restoring;
    assert.equal(h.workers.length, 2);
    assert.equal(runtime.getSnapshot().status, "paused");
    assert.equal(runtime.getSnapshot().passiveRestore, true);
    assert.equal(h.workers[1].sent.some(message => message.type === "input" || message.type === "resume"), false);
    assert.equal(budget.getUsage().activeRuntimes, 1);
  } finally {
    terminated.resolve(); await restoring?.catch(() => undefined); await runtime.destroy(); await other.destroy(); h.restore();
  }
});

test("teardown waits for native termination and storage settlement in either completion order", async () => {
  for (const firstCompletion of ["worker", "storage"] as const) {
    const h = harness();
    const budget = new QemuResourceBudget({ id: `native-drain-${firstCompletion}-fixture`, maxActiveRuntimes: 1, maxReservedWasmMiB: 2300 });
    const runtime = new QemuRuntime({ resourceBudget: budget }), other = new QemuRuntime({ resourceBudget: budget });
    const workerDone = deferred<void>(), storageDone = deferred<void>(), requested = deferred<void>();
    const volumes = (runtime as unknown as { volumes: { close: () => Promise<void> } }).volumes;
    const close = volumes.close;
    try {
      await runtime.boot();
      const worker = h.workers[0];
      worker.terminate = () => { worker.terminated = true; requested.resolve(); return workerDone.promise; };
      volumes.close = async () => { await storageDone.promise; await close(); };
      let completed = false;
      const stopping = runtime.destroy().then(() => { completed = true; });
      await requested.promise;
      (firstCompletion === "worker" ? workerDone : storageDone).resolve();
      for (let step = 0; step < 12; step++) await tick();
      assert.equal(completed, false);
      assert.equal(budget.getUsage().activeRuntimes, 1);
      await assert.rejects(other.boot(), /resource budget.*full/);
      workerDone.resolve(); storageDone.resolve(); await stopping;
      assert.equal(runtime.getSnapshot().status, "idle");
      assert.equal(budget.getUsage().activeRuntimes, 0);
      await other.boot();
    } finally {
      workerDone.resolve(); storageDone.resolve(); volumes.close = close;
      await runtime.destroy(); await other.destroy(); h.restore();
    }
  }
});

test("unconfirmed native termination fails closed without releasing or reusing admission", async () => {
  for (const failureMode of ["throw", "reject"] as const) {
    const h = harness();
    const budget = new QemuResourceBudget({ id: `native-${failureMode}-fixture`, maxActiveRuntimes: 1, maxReservedWasmMiB: 2300 });
    const runtime = new QemuRuntime({ resourceBudget: budget }), other = new QemuRuntime({ resourceBudget: budget });
    const nativeFailure = new Error(`fixture native termination ${failureMode}`);
    let storageClosed = 0;
    const volumes = (runtime as unknown as { volumes: { close: () => Promise<void> } }).volumes;
    const close = volumes.close;
    try {
      await runtime.boot();
      const worker = h.workers[0];
      worker.terminate = () => { worker.terminated = true; if (failureMode === "throw") throw nativeFailure; return Promise.reject(nativeFailure); };
      volumes.close = async () => { storageClosed++; await close(); };
      await assert.rejects(runtime.destroy(), /native termination/);
      assert.equal(storageClosed, 1, "Accepted storage teardown must still settle after termination fails");
      assert.equal(runtime.getSnapshot().status, "error");
      assert.match(runtime.getSnapshot().message, /worker teardown|worker termination/);
      assert.equal(runtime.getSnapshot().controlReady, false);
      assert.equal(budget.getUsage().activeRuntimes, 1, "An unconfirmed native owner keeps its reservation");
      await assert.rejects(runtime.boot(), /worker termination|worker.*finish stopping/);
      await assert.rejects(runtime.destroy(), /native termination/);
      await assert.rejects(other.boot(), /resource budget.*full/);
      assert.equal(h.workers.length, 1);
      assert.equal(budget.getUsage().activeRuntimes, 1);
    } finally {
      volumes.close = close;
      await runtime.destroy().catch(() => undefined); await other.destroy(); h.restore();
    }
  }
});

test("a disk teardown failure cannot skip pending native termination and both failures remain visible", async () => {
  const h = harness();
  const budget = new QemuResourceBudget({ id: "native-and-storage-failure-fixture", maxActiveRuntimes: 1, maxReservedWasmMiB: 2300 });
  const runtime = new QemuRuntime({ resourceBudget: budget });
  const requested = deferred<void>(), nativeDone = deferred<void>();
  const nativeFailure = new Error("fixture native ownership unknown"), diskFailure = new Error("fixture commit failed");
  const volumes = (runtime as unknown as { volumes: { close: () => Promise<void> } }).volumes;
  const close = volumes.close;
  try {
    await runtime.boot();
    const worker = h.workers[0];
    worker.terminate = () => { worker.terminated = true; requested.resolve(); return nativeDone.promise; };
    volumes.close = async () => { await close(); throw diskFailure; };
    let settled = false;
    const stopping = runtime.destroy().finally(() => { settled = true; });
    const rejected = assert.rejects(stopping, error => error === nativeFailure);
    await requested.promise;
    for (let step = 0; step < 12; step++) await tick();
    assert.equal(settled, false, "A failed disk must not end the wait for an existing native owner");
    assert.equal(budget.getUsage().activeRuntimes, 1);
    nativeDone.reject(nativeFailure); await rejected;
    assert.match(runtime.getSnapshot().message, /fixture native ownership unknown/);
    assert.match(runtime.getSnapshot().message, /Disk teardown also failed: fixture commit failed/);
    assert.equal(budget.getUsage().activeRuntimes, 1);
  } finally {
    nativeDone.reject(nativeFailure); volumes.close = close;
    await runtime.destroy().catch(() => undefined); h.restore();
  }
});
