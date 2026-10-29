// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { startQemu } from "../../public/runtime/qemu/engine.js";
import type { MonitorDeviceOperations } from "../../public/runtime/qemu/monitor.js";
import { QEMU_JIT_FIXTURE_TEXT, QEMU_JIT_FIXTURE_STATS } from "./fixtures/qemu-jit.ts";
import { defaultX86MachineConfiguration } from "../../public/runtime/qemu/machine-config.js";
import { OWNED_QEMU_BUNDLE_ID, SERVER_QEMU_BUNDLE_ID } from "../../public/runtime/qemu/catalog.js";

test("checkpoint preflight and detached payload refusal preserve the healthy engine", async () => {
  const nativeSocket = globalThis.WebSocket;
  const events: Record<string, unknown>[] = [], commands: string[] = [];
  let monitor!: MonitorDeviceOperations, state = "running", terminated = 0;
  let pty!: { readable: boolean };
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const files = new Map<string, { contents: Uint8Array; usedBytes: number; node_ops: Record<string, unknown>; stream_ops: Record<string, unknown> }>();
  const filesystem = {
    ErrnoError: class extends Error { errno: number; constructor(errno: number) { super(String(errno)); this.errno = errno; } },
    makedev: (major: number, minor: number) => major * 256 + minor,
    registerDevice(device: number, operations: MonitorDeviceOperations) { if (device === 81 * 256) monitor = operations; },
    mkdirTree() {}, mkdev() {},
    writeFile(path: string, bytes: Uint8Array) {
      files.set(path, { contents: bytes.slice(), usedBytes: bytes.length, node_ops: { setattr() {} }, stream_ops: { write() {}, allocate() {} } });
    },
    lookupPath(path: string) { return { node: files.get(path)! }; },
    readFile(path: string) { return files.get(path)!.contents.slice(); },
  };
  filesystem.writeFile("/pack-initramfs/initramfs-virt", new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0]));
  const assets = Object.fromEntries(["module", "wasm", "kernel", "initramfs", "rom", "rootfs"].map((name) => [name, new ArrayBuffer(0)]));
  const packages = Object.fromEntries(["kernel", "initramfs", "rom", "rootfs"].map((name) => [name, { bytes: 0, metadata: { files: [] } }]));
  const engine = await startQemu({ assets, manifest: { packages }, mac: "02:11:22:33:44:55" }, {
    emit: (message) => events.push(message), pthreadUrl: "https://example.invalid/pthread.js",
    async loadModule() {
      return { url: "https://example.invalid/qemu.js", async factory(options) {
        pty = options.pty as typeof pty;
        const module = { FS: filesystem, HEAPU8: new Uint8Array(65_536), PThread: { terminateAllThreads() { terminated++; } } };
        for (const preRun of options.preRun as ((module: unknown) => void)[]) preRun(module);
        const greeting = encoder.encode("QEMU 8.2.0 monitor - type 'help' for more information\r\n(qemu) ");
        monitor.write({}, greeting, 0, greeting.length);
        return module;
      } };
    },
  });
  const timer = setInterval(() => {
    const buffer = new Uint8Array(4096);
    let count: number;
    try { count = monitor.read({}, buffer, 0, buffer.length); } catch { return; }
    if (!count) return;
    const command = decoder.decode(buffer.subarray(0, count)).trimEnd(); commands.push(command);
    let response = "";
    if (command === "stop") state = "paused";
    else if (command === "cont") state = "running";
    else if (command === "info status") response = `VM status: ${state}\r\n`;
    else if (command === "info jit") response = QEMU_JIT_FIXTURE_TEXT.replaceAll("\n", "\r\n") + "\r\n";
    else if (command.startsWith("drive_add ")) response = "OK\r\n";
    const bytes = encoder.encode(command + "\r\n" + response + "(qemu) ");
    monitor.write({}, bytes, 0, bytes.length);
  }, 1);
  try {
    assert.deepEqual(events.find((event) => event.type === "resource-observation"), { type: "resource-observation", wasmMemoryBytes: 65_536 }, "the fixture reports its actual heap buffer, not a configured guest size");
    const rejected = (error: unknown) => error instanceof Error && "code" in error && error.code === "checkpoint_rejected";
    await assert.rejects(engine.saveCheckpoint(), rejected);
    assert.deepEqual(commands, ["info status"]); assert.equal(state, "running");
    assert.equal(terminated, 0); assert.equal(events.filter((event) => event.type === "error").length, 0);
    await assert.rejects(engine.inspectResources(), /Pause the machine/);
    assert.equal(commands.at(-1), "info status");
    assert.equal(commands.includes("info jit"), false, "Running CPUs cannot trigger a translation query.");
    await engine.pause();
    const inspectionStart = commands.length;
    assert.deepEqual(await engine.inspectResources(), { translationStats: QEMU_JIT_FIXTURE_STATS, monitorText: QEMU_JIT_FIXTURE_TEXT });
    assert.deepEqual(commands.slice(inspectionStart), ["info status", "info jit"]);
    assert.equal(state, "paused"); assert.equal(pty.readable, false, "Passive inspection must not send guest console input.");
    // The fake monitor acknowledges save without adding a snapshot. This
    // deliberately forces validation to fail after the private drive detached.
    await assert.rejects(engine.saveCheckpoint(), rejected);
    assert.equal(commands.at(-1), "drive_del checkpoint"); assert.equal(state, "paused");
    assert.equal(terminated, 0); assert.equal(events.filter((event) => event.type === "error").length, 0);
    await engine.resume(); assert.equal(state, "running");
  } finally { clearInterval(timer); await engine.destroy(); globalThis.WebSocket = nativeSocket; }
  assert.equal(terminated, 1);
});

test("startup replaces xterm-pty's blocking empty read and poll before console use", async () => {
  const nativeSocket = globalThis.WebSocket;
  class ErrnoError extends Error {
    errno: number;
    constructor(errno: number) { super(String(errno)); this.errno = errno; }
  }
  let originalReads = 0, specialWaits = 0, terminated = 0;
  type Operations = {
    read(stream: object, buffer: Uint8Array, offset: number, length: number): number;
    poll(stream: object, timeout: number): number;
  };
  let operations!: Operations;
  const assets = Object.fromEntries(["module", "wasm", "kernel", "initramfs", "rom", "rootfs"].map(name => [name, new ArrayBuffer(0)]));
  const engine = await startQemu({ assets, manifest: { packages: {} }, mac: "02:11:22:33:44:55" }, {
    emit() {}, pthreadUrl: "https://example.invalid/pthread.js",
    async loadModule() {
      return { url: "https://example.invalid/qemu.js", async factory(options) {
        const pty = options.pty as { readable: boolean; read(length: number): Uint8Array };
        operations = {
          read(_stream, buffer, offset, length) {
            originalReads++;
            const bytes = pty.read(length);
            if (length && !bytes.length) { specialWaits++; throw new ErrnoError(1006); }
            buffer.set(bytes, offset); return bytes.length;
          },
          poll(_stream, timeout) {
            if (!pty.readable && timeout) { specialWaits++; throw new ErrnoError(1006); }
            return pty.readable ? 5 : 4;
          },
        };
        const module = { FS: { ErrnoError }, TTY: { stream_ops: operations },
          PThread: { terminateAllThreads() { terminated++; } } };
        // Exercise the real engine startup hook; no fake guest runs in this fixture.
        (options.onRuntimeInitialized as (this: typeof module) => void).call(module);
        return module;
      } };
    },
  });
  try {
    for (const timeout of [-1, 0, 50]) assert.equal(operations.poll({}, timeout), 4);
    const buffer = new Uint8Array(8).fill(238);
    assert.throws(() => operations.read({}, buffer, 2, 4), error => error instanceof ErrnoError && error.errno === 6);
    assert.equal(originalReads, 0, "Empty positive-length reads must not enter xterm-pty's special wait path");
    assert.equal(operations.read({}, buffer, 2, 0), 0);
    engine.input("abc");
    assert.equal(operations.poll({}, -1), 5);
    assert.equal(operations.read({}, buffer, 2, 2), 2);
    assert.deepEqual([...buffer], [238, 238, 97, 98, 238, 238, 238, 238]);
    assert.equal(operations.poll({}, -1), 5);
    assert.equal(operations.read({}, buffer, 5, 3), 1);
    assert.equal(buffer[5], 99);
    assert.equal(operations.poll({}, -1), 4);
    assert.throws(() => operations.read({}, buffer, 0, 1), error => error instanceof ErrnoError && error.errno === 6);
    assert.equal(specialWaits, 0, "Neither ordinary empty reads nor polling may emit xterm-pty errno1006");
  } finally { await engine.destroy(); globalThis.WebSocket = nativeSocket; }
  assert.equal(terminated, 1);
});

test("fixed hardware selection preserves small arguments and makes the worker CPU/RAM/APIC contract concrete", async () => {
  const nativeSocket = globalThis.WebSocket;
  const mac = "02:11:22:33:44:55";
  const assets = Object.fromEntries(["module", "wasm", "kernel", "initramfs", "rom", "rootfs"].map(name => [name, new ArrayBuffer(0)]));
  for (const presetId of [undefined, "small", "worker"] as const) {
    let captured: string[] = [];
    const machine = presetId ? defaultX86MachineConfiguration({ presetId, runtimeBundleId: OWNED_QEMU_BUNDLE_ID, mac }) : undefined;
    const engine = await startQemu({ assets, manifest: { packages: {} }, mac, runtimeBundleId: OWNED_QEMU_BUNDLE_ID, ...(machine ? { machine } : {}) }, {
      emit() {}, pthreadUrl: "https://example.invalid/pthread.js",
      async loadModule() {
        return { url: "https://example.invalid/qemu.js", async factory(options) {
          captured = options.arguments as string[];
          // This fixture checks adapter arguments and checkpoint refusal only.
          // It does not instantiate Wasm, allocate a guest, or run Linux.
          return { PThread: { terminateAllThreads() {} } };
        } };
      },
    });
    try {
      assert.equal(captured[captured.indexOf("-m") + 1], presetId === "worker" ? "1024M" : "512M");
      assert.equal(captured[captured.indexOf("-accel") + 1], "tcg,tb-size=500");
      assert.equal(captured.includes("-object"), false, "Small and worker keep their original single RAM block.");
      assert.equal(captured.includes("-numa"), false, "Only the separately identified server introduces the fixed split topology.");
      if (presetId === "worker") {
        assert.equal(captured[captured.indexOf("-smp") + 1], "1");
        assert.equal(captured[captured.indexOf("-append") + 1].includes("noapic"), false);
        await assert.rejects(engine.saveCheckpoint(), /RAM checkpoints are unsupported/);
      } else {
        assert.equal(captured.includes("-smp"), false);
        assert.equal(captured[captured.indexOf("-append") + 1], "console=ttyS0 root=/dev/vda noautodetect hostname=terrarium clocksource=tsc noapic 8250.nr_uarts=4");
      }
    } finally { await engine.destroy(); globalThis.WebSocket = nativeSocket; }
  }
});

test("changed machine identities and larger-profile checkpoint restore fail before loading code", async () => {
  const mac = "02:11:22:33:44:55";
  const machine = defaultX86MachineConfiguration({ presetId: "worker", runtimeBundleId: OWNED_QEMU_BUNDLE_ID, mac });
  let loaded = 0;
  const dependencies = {
    emit() {}, pthreadUrl: "https://example.invalid/pthread.js",
    async loadModule() { loaded++; throw new Error("Module must not load."); },
  };
  await assert.rejects(startQemu({ machine, mac: "02:11:22:33:44:56", runtimeBundleId: OWNED_QEMU_BUNDLE_ID }, dependencies), /runtime and NIC identity/);
  await assert.rejects(startQemu({ machine, mac, runtimeBundleId: OWNED_QEMU_BUNDLE_ID, checkpoint: new ArrayBuffer(0) }, dependencies), /RAM checkpoints are unsupported/);
  assert.equal(loaded, 0);
});

test("the identified server fixes two bounded RAM backends and two CPUs without exposing arbitrary topology", async () => {
  const nativeSocket = globalThis.WebSocket;
  const mac = "02:11:22:33:44:55";
  const machine = defaultX86MachineConfiguration({ presetId: "server", runtimeBundleId: SERVER_QEMU_BUNDLE_ID, mac });
  const assets = Object.fromEntries(["module", "wasm", "kernel", "initramfs", "rom", "rootfs"].map(name => [name, new ArrayBuffer(0)]));
  let captured: string[] = [];
  const engine = await startQemu({ assets, manifest: { packages: {} }, mac, runtimeBundleId: SERVER_QEMU_BUNDLE_ID, machine }, {
    emit() {}, pthreadUrl: "https://example.invalid/pthread.js",
    async loadModule() {
      return { url: "https://example.invalid/qemu.js", async factory(options) {
        captured = options.arguments as string[];
        // Adapter fixture only: no Wasm, guest RAM or CPU execution occurs.
        return { PThread: { terminateAllThreads() {} } };
      } };
    },
  });
  try {
    const argumentsFor = (flag: string) => captured.flatMap((value, index) => value === flag ? [captured[index + 1]] : []);
    assert.deepEqual(argumentsFor("-m"), ["2048M"]);
    assert.deepEqual(argumentsFor("-smp"), ["2,sockets=2,cores=1,threads=1,maxcpus=2"]);
    assert.deepEqual(argumentsFor("-object"), ["memory-backend-ram,id=terrarium-ram0,size=1024M", "memory-backend-ram,id=terrarium-ram1,size=1024M"]);
    assert.deepEqual(argumentsFor("-numa"), ["node,nodeid=0,cpus=0,memdev=terrarium-ram0", "node,nodeid=1,cpus=1,memdev=terrarium-ram1"]);
    assert.equal(argumentsFor("-append")[0].includes("noapic"), false);
    await assert.rejects(engine.saveCheckpoint(), /RAM checkpoints are unsupported/);
  } finally { await engine.destroy(); globalThis.WebSocket = nativeSocket; }
});
