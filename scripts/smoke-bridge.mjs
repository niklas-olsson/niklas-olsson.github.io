// SPDX-License-Identifier: Apache-2.0
// Exercises the installed page API against real Linux in a Node v86 host.
// Browser console rendering, React interaction, and IndexedDB are not covered.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { V86 } from "v86";
import { LinuxRuntime } from "../src/lib/linux-runtime.ts";
import { CommandRunner, installAgentBridge } from "../src/lib/agent-bridge.ts";

const provenance = JSON.parse(await readFile(new URL("../public/runtime/provenance.json", import.meta.url), "utf8"));
async function verifiedAsset(file) {
  const asset = provenance.externalGuestAssets.find((entry) => entry.file === file);
  assert.ok(asset, "Missing pinned provenance: " + file);
  let bytes;
  if (process.env.TERRARIUM_VM_ASSET_DIR) {
    bytes = await readFile(resolve(process.env.TERRARIUM_VM_ASSET_DIR, file === "buildroot-bzimage68.bin" ? file : "bios/" + file));
  } else {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(60_000), credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok || !response.body) throw new Error("Could not fetch pinned guest asset: " + file);
    bytes = new Uint8Array(asset.bytes);
    let count = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (count + value.byteLength > bytes.byteLength) throw new Error("Guest asset exceeded its expected size.");
        bytes.set(value, count); count += value.byteLength;
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    assert.equal(count, asset.bytes, "Incomplete guest asset");
  }
  assert.equal(bytes.byteLength, asset.bytes, "Unexpected asset size: " + file);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256, "Unexpected asset SHA-256: " + file);
  return [asset.url, bytes];
}
const assets = new Map(await Promise.all(["buildroot-bzimage68.bin", "seabios.bin", "vgabios.bin"].map(verifiedAsset)));
class HostV86 extends V86 {
  constructor(options) { super({ ...options, wasm_path: fileURLToPath(options.wasm_path) }); }
}
globalThis.window = { setTimeout, clearTimeout, V86: HostV86 };
globalThis.document = { baseURI: new URL("../public/", import.meta.url).href };
globalThis.fetch = async (url) => {
  const asset = assets.get(String(url));
  if (!asset) throw new Error("Unexpected URL: " + url);
  return new Response(asset);
};
const report = (name, details = {}) => console.log(JSON.stringify({ name, passed: true, ...details }));
const runtime = new LinuxRuntime();
const runner = new CommandRunner(runtime);
const machine = { id: "bridge-test", name: "bridge-test", runtime, runner };
installAgentBridge({ active: () => machine, list: () => [machine], get: (id) => id === machine.id ? machine : undefined });
const detach = [];
try {
  const vm = window.terrarium.get(window.terrarium.list()[0].id);
  let bootOutput = "";
  detach.push(vm.subscribeOutput((event) => { if (event.type === "data") bootOutput = (bootOutput + event.data).slice(-262144); }));
  const ready = await vm.boot();
  assert.equal(ready.status, "running");
  assert.equal(ready.commandReady, true);
  assert.match(bootOutput, /Enable networking using|Files send via emulator/);
  report("installed page API boot returns usable status and real live guest output");

  const automaticLogs = [];
  const originalLog = console.log;
  let result;
  console.log = (...args) => automaticLogs.push(args);
  try { result = await vm.exec("uname -a"); } finally { console.log = originalLog; }
  assert.equal(automaticLogs.length, 0, "Commands should not automatically mirror all output");
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /^Linux /);
  const logReturn = console.log(result.output, result.exitCode);
  assert.equal(logReturn, undefined);
  assert.match(vm.readOutput(), new RegExp(result.output.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(vm.readOutput({ format: "raw" }).includes("\r\n"));
  report("exact boot/exec/console.log example has a structured result; undefined is only console.log's return", { output: result.output.trim(), exitCode: result.exitCode });

  const events = [];
  const stop = vm.subscribeOutput((event) => events.push(event));
  detach.push(stop);
  assert.equal(events.length, 0, "Live-only subscriptions do not unexpectedly replay boot logs");
  const failure = await window.terrarium.exec("printf 'terrarium-live-bridge\\n'; false");
  assert.equal(failure.status, "exited");
  assert.equal(failure.exitCode, 1);
  assert.equal(failure.output, "terrarium-live-bridge\n");
  assert.ok(events.map((event) => event.data).join("").includes("terrarium-live-bridge"));
  stop(); stop();
  const stoppedAt = events.length;
  await vm.exec("echo after-unsubscribe");
  assert.equal(events.length, stoppedAt);
  assert.ok(window.terrarium.readOutput().includes("after-unsubscribe"));
  report("live subscriptions, explicit stop, transcript reads, and nonzero exit codes work through the page API");

  const shellEvents = [];
  const stopShell = vm.subscribeOutput((event) => shellEvents.push(event), { port: 1, replay: true });
  detach.push(stopShell);
  assert.ok(shellEvents.some((event) => event.replay));
  assert.ok(vm.readOutput({ port: 1 }).length > 0);
  stopShell();
  const logs = [];
  console.log = (...args) => logs.push(args);
  try {
    const stopMirror = window.terrarium.mirrorOutput();
    detach.push(stopMirror);
    await vm.exec("echo explicit-console-mirror");
    assert.ok(logs.some((args) => String(args[0]).includes("explicit-console-mirror")));
    assert.ok(logs.every((args) => String(args[0]).startsWith("[bridge-test / serial 0]")));
    stopMirror();
    const length = logs.length;
    await vm.exec("echo no-console-mirror");
    assert.equal(logs.length, length);
  } finally { console.log = originalLog; }
  report("port selection and explicit console mirror are independent and detachable");
  assert.equal((await vm.pause()).status, "paused");
  assert.equal((await vm.resume()).status, "running");
  report("page bridge smoke complete");
} finally {
  for (const stop of detach) stop();
  await runtime.destroy();
  runner.dispose();
}
