// SPDX-License-Identifier: Apache-2.0
// Two real Linux guests: VPC routes, partitions, spoof rejection, quarantine.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { V86 } from "v86";
import "../public/runtime/libv86.js";
import { VirtualNetwork } from "../src/lib/network.ts";
import { ALLOW_ALL_POLICY } from "../src/lib/network-policy.ts";
import {
  commandFrame,
  parseCommandFrame,
} from "../src/lib/command-protocol.ts";

const report = (test, details = {}) =>
  console.log(JSON.stringify({ test, passed: true, ...details }));
const provenance = JSON.parse(
  await readFile(
    new URL("../public/runtime/provenance.json", import.meta.url),
    "utf8",
  ),
);
async function guestAsset(file) {
  const asset = provenance.externalGuestAssets.find(
    (entry) => entry.file === file,
  );
  let bytes;
  if (process.env.TERRARIUM_VM_ASSET_DIR)
    bytes = await readFile(
      resolve(
        process.env.TERRARIUM_VM_ASSET_DIR,
        file === "buildroot-bzimage68.bin" ? file : `bios/${file}`,
      ),
    );
  else {
    const response = await fetch(asset.url, {
      signal: AbortSignal.timeout(60000),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  assert.equal(bytes.byteLength, asset.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}
const [kernel, bios, vga] = await Promise.all(
  ["buildroot-bzimage68.bin", "seabios.bin", "vgabios.bin"].map(guestAsset),
);
const vpcs = ["a", "b"].map((id) => ({
  id,
  name: `VPC ${id.toUpperCase()}`,
  cidr: "10.40.0.0/16",
  subnets: [
    { id: "one", name: "One", cidr: "10.40.1.0/24" },
    { id: "two", name: "Two", cidr: "10.40.2.0/24" },
  ],
}));
const network = new VirtualNetwork({ vpcs });
const machines = [];

async function create(id, ip, subnetId) {
  const port = network.createPort(id, ip, { vpcId: "a", subnetId });
  const emulator = new V86({
    wasm_path: fileURLToPath(
      new URL("../public/runtime/v86.wasm", import.meta.url),
    ),
    memory_size: 128 * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    bios: { buffer: bios.slice(0) },
    vga_bios: { buffer: vga.slice(0) },
    bzimage: { buffer: kernel.slice(0) },
    filesystem: {},
    cmdline: "console=ttyS0,115200 tsc=reliable random.trust_cpu=on",
    autostart: false,
    disable_keyboard: true,
    disable_mouse: true,
    disable_speaker: true,
    net_device: port.v86Options(),
    mac_address_translation: true,
    preserve_mac_from_state_image: false,
  });
  let output = "";
  const listeners = new Set();
  emulator.add_listener("emulator-ready", () => {
    port.attach(emulator);
    void emulator.run();
  });
  emulator.add_listener("serial0-output-byte", (byte) => {
    output += String.fromCharCode(byte);
    for (const listener of listeners) listener();
  });
  function waitFor(predicate, ms = 20000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const value = predicate();
        if (value) {
          clearTimeout(timer);
          listeners.delete(check);
          resolve(value);
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`${id} timed out: ${output.slice(-1600)}`));
      }, ms);
      listeners.add(check);
      check();
    });
  }
  async function run(command) {
    const token = randomUUID().replaceAll("-", "");
    const start = output.length;
    const pending = waitFor(() =>
      parseCommandFrame(output.slice(start), token),
    );
    emulator.serial_send_bytes(
      0,
      new TextEncoder().encode(commandFrame(command, token)),
    );
    const result = await pending;
    await waitFor(() => output.endsWith("~% "));
    return result;
  }
  async function move(vpcId, subnetId, ip) {
    port.setReady(false);
    await emulator.stop();
    port.detach();
    port.configureAttachment({ vpcId, subnetId, ip });
    port.attach(emulator);
    await emulator.run();
    assert.equal((await run(port.guestSetupCommand())).exitCode, 0);
    port.setMode("local");
    port.setReady(true);
  }
  const machine = { port, emulator, run, move };
  machines.push(machine);
  await waitFor(() => output.endsWith("~% "), 60000);
  assert.equal((await run(port.guestSetupCommand())).exitCode, 0);
  port.setMode("local");
  port.setReady(true);
  return machine;
}

try {
  const [a, b] = await Promise.all([
    create("router-a", "10.40.1.10", "one"),
    create("router-b", "10.40.2.11", "two"),
  ]);
  let result = await a.run(`ping -c 2 -W 2 ${b.port.ip}`);
  assert.equal(
    result.exitCode,
    0,
    JSON.stringify({
      result,
      source: a.port.getSnapshot(),
      target: b.port.getSnapshot(),
    }),
  );
  assert.match(result.output, /2 received/);
  assert.match(result.output, /ttl=63/);
  report("same VPC, different subnets: real gateway routing", {
    output: result.output,
    arp: (await a.run("cat /proc/net/arp")).output,
  });
  result = await b.run(`ping -c 1 -W 2 ${a.port.ip}`);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /ttl=63/);
  report("inter-subnet return path");

  await b.move("b", "two", b.port.ip);
  const before = b.port.getSnapshot().rxPackets;
  result = await a.run(`ping -c 1 -W 1 ${b.port.ip}`);
  assert.notEqual(result.exitCode, 0);
  assert.equal(b.port.getSnapshot().rxPackets, before);
  report("overlapping VPC partition: unchanged peer IP receives no packet", {
    reason: a.port.getSnapshot().lastDrop?.reason,
  });
  result = await a.run(
    `ifconfig eth0 10.40.2.10 netmask 255.255.255.0 up; ping -c 1 -W 1 ${b.port.ip}`,
  );
  assert.notEqual(result.exitCode, 0);
  assert.equal(b.port.getSnapshot().rxPackets, before);
  assert.ok(a.port.getSnapshot().dropReasons.source_ip_mismatch > 0);
  assert.equal((await a.run(a.port.guestSetupCommand())).exitCode, 0);
  report("guest IP spoof cannot reach the overlapping foreign VPC", {
    blocked: a.port.getSnapshot().dropReasons.source_ip_mismatch,
  });

  await b.move("a", "one", "10.40.1.11");
  result = await a.run(`ping -c 1 -W 2 ${b.port.ip}`);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /ttl=64/);
  report("same subnet uses direct Ethernet without router TTL change");
  b.port.setPolicy({ ingress: [], egress: ALLOW_ALL_POLICY.egress });
  assert.notEqual((await a.run(`ping -c 1 -W 1 ${b.port.ip}`)).exitCode, 0);
  assert.ok(b.port.getSnapshot().dropReasons.ingress_policy > 0);
  b.port.setPolicy(ALLOW_ALL_POLICY);
  assert.equal((await a.run(`ping -c 1 -W 2 ${b.port.ip}`)).exitCode, 0);
  report("real ingress policy blocks traffic and explicit allow restores it");

  a.port.setMode("world");
  result = await a.run(
    "curl -fsS --max-time 15 http://raw.githubusercontent.com/copy/v86/cc37f35c43bf14865d74ad76879ecf9410f69eb1/LICENSE",
  );
  assert.equal(
    result.exitCode,
    0,
    JSON.stringify({ result, network: a.port.getSnapshot() }),
  );
  assert.match(result.output, /The v86 contributors/);
  report("custom subnet DNS and World HTTP bridge", {
    gateway: a.port.gateway,
    bytes: result.output.length,
    requests: a.port.getSnapshot().webRequests,
  });
  a.port.setMode("local");

  b.port.setCapture(true);
  b.port.quarantine("Real VM forensic test");
  assert.throws(() => b.port.setMode("world"), /quarantined/);
  const received = b.port.getSnapshot().rxPackets;
  assert.notEqual((await a.run(`ping -c 1 -W 1 ${b.port.ip}`)).exitCode, 0);
  assert.equal(b.port.getSnapshot().rxPackets, received);
  assert.notEqual((await b.run(`ping -c 1 -W 1 ${a.port.ip}`)).exitCode, 0);
  assert.ok(b.port.getSnapshot().dropReasons.quarantined > 0);
  assert.ok(b.port.getSnapshot().capture.packets > 0);
  const pcap = b.port.exportPcap();
  assert.equal(new DataView(pcap.buffer).getUint32(0, true), 0xa1b2c3d4);
  report(
    "running quarantined guest cannot send or receive; rejected attempts export as PCAP",
    {
      capture: b.port.getSnapshot().capture,
      pcapBytes: pcap.length,
      lastDrop: b.port.getSnapshot().lastDrop,
    },
  );
  report("complete VPC integration");
} finally {
  for (const machine of machines) {
    machine.port.dispose();
    await machine.emulator.destroy();
  }
}
