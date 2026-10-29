// SPDX-License-Identifier: Apache-2.0
// Real two-VM integration: LAN, browser HTTP bridge, and secure Wisp TCP.
// Requires Node 24+, OpenSSL, and access to the recorded upstream test assets.
// No guest binaries or generated TLS keys are kept in the repository.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { V86 } from "v86";
import "../public/runtime/libv86.js";
import { VirtualNetwork } from "../src/lib/network.ts";
import {
  commandFrame,
  parseCommandFrame,
} from "../src/lib/command-protocol.ts";
import { createRelayFixture } from "./network-test-relay.mjs";

const report = (test, details = {}) =>
  console.log(JSON.stringify({ test, passed: true, ...details }));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for the network state.");
    await delay(20);
  }
}

async function guestAsset(asset) {
  let bytes;
  if (process.env.TERRARIUM_VM_ASSET_DIR) {
    bytes = await readFile(
      resolve(
        process.env.TERRARIUM_VM_ASSET_DIR,
        asset.file === "buildroot-bzimage68.bin"
          ? asset.file
          : `bios/${asset.file}`,
      ),
    );
  } else {
    const response = await fetch(asset.url, {
      signal: AbortSignal.timeout(60000),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) throw new Error(`${asset.file}: HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  assert.equal(bytes.byteLength, asset.bytes, `${asset.file}: size mismatch`);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    asset.sha256,
    `${asset.file}: digest mismatch`,
  );
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}

async function smoke(tlsDirectory) {
  const provenance = JSON.parse(
    await readFile(
      new URL("../public/runtime/provenance.json", import.meta.url),
      "utf8",
    ),
  );
  const guest = (file) =>
    provenance.externalGuestAssets.find((asset) => asset.file === file);
  const [kernel, bios, vga] = await Promise.all(
    ["buildroot-bzimage68.bin", "seabios.bin", "vgabios.bin"].map((file) =>
      guestAsset(guest(file)),
    ),
  );
  const network = new VirtualNetwork();
  const machines = [];
  let relay;

  async function create(id, ip) {
    const port = network.createPort(id, ip);
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
          reject(new Error(`${id} timed out: ${output.slice(-1500)}`));
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
    const machine = { port, emulator, run };
    machines.push(machine);
    await waitFor(() => output.endsWith("~% "), 60000);
    assert.equal((await run(port.guestSetupCommand())).exitCode, 0);
    port.setReady(true);
    return machine;
  }

  try {
    const [a, b] = await Promise.all([
      create("network-a", "192.168.76.10"),
      create("network-b", "192.168.76.11"),
    ]);
    a.port.setMode("local");
    b.port.setMode("local");
    let result = await a.run("ping -c 2 -W 2 192.168.76.11");
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /2 packets received|2 received/);
    report("real two-machine LAN ping", { output: result.output });
    b.port.setMode("isolated");
    result = await a.run("ping -c 1 -W 1 192.168.76.11");
    assert.notEqual(result.exitCode, 0);
    report("isolated machine rejects LAN traffic");
    b.port.setMode("local");
    assert.equal((await a.run("ping -c 1 -W 2 192.168.76.11")).exitCode, 0);
    report("LAN reconnection");

    const url =
      "http://raw.githubusercontent.com/copy/v86/cc37f35c43bf14865d74ad76879ecf9410f69eb1/LICENSE";
    a.port.setMode("world");
    result = await a.run(`curl -fsS --max-time 12 ${url}`);
    assert.equal(
      result.exitCode,
      0,
      JSON.stringify({ result, network: a.port.getSnapshot() }),
    );
    assert.match(result.output, /The v86 contributors/);
    report("guest HTTP through HTTPS fetch bridge", {
      bytes: result.output.length,
      requests: a.port.getSnapshot().webRequests,
    });
    a.port.setMode("local");
    assert.notEqual((await a.run(`curl -fsS --max-time 3 ${url}`)).exitCode, 0);
    report("World off blocks a new HTTP request");

    const cert = await readFile(join(tlsDirectory, "cert.pem"));
    relay = await createRelayFixture({
      key: await readFile(join(tlsDirectory, "key.pem")),
      cert,
    });
    a.port.configureTransport({ kind: "wisp", relayUrl: relay.url });
    assert.equal(relay.acceptedSockets, 0);
    a.port.setMode("world");
    await until(() => a.port.getSnapshot().connectionState === "connected");
    result = await a.run(`curl -fsS --max-time 12 ${relay.guestUrl}`);
    assert.equal(
      result.exitCode,
      0,
      JSON.stringify({
        result,
        network: a.port.getSnapshot(),
        requests: relay.requests,
      }),
    );
    assert.equal(result.output, "Terrarium TCP over secure Wisp is real.\n");
    assert.equal(relay.requests[0].hostname, "fixture.example");
    report(
      "real guest DNS, Wisp hostname CONNECT, arbitrary-port TCP over verified secure WebSocket",
      { hostname: relay.requests[0].hostname, output: result.output },
    );
    report("guest TLS tooling capability probe", {
      output: (
        await a.run(
          "curl --version; command -v openssl || true; busybox --list | grep -E 'ssl|wget' || true",
        )
      ).output,
    });
    assert.equal((await a.run("ping -c 1 -W 2 192.168.76.11")).exitCode, 0);
    report("LAN stays connected while Wisp is selected");
    a.port.setMode("local");
    await until(() => relay.activeSockets === 0);
    const opened = relay.acceptedSockets;
    assert.notEqual(
      (await a.run(`curl -fsS --max-time 3 ${relay.guestUrl}`)).exitCode,
      0,
    );
    assert.equal(relay.acceptedSockets, opened);
    assert.equal(a.port.getSnapshot().connectionState, "off");
    report("World off closes the secure relay and blocks subsequent TCP");
    a.port.setMode("world");
    await until(() => a.port.getSnapshot().connectionState === "connected");
    result = await a.run(`curl -fsS --max-time 12 ${relay.guestUrl}`);
    assert.equal(result.exitCode, 0);
    assert.equal(relay.acceptedSockets, opened + 1);
    report("Wisp reconnects only after explicit World enable");
  } finally {
    for (const machine of machines) {
      machine.port.dispose();
      await machine.emulator.destroy();
    }
    await relay?.close();
  }
}

if (process.argv[2] === "--tls-fixture") {
  await smoke(process.argv[3]);
  report("complete network integration");
  process.send?.({ completed: true });
} else {
  const directory = await mkdtemp(
    fileURLToPath(new URL("../.network-smoke-", import.meta.url)),
  );
  try {
    await promisify(execFile)("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=fixture.example",
      "-addext",
      "subjectAltName=DNS:fixture.example,DNS:localhost,IP:127.0.0.1",
    ]);
    const existingCa = process.env.NODE_EXTRA_CA_CERTS
      ? await readFile(process.env.NODE_EXTRA_CA_CERTS)
      : Buffer.alloc(0);
    await writeFile(
      join(directory, "trust.pem"),
      Buffer.concat([
        existingCa,
        Buffer.from("\n"),
        await readFile(join(directory, "cert.pem")),
      ]),
    );
    const code = await new Promise((resolve, reject) => {
      let completed = false;
      const child = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          fileURLToPath(import.meta.url),
          "--tls-fixture",
          directory,
        ],
        {
          stdio: ["inherit", "inherit", "inherit", "ipc"],
          env: {
            ...process.env,
            NODE_EXTRA_CA_CERTS: join(directory, "trust.pem"),
          },
        },
      );
      child.on("message", (message) => {
        if (message?.completed === true) completed = true;
      });
      child.on("error", reject);
      child.on("close", (status, signal) => {
        if (status === 0 && completed) resolve(0);
        else
          reject(
            new Error(
              `Network smoke did not complete (exit ${status}, signal ${signal}).`,
            ),
          );
      });
    });
    process.exitCode = code ?? 1;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
