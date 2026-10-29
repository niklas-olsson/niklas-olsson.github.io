// SPDX-License-Identifier: Apache-2.0
// Two real Linux guests query the VPC DNS service and communicate by name.
// Browser console rendering, React interaction, and IndexedDB are not covered.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { V86 } from "v86";
import "../public/runtime/libv86.js";
import { VirtualNetwork } from "../src/lib/network.ts";
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
const vpcs = ["a", "b"].map((id) => ({ id, name: id, cidr: "10.40.0.0/16", subnets: [
  { id: "one", name: "One", cidr: "10.40.1.0/24" },
  { id: "two", name: "Two", cidr: "10.40.2.0/24" },
] }));
const network = new VirtualNetwork({ vpcs });
const clientPort = network.createPort("client", "10.40.1.10", { vpcId: "a", subnetId: "one", hostname: "client" });
const peerPort = network.createPort("peer", "10.40.2.20", { vpcId: "a", subnetId: "two", hostname: "peer" });
const foreignPort = network.createPort("foreign", "10.40.2.21", { vpcId: "b", subnetId: "two", hostname: "foreign-only" });
const quarantinePort = network.createPort("infected", "10.40.1.30", { vpcId: "a", subnetId: "one", hostname: "infected", quarantined: true });
clientPort.setMode("local"); peerPort.setMode("local");
const entries = [clientPort, peerPort].map((port) => {
  const runtime = new LinuxRuntime({ networkPort: port });
  return { id: port.id, name: port.id, runtime, runner: new CommandRunner(runtime) };
});
installAgentBridge({ active: () => entries[0], list: () => entries, get: (id) => entries.find((entry) => entry.id === id) });
const client = window.terrarium.get("client"), peer = window.terrarium.get("peer");
async function successful(vm, command) {
  const result = await vm.exec(command, { timeoutMs: 10_000 });
  assert.equal(result.status, "exited", JSON.stringify(result));
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  return result.output;
}
try {
  await client.boot(); await peer.boot();
  const resolverTools = await successful(client, "command -v nslookup || true; command -v ping || true; cat /etc/resolv.conf");
  report("guest resolver tooling and numeric gateway configuration observed", { output: resolverTools });
  const queryCommand = (name) => resolverTools.includes("nslookup")
    ? `nslookup ${name} ${clientPort.gateway}`
    : `ping -c 1 -W 2 ${name}`;
  const lookup = await client.exec(queryCommand("peer.terrarium.internal"), { timeoutMs: 10_000 });
  assert.equal(lookup.status, "exited", JSON.stringify(lookup));
  assert.equal(lookup.exitCode, 0, JSON.stringify(lookup));
  assert.ok(lookup.output.includes(peerPort.ip), JSON.stringify(lookup));
  report("real guest resolves private FQDN to the actual peer address", { output: lookup.output, address: peerPort.ip });
  const ping = await successful(client, "ping -c 1 -W 2 peer");
  assert.match(ping, /1 received/);
  assert.match(ping, /ttl=63/);
  report("short machine name resolves and reaches a real guest across same-VPC subnets", { output: ping });
  const reverse = await successful(peer, "ping -c 1 -W 2 client.terrarium.internal");
  assert.match(reverse, /1 received/);
  const numeric = await successful(client, `ping -c 1 -W 2 ${clientPort.gateway}`);
  assert.match(numeric, /1 received/);
  report("reverse private-name route and numeric gateway behavior remain functional");
  for (const name of ["foreign-only.terrarium.internal", "infected.terrarium.internal", "missing.terrarium.internal"]) {
    const result = await client.exec(queryCommand(name), { timeoutMs: 10_000 });
    assert.equal(result.status, "exited", JSON.stringify(result));
    assert.notEqual(result.exitCode, 0, JSON.stringify(result));
    assert.match(result.output, /NXDOMAIN|not found|can't resolve|bad address|Name or service not known|Unknown host/i, JSON.stringify(result));
    assert.ok(!result.output.includes(foreignPort.ip) && !result.output.includes(quarantinePort.ip));
    report("private name does not escape its scope or advertise a quarantine", { name, output: result.output });
  }
  peerPort.setHostname("renamed-peer");
  const renamed = await successful(client, "ping -c 1 -W 2 renamed-peer.terrarium.internal");
  assert.match(renamed, /1 received/);
  const old = await client.exec(queryCommand("peer.terrarium.internal"), { timeoutMs: 10_000 });
  assert.equal(old.status, "exited"); assert.notEqual(old.exitCode, 0);
  assert.equal(clientPort.getSnapshot().webRequests, 0);
  assert.equal(peerPort.getSnapshot().webRequests, 0);
  assert.ok(clientPort.getFlowLog(200).some((event) => event.reason === "vpc_dns"));
  report("renames update live DNS without external requests", { dnsName: peerPort.getSnapshot().dnsName });
  report("real VPC DNS smoke complete");
} finally {
  for (const entry of entries) { await entry.runtime.destroy(); entry.runner.dispose(); }
  for (const port of [clientPort, peerPort, foreignPort, quarantinePort]) port.dispose();
}
