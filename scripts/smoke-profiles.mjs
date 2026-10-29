// SPDX-License-Identifier: Apache-2.0
// Real Alpine and Debian RV64 Linux boots using the shipped adapter/worker.
// Run with Node 24: node --experimental-strip-types scripts/smoke-profiles.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { TinyEmuRuntime } from "../src/lib/tinyemu-runtime.ts";
import {
  TINYEMU_PROFILE_ASSETS,
  TINYEMU_WASM,
} from "../src/lib/tinyemu-assets.ts";
import { CommandRunner } from "../src/lib/command-runner.ts";
import { VirtualNetwork } from "../src/lib/network.ts";

const directory = new URL("../public/runtime/tinyemu/", import.meta.url);
const files = Object.fromEntries(
  await Promise.all(
    ["worker.js", "filesystem.js", "riscvemu64-wasm.js"].map(async (name) => [
      name,
      await readFile(new URL(name, directory), "utf8"),
    ]),
  ),
);
const wasm = await readFile(new URL("riscvemu64-wasm.wasm", directory));
assert.equal(
  createHash("sha256").update(wasm).digest("hex"),
  TINYEMU_WASM.sha256,
);
const bytesByUrl = new Map();
const nativeFetch = globalThis.fetch;
for (const profileId of ["alpine-riscv64", "debian-riscv64"]) {
  for (const asset of Object.values(TINYEMU_PROFILE_ASSETS[profileId])) {
    if (bytesByUrl.has(asset.url)) continue;
    const response = await nativeFetch(asset.url, {
      signal: AbortSignal.timeout(60_000),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) throw new Error(`${asset.name}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(bytes.length, asset.bytes, `${asset.name}: size`);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      asset.sha256,
      `${asset.name}: SHA-256`,
    );
    bytesByUrl.set(asset.url, bytes);
  }
}
console.log(
  "Verified official Alpine, Debian, bootloader and kernel assets in memory.",
);

const workers = new Set();
class RealWorker {
  timers = new Set();
  receiver = null;
  onmessage = null;
  onerror = null;
  stopped = false;
  constructor() {
    workers.add(this);
    const schedule = (callback, delay, ...args) => {
      const id = setTimeout(() => {
        this.timers.delete(id);
        if (this.stopped) return;
        try {
          callback(...args);
        } catch (error) {
          this.onmessage?.({ data: { type: "error", message: String(error) } });
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
      Uint8Array,
      ArrayBuffer,
      Blob,
      DecompressionStream,
      setTimeout: schedule,
      clearTimeout: (id) => {
        clearTimeout(id);
        this.timers.delete(id);
      },
      location: { href: "https://terrarium.invalid/runtime/tinyemu/worker.js" },
      addEventListener: (type, listener) => {
        if (type === "message") this.receiver = listener;
      },
      postMessage: (message) => {
        if (!this.stopped) this.onmessage?.({ data: structuredClone(message) });
      },
      importScripts: (file) => {
        assert.ok(file === "filesystem.js" || file === "riscvemu64-wasm.js");
        vm.runInContext(files[file], context, { filename: file });
      },
    });
    context.self = context;
    vm.runInContext(files["worker.js"], context, { filename: "worker.js" });
  }
  postMessage(message) {
    if (!this.stopped) void this.receiver({ data: message });
  }
  terminate() {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    workers.delete(this);
  }
}

const adapterContext = vm.createContext({
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
vm.runInContext(
  await readFile(
    new URL("../public/runtime/libv86.js", import.meta.url),
    "utf8",
  ),
  adapterContext,
);
assert.ok(
  adapterContext.TerrariumNetworkAdapters,
  "Run npm run runtime:prepare first.",
);
const requests = [];
const network = new VirtualNetwork({
  factories: adapterContext.TerrariumNetworkAdapters,
  vpcs: [
    {
      id: "profiles",
      name: "Profile verification",
      cidr: "10.42.0.0/16",
      subnets: [{ id: "tools", name: "Tools", cidr: "10.42.7.0/24" }],
    },
  ],
  fetch: async (url) => {
    assert.equal(String(url), "https://example.com/profile");
    requests.push(String(url));
    return new Response("PROFILE_WEB_OK\n", { status: 200 });
  },
});
globalThis.Worker = RealWorker;
globalThis.document = { baseURI: "https://terrarium.invalid/" };
globalThis.fetch = async (url) => {
  const bytes =
    bytesByUrl.get(String(url)) ??
    (String(url).endsWith("/riscvemu64-wasm.wasm") ? wasm : null);
  if (!bytes) throw new Error(`Unexpected host request: ${url}`);
  return new Response(Uint8Array.from(bytes), { status: 200 });
};

try {
  for (const [index, profileId] of [
    "alpine-riscv64",
    "debian-riscv64",
  ].entries()) {
    const port = network.createPort(profileId, `10.42.7.${10 + index}`, {
      vpcId: "profiles",
      subnetId: "tools",
    });
    port.setMode("world");
    const runtime = new TinyEmuRuntime({
      profileId,
      networkPort: port,
      initScript:
        "mkdir -p /tmp/work\nprintf initialized > /tmp/work/state\necho INIT_OK",
    });
    const runner = new CommandRunner(runtime);
    let transcript = "";
    const unsubscribe = runtime.onOutput((data) => {
      transcript = (transcript + data).slice(-5000);
    });
    try {
      await runtime.boot();
      assert.equal(
        runtime.getSnapshot().init.status,
        "succeeded",
        runtime.getSnapshot().init.output,
      );
      assert.equal(runtime.getSnapshot().init.output, "INIT_OK\n");
      const identity = await runner.execute(
        profileId === "alpine-riscv64"
          ? "uname -m; cat /etc/alpine-release; busybox | head -n 1; apk --version"
          : "uname -m; cat /etc/debian_version; bash --version | head -n 1; apt --version",
      );
      assert.equal(identity.exitCode, 0, identity.output);
      assert.match(identity.output, /riscv64/);
      assert.match(
        identity.output,
        profileId === "alpine-riscv64" ? /3\.24\.3/ : /13\.7/,
      );
      console.log(
        `${profileId}: ${identity.output.trim().replace(/\n/g, " · ")}`,
      );
      assert.equal((await runner.execute("false")).exitCode, 1);
      assert.equal(
        (await runner.execute("cat /tmp/work/state")).output,
        "initialized",
      );
      assert.equal(
        (
          await runner.execute(
            "printf '%s' 'λ雪🙂' > /tmp/unicode; cat /tmp/unicode",
          )
        ).output,
        "λ雪🙂",
      );
      const dns = await runner.execute(
        profileId === "debian-riscv64"
          ? "getent ahostsv4 example.com"
          : "nslookup example.com",
      );
      assert.equal(dns.exitCode, 0, dns.output);
      const web = await runner.execute(
        "wget -T 5 -qO- http://example.com/profile",
      );
      assert.equal(web.exitCode, 0, web.output);
      assert.equal(web.output, "PROFILE_WEB_OK\n");
      const proxy = await runner.execute(
        "webget -T 5 -qO- http://example.com/profile",
      );
      assert.equal(proxy.exitCode, 0, proxy.output);
      assert.equal(proxy.output, "PROFILE_WEB_OK\n");
      const configuration = await runner.execute(
        "cat /etc/resolv.conf; route -n; head -n 9 /usr/bin/webget",
      );
      assert.match(configuration.output, /10\.42\.7\.1/);
      assert.match(configuration.output, /http_proxy=http:\/\/10\.42\.7\.1/);
      await runtime.pause();
      assert.equal(runtime.getSnapshot().status, "paused");
      await runtime.resume();
      assert.equal(runtime.getSnapshot().status, "running");
      await assert.rejects(runtime.save(), /does not support checkpoints/);
      console.log(
        `PASS ${profileId}: real shell, init, Unicode/files, DNS, native HTTP and webget on assigned 10.42.7.0/24 gateway, pause/resume.`,
      );
    } catch (error) {
      console.error(`${profileId} recent serial output:\n${transcript}`);
      console.error(port.getSnapshot());
      throw error;
    } finally {
      unsubscribe();
      runner.dispose();
      await runtime.destroy();
      port.dispose();
    }
  }
  assert.equal(requests.length, 4);
  console.log(
    "PASS: both modern RV64 profile integrations, using actual kernels and packet bridge (HTTP origin is a deterministic fixture).",
  );
} finally {
  for (const worker of workers) worker.terminate();
  globalThis.fetch = nativeFetch;
  delete globalThis.Worker;
  delete globalThis.document;
}
