// SPDX-License-Identifier: Apache-2.0
// Run: node --experimental-strip-types scripts/smoke-rv64.mjs
// This executes the shipped TinyEMU worker and real RV64 Linux in Node's
// WebAssembly engine. Guest assets are fetched into memory, never written out.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { V86 } from "v86";
import {
  TINYEMU_GUEST_ASSETS,
  TINYEMU_WASM,
} from "../src/lib/tinyemu-assets.ts";
import {
  commandFrame,
  CommandFrameReader,
  recoveryFrame,
  hasRecoveryFrame,
} from "../src/lib/command-protocol.ts";
import { TinyEmuRuntime } from "../src/lib/tinyemu-runtime.ts";
import { CommandRunner } from "../src/lib/command-runner.ts";
import { VirtualNetwork } from "../src/lib/network.ts";

const runtimeRoot = new URL("../public/runtime/tinyemu/", import.meta.url);
const [workerSource, emulatorSource, wasm] = await Promise.all([
  readFile(new URL("worker.js", runtimeRoot), "utf8"),
  readFile(new URL("riscvemu64-wasm.js", runtimeRoot), "utf8"),
  readFile(new URL("riscvemu64-wasm.wasm", runtimeRoot)),
]);
function verify(bytes, asset) {
  assert.equal(bytes.byteLength, asset.bytes, `${asset.name}: length`);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    asset.sha256,
    `${asset.name}: SHA-256`,
  );
  return Uint8Array.from(bytes).buffer;
}
const assets = Object.fromEntries(
  await Promise.all(
    Object.entries(TINYEMU_GUEST_ASSETS).map(async ([name, asset]) => {
      const response = await fetch(asset.url, {
        signal: AbortSignal.timeout(60_000),
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok)
        throw new Error(`${asset.name}: HTTP ${response.status}`);
      return [
        name,
        verify(new Uint8Array(await response.arrayBuffer()), asset),
      ];
    }),
  ),
);
assets.wasm = verify(wasm, TINYEMU_WASM);
console.log(
  "Verified exact official TinyEMU assets from the pinned CORS mirror.",
);

class RealWorker {
  listeners = new Set();
  timers = new Set();
  output = "";
  receiver = null;
  network = null;
  error = null;
  onmessage = null;
  constructor() {
    const schedule = (callback, delay, ...args) => {
      const id = setTimeout(() => {
        this.timers.delete(id);
        try {
          callback(...args);
        } catch (error) {
          this.error = error;
        }
      }, delay);
      this.timers.add(id);
      return id;
    };
    const context = vm.createContext({
      console,
      WebAssembly,
      TextEncoder,
      TextDecoder,
      URL,
      performance,
      Date,
      setTimeout: schedule,
      clearTimeout: (id) => {
        clearTimeout(id);
        this.timers.delete(id);
      },
      location: { href: "https://terrarium.invalid/worker.js" },
      addEventListener: (type, listener) => {
        if (type === "message") this.receiver = listener;
      },
      postMessage: (message) => {
        if (message.type === "output")
          this.output = (this.output + message.data).slice(-262_144);
        if (message.type === "error") this.error = new Error(message.message);
        if (message.type === "network")
          this.network?.(new Uint8Array(message.frame));
        for (const listener of [...this.listeners]) listener(message);
        this.onmessage?.({ data: structuredClone(message) });
      },
      importScripts: (file) => {
        assert.equal(file, "riscvemu64-wasm.js");
        vm.runInContext(emulatorSource, context, { filename: file });
      },
    });
    context.self = context;
    vm.runInContext(workerSource, context, { filename: "worker.js" });
  }
  post(message) {
    this.receiver({ data: message });
  }
  postMessage(message) {
    this.post(message);
  }
  terminate() {
    this.destroy();
  }
  input(text) {
    this.post({ type: "input", text });
  }
  wait(test, timeout = 15_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          finish(
            this.error ??
              new Error(`Timed out. Last output: ${this.output.slice(-700)}`),
          ),
        timeout,
      );
      const listener = (message) => {
        if (this.error) return finish(this.error);
        const result = test(message);
        if (result) finish(null, result);
      };
      const finish = (error, result) => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        if (error) reject(error);
        else resolve(result);
      };
      this.listeners.add(listener);
    });
  }
  async boot() {
    const ready = this.wait(
      () => /(?:^|\n)[^\n]{0,80}# $/.test(this.output.replace(/\r/g, "")),
      30_000,
    );
    this.post({ type: "boot", ...assets, network: true });
    await ready;
    this.post({ type: "carrier", enabled: true });
  }
  async exec(command, token = Math.random().toString(36).slice(2)) {
    const reader = new CommandFrameReader(token);
    const pending = this.wait((message) => {
      if (message.type !== "output") return false;
      const result = reader.push(message.data);
      assert.equal(result.limited, false);
      return result.complete ? result : false;
    });
    this.input(commandFrame(command, token));
    return pending;
  }
  async control(type) {
    const id = Math.random();
    const pending = this.wait(
      (message) => message.type === "ack" && message.id === id,
    );
    this.post({ type, id });
    await pending;
  }
  async recover() {
    const token = Math.random().toString(36).slice(2);
    let output = "";
    const pending = this.wait((message) => {
      if (message.type === "output") output += message.data;
      return hasRecoveryFrame(output, token);
    });
    this.input("\x03");
    await new Promise((resolve) => setTimeout(resolve, 100));
    this.input(recoveryFrame(token));
    await pending;
  }
  destroy() {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    this.listeners.clear();
  }
}

const machines = [];
try {
  const first = new RealWorker();
  machines.push(first);
  await first.boot();
  const identity = await first.exec("uname -srmo; busybox | head -n 1");
  assert.equal(identity.exitCode, 0);
  assert.match(identity.output, /riscv64/);
  console.log("Real boot:", identity.output.trim().replace(/\n/g, " · "));
  assert.equal((await first.exec("false")).exitCode, 1);
  const unicode = "λ雪🙂".repeat(400);
  const file = await first.exec(
    `printf '%s' '${unicode}' > /tmp/terrarium-proof\ncat /tmp/terrarium-proof`,
  );
  assert.equal(file.output, unicode);
  assert.equal(file.exitCode, 0);
  console.log(
    "PASS: actual exit codes, Unicode, multi-line shell commands, guest file I/O.",
  );

  const ticks = first.wait(
    (message) => message.type === "output" && message.data.includes("TICK"),
  );
  first.input("while :; do printf 'TICK\\n'; sleep 0.05; done\n");
  await ticks;
  await first.control("pause");
  const heldOutput = first.output;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(
    first.output,
    heldOutput,
    "Paused VM must stop producing guest output.",
  );
  const resumed = first.wait(
    (message) => message.type === "output" && message.data.includes("TICK"),
  );
  await first.control("resume");
  await resumed;
  await first.recover();
  assert.equal((await first.exec("echo recovered")).output, "recovered\n");
  console.log(
    "PASS: worker CPU pause, resume, Ctrl-C, acknowledged command recovery.",
  );

  const second = new RealWorker();
  machines.push(second);
  await second.boot();
  first.network = (frame) =>
    second.post({ type: "network", frame: frame.buffer });
  second.network = (frame) =>
    first.post({ type: "network", frame: frame.buffer });
  assert.equal(
    (await first.exec("ifconfig eth0 192.168.76.10 netmask 255.255.255.0 up"))
      .exitCode,
    0,
  );
  assert.equal(
    (await second.exec("ifconfig eth0 192.168.76.11 netmask 255.255.255.0 up"))
      .exitCode,
    0,
  );
  const ping = await first.exec("ping -c 2 -W 2 192.168.76.11");
  assert.equal(ping.exitCode, 0, ping.output);
  assert.match(ping.output, /0% packet loss/);
  console.log(
    "PASS: two actual RV64 Linux kernels exchange Ethernet/ARP/ICMP across worker endpoints.",
  );

  // Exercise the actual host adapter against these same real workers. Browser
  // globals are minimal shims; guest execution is still the shipped WASM.
  const nativeFetch = globalThis.fetch;
  globalThis.Worker = RealWorker;
  globalThis.document = { baseURI: "https://terrarium.invalid/" };
  globalThis.fetch = async (url) => {
    const entry = Object.entries(TINYEMU_GUEST_ASSETS).find(
      ([, asset]) => asset.url === url,
    );
    const buffer = entry
      ? assets[entry[0]]
      : String(url).endsWith("/riscvemu64-wasm.wasm")
        ? assets.wasm
        : null;
    if (!buffer) throw new Error(`Unexpected host download ${url}`);
    return new Response(buffer.slice(0), { status: 200 });
  };
  const v86Source = await readFile(
    new URL("../public/runtime/libv86.js", import.meta.url),
    "utf8",
  );
  const networkContext = vm.createContext({
    console,
    performance,
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    Headers,
    Response,
    Request,
    crypto,
    URL,
  });
  vm.runInContext(v86Source, networkContext, { filename: "libv86.js" });
  assert.ok(
    networkContext.TerrariumNetworkAdapters,
    "Run npm run runtime:prepare before this smoke test.",
  );
  let webRequests = 0;
  const network = new VirtualNetwork({
    factories: networkContext.TerrariumNetworkAdapters,
    fetch: async (url) => {
      assert.equal(String(url), "https://example.com/probe");
      webRequests++;
      return new Response("RV64_WEB_OK", { status: 200 });
    },
  });
  const port = network.createPort("rv64-smoke", "192.168.76.20");
  port.setMode("world");
  const adapter = new TinyEmuRuntime({
    networkPort: port,
    initScript:
      "printf first > /tmp/init-proof\nwebget -qO /tmp/web-proof http://example.com/probe\necho INIT_OK",
  });
  const runner = new CommandRunner(adapter);
  try {
    const boot = adapter.boot();
    assert.equal(
      adapter.boot(),
      boot,
      "Concurrent boot calls share one machine.",
    );
    await boot;
    assert.equal(adapter.getSnapshot().status, "running");
    assert.equal(adapter.getSnapshot().init.status, "succeeded");
    assert.equal(adapter.getSnapshot().init.output, "INIT_OK\n");
    assert.equal((await runner.execute("cat /tmp/init-proof")).output, "first");
    assert.equal(
      (await runner.execute("cat /tmp/web-proof")).output,
      "RV64_WEB_OK",
    );
    assert.equal(
      webRequests,
      1,
      "Init networking uses the selected web bridge after guest setup.",
    );
    const helperUsage = await runner.execute("webget");
    assert.equal(helperUsage.exitCode, 2);
    assert.match(
      helperUsage.output,
      /Requires Terrarium World mode with the Browser bridge/,
    );
    port.setMode("isolated");
    const isolated = await runner.execute(
      "webget -T 1 -qO- http://example.com/probe",
      { timeoutMs: 5000 },
    );
    assert.notEqual(isolated.exitCode, 0);
    assert.equal(webRequests, 1, "Isolated mode must not call the host fetch.");
    port.setMode("world");
    assert.equal(
      (await runner.execute("webget -T 2 -qO- http://example.com/probe"))
        .output,
      "RV64_WEB_OK",
    );
    assert.equal(webRequests, 2);
    console.log(
      "PASS: actual RV64 VirtIO/TCP/HTTP through NetworkPort, init-script networking, isolation and Internet-toggle reconnection (HTTP origin is a deterministic fixture).",
    );
    await adapter.pause();
    assert.equal(adapter.getSnapshot().status, "paused");
    await adapter.resume();
    assert.equal(adapter.getSnapshot().status, "running");
    const epoch = adapter.getSnapshot().displayEpoch;
    adapter.setInitScript("printf second > /tmp/init-proof\nexit 7");
    await adapter.reset();
    assert.equal(adapter.getSnapshot().init.status, "failed");
    assert.equal(adapter.getSnapshot().init.exitCode, 7);
    assert.ok(adapter.getSnapshot().displayEpoch > epoch);
    assert.equal(
      (await runner.execute("cat /tmp/init-proof")).output,
      "second",
    );
    await assert.rejects(adapter.save(), /does not support checkpoints/);
    await adapter.destroy();
    adapter.setInitScript("");
    const cancelled = adapter.boot();
    await adapter.destroy();
    const replacement = adapter.boot();
    await assert.rejects(cancelled);
    await replacement;
    assert.equal(adapter.getSnapshot().status, "running");
    console.log(
      "PASS: actual TinyEmuRuntime init scripts, failure exit, fresh reset, pause/resume, boot deduplication and cancellation/retry lifecycle.",
    );

    const provenance = JSON.parse(
      await readFile(
        new URL("../public/runtime/provenance.json", import.meta.url),
        "utf8",
      ),
    );
    const x86Assets = Object.fromEntries(
      await Promise.all(
        provenance.externalGuestAssets.map(async (asset) => {
          const response = await nativeFetch(asset.url, {
            signal: AbortSignal.timeout(60_000),
            credentials: "omit",
            referrerPolicy: "no-referrer",
          });
          if (!response.ok)
            throw new Error(
              `Mixed-architecture asset ${asset.file}: HTTP ${response.status}`,
            );
          return [
            asset.file,
            verify(new Uint8Array(await response.arrayBuffer()), {
              ...asset,
              name: asset.file,
            }),
          ];
        }),
      ),
    );
    const x86Port = network.createPort("x86-mixed", "192.168.76.21");
    x86Port.setMode("local");
    const x86 = new V86({
      wasm_path: fileURLToPath(
        new URL("../node_modules/v86/build/v86.wasm", import.meta.url),
      ),
      memory_size: 128 * 1024 * 1024,
      vga_memory_size: 2 * 1024 * 1024,
      bios: { buffer: x86Assets["seabios.bin"] },
      vga_bios: { buffer: x86Assets["vgabios.bin"] },
      bzimage: { buffer: x86Assets["buildroot-bzimage68.bin"] },
      filesystem: {},
      cmdline: "console=ttyS0,115200 tsc=reliable random.trust_cpu=on",
      autostart: false,
      disable_keyboard: true,
      disable_mouse: true,
      disable_speaker: true,
      net_device: x86Port.v86Options(),
    });
    let x86Output = "";
    const x86Decoder = new TextDecoder();
    const x86Observers = new Set();
    x86.add_listener("serial0-output-byte", (byte) => {
      const data = x86Decoder.decode(new Uint8Array([byte]), { stream: true });
      x86Output = (x86Output + data).slice(-262_144);
      for (const listener of [...x86Observers]) listener(data);
    });
    const x86Wait = (test, timeout = 30_000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          x86Observers.delete(listener);
          reject(new Error(`Mixed x86 timeout: ${x86Output.slice(-500)}`));
        }, timeout);
        const listener = (data) => {
          const result = test(data);
          if (result) {
            clearTimeout(timer);
            x86Observers.delete(listener);
            resolve(result);
          }
        };
        x86Observers.add(listener);
      });
    const x86Run = async (command) => {
      const token = Math.random().toString(36).slice(2);
      const reader = new CommandFrameReader(token);
      const pending = x86Wait((data) => {
        const result = reader.push(data);
        return result.complete ? result : false;
      });
      x86.serial0_send(commandFrame(command, token));
      return pending;
    };
    try {
      const ready = x86Wait(
        () => /(?:^|\n)[^\n]{0,80}[#%] $/.test(x86Output.replace(/\r/g, "")),
        30_000,
      );
      x86.add_listener("emulator-ready", () => {
        x86Port.attach(x86);
        void x86.run();
      });
      await ready;
      assert.equal((await x86Run(x86Port.guestSetupCommand())).exitCode, 0);
      x86Port.setReady(true);
      const mixedPing = await x86Run("ping -c 2 -W 2 192.168.76.20");
      assert.equal(mixedPing.exitCode, 0, mixedPing.output);
      assert.match(mixedPing.output, /0% packet loss/);
      console.log(
        "PASS: real x86 Linux and RISC-V64 Linux exchange ARP/ICMP through the shared VirtualNetwork.",
      );
    } finally {
      x86Port.dispose();
      x86Observers.clear();
      await x86.destroy();
    }
  } finally {
    await adapter.destroy();
    port.dispose();
    runner.dispose();
    globalThis.fetch = nativeFetch;
    delete globalThis.Worker;
    delete globalThis.document;
  }
} finally {
  for (const machine of machines) machine.destroy();
}
