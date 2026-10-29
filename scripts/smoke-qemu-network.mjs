// SPDX-License-Identifier: Apache-2.0
// One real QEMU x86_64 Linux guest and one 128 MiB v86 peer, sharing the
// production VPC fabric and a loopback-only, certificate-verified Wisp relay.
// No public relay is contacted. Browser headers and service workers are not
// covered by this Node integration test. Node 24+ and OpenSSL are required.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { V86 } from "v86";
import "../public/runtime/libv86.js";
import { QemuRuntime } from "../src/lib/qemu-runtime.ts";
import { loadQemuTestAssets, installQemuTestPthread } from "./qemu-test-assets.mjs";
import { CommandRunner } from "../src/lib/command-runner.ts";
import { commandFrame, parseCommandFrame } from "../src/lib/command-protocol.ts";
import { VirtualNetwork } from "../src/lib/network.ts";
import { ALLOW_ALL_POLICY } from "../src/lib/network-policy.ts";
import { createNodeQemuWorkers } from "./qemu-node-adapter.mjs";
import { createRelayFixture } from "./network-test-relay.mjs";

const report = (test, details = {}) => console.log(JSON.stringify({ test, passed: true, ...details }));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const processRole = process.argv[2] === "--tls-fixture" ? "guests" : "supervisor";
let harnessComplete = false;
console.error(JSON.stringify({ event: "network-harness-start", role: processRole, pid: process.pid, parentPid: process.ppid }));
process.once("exit", (code) => console.error(JSON.stringify({ event: "network-harness-exit", role: processRole, pid: process.pid, code, completed: harnessComplete })));

async function until(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await delay(20);
  }
}

async function verifiedBytes(asset, assetPath, fetchAsset) {
  let bytes;
  if (assetPath) bytes = new Uint8Array(await readFile(assetPath));
  else {
    const response = await fetchAsset(asset.url, {
      credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(120_000),
    });
    assert.ok(response.ok, `${asset.name ?? asset.file}: HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  assert.equal(bytes.byteLength, asset.bytes, `${asset.name ?? asset.file}: length`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256, `${asset.name ?? asset.file}: SHA-256`);
  return bytes;
}

async function smoke(temporary) {
  const native = {
    fetch: globalThis.fetch, Worker: globalThis.Worker, document: globalThis.document,
    crossOriginIsolated: globalThis.crossOriginIsolated, isSecureContext: globalThis.isSecureContext,
  };
  const { bundle, manifest, pthread, assets: qemuAssets } = await loadQemuTestAssets({ fetchAsset: native.fetch });
  const provenance = JSON.parse(await readFile(new URL("../public/runtime/provenance.json", import.meta.url), "utf8"));
  const [kernel, bios, vga] = await Promise.all(
    ["buildroot-bzimage68.bin", "seabios.bin", "vgabios.bin"].map(async (file) => {
      const asset = provenance.externalGuestAssets.find((entry) => entry.file === file);
      assert.ok(asset, `Missing recorded v86 asset ${file}.`);
      const local = process.env.TERRARIUM_VM_ASSET_DIR
        ? resolve(process.env.TERRARIUM_VM_ASSET_DIR, file === "buildroot-bzimage68.bin" ? file : `bios/${file}`) : null;
      const bytes = await verifiedBytes(asset, local, native.fetch);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }),
  );
  await installQemuTestPthread(temporary, bundle, pthread);
  report("recorded QEMU and v86 executable/guest asset hashes verified");

  const { Worker, workers, joinTeardown } = createNodeQemuWorkers({ temporary, manifest, bundleId: bundle.id });
  const vpcs = ["a", "b"].map((id) => ({
    id, name: `Network proof ${id}`, cidr: "10.52.0.0/16",
    subnets: [{ id: "one", name: "One", cidr: "10.52.1.0/24" }, { id: "two", name: "Two", cidr: "10.52.2.0/24" }],
  }));
  assert.ok(globalThis.TerrariumNetworkAdapters, "Run npm run runtime:prepare first.");
  const network = new VirtualNetwork({
    vpcs, factories: globalThis.TerrariumNetworkAdapters,
    fetch: async (url) => { throw new Error(`This Wisp-only test must not use the browser HTTP bridge: ${url}`); },
  });
  globalThis.Worker = Worker;
  globalThis.document = { baseURI: "https://terrarium.invalid/" };
  globalThis.crossOriginIsolated = true;
  globalThis.isSecureContext = true;
  globalThis.fetch = async (url) => {
    const bytes = qemuAssets.get(String(url));
    if (!bytes) throw new Error(`Unexpected host fetch during the network proof: ${url}`);
    return new Response(Uint8Array.from(bytes), { status: 200 });
  };

  const port = network.createPort("qemu-network", "10.52.1.10", { vpcId: "a", subnetId: "one", hostname: "x64" });
  port.setMode("local");
  port.setCapture(true);
  const runtime = new QemuRuntime({ defaultBootBundleId: bundle.id, networkPort: port });
  const runner = new CommandRunner(runtime);
  let failureStacks = null, restoreStartup = () => {};
  let qemuTail = "", peerTail = "", peer, relay, lastGuestOutputAt = Date.now();
  const unsubscribe = runtime.onOutput((text) => {
    lastGuestOutputAt = Date.now();
    qemuTail = (qemuTail + text).slice(-32_768);
    if (process.env.TERRARIUM_QEMU_VERBOSE === "1") process.stdout.write(`[x64] ${text}`);
  });

  function createPeer() {
    const peerPort = network.createPort("v86-network", "10.52.2.11", { vpcId: "a", subnetId: "two", hostname: "peer" });
    peerPort.setCapture(true);
    const emulator = new V86({
      wasm_path: fileURLToPath(new URL("../public/runtime/v86.wasm", import.meta.url)),
      memory_size: 128 * 1024 * 1024, vga_memory_size: 2 * 1024 * 1024,
      bios: { buffer: bios }, vga_bios: { buffer: vga }, bzimage: { buffer: kernel }, filesystem: {},
      cmdline: "console=ttyS0,115200 tsc=reliable random.trust_cpu=on", autostart: false,
      disable_keyboard: true, disable_mouse: true, disable_speaker: true,
      net_device: peerPort.v86Options(), mac_address_translation: true, preserve_mac_from_state_image: false,
    });
    const listeners = new Set();
    let commandOutput = null;
    emulator.add_listener("emulator-ready", () => { peerPort.attach(emulator); void emulator.run(); });
    emulator.add_listener("serial0-output-byte", (byte) => {
      const character = String.fromCharCode(byte);
      peerTail = (peerTail + character).slice(-128 * 1024);
      if (commandOutput !== null && commandOutput.length <= 128 * 1024) commandOutput += character;
      for (const listener of listeners) listener();
    });
    function waitFor(predicate, timeoutMs = 30_000) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { listeners.delete(check); reject(new Error(`The v86 peer timed out: ${peerTail.slice(-2048)}`)); }, timeoutMs);
        const check = () => {
          try {
            const value = predicate();
            if (value) { clearTimeout(timeout); listeners.delete(check); resolve(value); }
          } catch (error) { clearTimeout(timeout); listeners.delete(check); reject(error); }
        };
        listeners.add(check); check();
      });
    }
    async function run(command) {
      const token = randomUUID().replaceAll("-", "");
      assert.equal(commandOutput, null, "Peer commands must be serialized.");
      commandOutput = "";
      try {
        const completed = waitFor(() => {
          if (commandOutput.length > 128 * 1024) throw new Error("The v86 peer exceeded its command output limit.");
          return parseCommandFrame(commandOutput, token);
        });
        emulator.serial_send_bytes(0, new TextEncoder().encode(commandFrame(command, token)));
        const result = await completed;
        await waitFor(() => peerTail.endsWith("~% "));
        return result;
      } finally { commandOutput = null; }
    }
    async function configure(vpcId, subnetId, ip) {
      peerPort.setReady(false);
      await emulator.stop(); peerPort.detach();
      peerPort.configureAttachment({ vpcId, subnetId, ip });
      peerPort.attach(emulator); await emulator.run();
      const result = await run(peerPort.guestSetupCommand());
      assert.equal(result.exitCode, 0, result.output);
      peerPort.setMode("local"); peerPort.setReady(true);
    }
    return {
      port: peerPort, emulator, run, configure,
      async boot() {
        await waitFor(() => peerTail.endsWith("~% "), 90_000);
        const result = await run(peerPort.guestSetupCommand());
        assert.equal(result.exitCode, 0, result.output);
        peerPort.setMode("local"); peerPort.setReady(true);
      },
    };
  }

  const command = async (text, timeoutMs = 30_000) => runner.execute(text, { timeoutMs });
  const success = (result, label) => {
    assert.equal(result.status, "exited", `${label}: ${JSON.stringify(result)}`);
    assert.equal(result.exitCode, 0, `${label}: ${JSON.stringify(result)}`);
    return result;
  };
  const blocked = (result, label) => {
    assert.equal(result.status, "exited", `${label}: ${JSON.stringify(result)}`);
    assert.notEqual(result.exitCode, 0, `${label}: ${JSON.stringify(result)}`);
    return result;
  };
  const receivedIcmp = (target, source, destination) => target.getFlowLog(200).filter((flow) =>
    flow.direction === "ingress" && flow.protocol === "icmp" && flow.source === source && flow.destination === destination);
  try {
    if (process.env.TERRARIUM_QEMU_FAILURE_STACKS === "1") {
      // The supervisor supplies a conservative wall-clock bound immediately
      // before spawning. Its existing ten-minute watchdog remains unchanged.
      const supervisorDeadline = Number(process.argv[4]);
      assert.ok(Number.isFinite(supervisorDeadline) && supervisorDeadline > 0,
        "Diagnostic child requires its original supervisor deadline.");
      const { createFailureStackCapture } = await import("./qemu-failure-stacks.mjs");
      failureStacks = createFailureStackCapture({ workers, bundleId: bundle.id,
        deadlineAt: performance.now() + supervisorDeadline - Date.now() });
      restoreStartup = failureStacks.instrumentStartup(runtime, "mixed-network x86_64 machine");
    }
    const started = performance.now();
    let bootDiagnosticTimer, diagnosingBoot = false;
    const bootDiagnostic = new Promise((_, reject) => {
      bootDiagnosticTimer = setInterval(() => {
        if (diagnosingBoot || performance.now() - started < 180_000 || Date.now() - lastGuestOutputAt < 45_000 || runtime.getSnapshot().status !== "booting") return;
        diagnosingBoot = true;
        void (async () => {
          console.error(JSON.stringify({ event: "quiet-boot-diagnostic", elapsedMs: Math.round(performance.now() - started), quietMs: Date.now() - lastGuestOutputAt }));
          try {
            if (failureStacks) await failureStacks.captureFailure({ runtime,
              error: new Error("The x86_64 boot stopped producing output; its bounded monitor diagnosis was recorded."),
              reason: "original-quiet-boot-failure-before-monitor-diagnosis" });
            // Maintainer-only diagnosis through the existing fixed controls.
            // A diagnosed stall is a failed run, even if pause itself succeeds.
            await runtime.control("pause");
            console.error("Quiet-boot diagnosis: private monitor acknowledged CPU pause.");
            const observation = await runtime.control("inspect-registers");
            console.error("Quiet-boot CPU registers:\n" + observation.registers);
          } catch (error) { console.error("Quiet-boot monitor diagnosis failed:", error); }
          finally { reject(new Error("The x86_64 boot stopped producing output; its bounded monitor diagnosis was recorded.")); }
        })();
      }, 5_000);
    });
    try { await Promise.race([runtime.boot(), bootDiagnostic]); }
    finally { clearInterval(bootDiagnosticTimer); }
    assert.equal(runtime.getSnapshot().status, "running", runtime.getSnapshot().message);
    assert.equal(runtime.getSnapshot().controlReady, true);
    assert.equal(runtime.getSnapshot().runtimeBundle.activeBundleId, bundle.id);
    assert.equal(runtime.getSnapshot().guestCapabilities?.kernelRelease, bundle.guest.kernel);
    const controlTty = success(await command("stty -F /dev/ttyS0 -a"), "control TTY configuration");
    assert.match(controlTty.output, /(?:^|\s)-ixon(?:\s|;|$)/);
    assert.match(controlTty.output, /(?:^|\s)-ixoff(?:\s|;|$)/);
    report("framed commands preserve disabled control-console software flow control", { tty: controlTty.output });
    peer = createPeer();
    await peer.boot();
    report("one real x86_64 guest and one 128 MiB v86 peer booted", { durationMs: Math.round(performance.now() - started) });

    let result = success(await command(`ping -c 2 -W 3 ${peer.port.ip}`), "x86_64 routed ping");
    assert.match(result.output, /2 (?:packets )?received/);
    assert.match(result.output, /ttl=63/);
    const returned = await peer.run(`ping -c 1 -W 3 ${port.ip}`);
    assert.equal(returned.exitCode, 0, returned.output);
    assert.match(returned.output, /ttl=63/);
    const dns = success(await command("nslookup peer.terrarium.internal"), "VPC DNS");
    assert.match(dns.output, /10\.52\.2\.11/);
    report("mixed-backend VPC routing, return path and local DNS", { output: result.output });

    await peer.configure("b", "two", peer.port.ip);
    peer.port.clearDiagnostics();
    const routedDrops = port.getSnapshot().dropReasons.no_vpc_route ?? 0;
    blocked(await command(`ping -c 1 -W 1 ${peer.port.ip}`), "overlapping VPC isolation");
    assert.ok(port.getSnapshot().dropReasons.no_vpc_route > routedDrops);
    assert.deepEqual(receivedIcmp(peer.port, port.ip, peer.port.ip), []);
    report("overlapping VPC isolation blocks the same peer IP", { lastDrop: port.getSnapshot().lastDrop });

    await peer.configure("a", "one", "10.52.1.11");
    result = success(await command(`ping -c 1 -W 3 ${peer.port.ip}`), "direct LAN ping");
    assert.match(result.output, /ttl=64/);
    peer.port.setPolicy({ ingress: [], egress: ALLOW_ALL_POLICY.egress });
    blocked(await command(`ping -c 1 -W 1 ${peer.port.ip}`), "ingress policy");
    assert.ok(peer.port.getSnapshot().dropReasons.ingress_policy > 0);
    peer.port.setPolicy(ALLOW_ALL_POLICY);
    success(await command(`ping -c 1 -W 3 ${peer.port.ip}`), "restored LAN policy");
    report("mixed-backend direct Ethernet and enforced ingress policy");

    relay = await createRelayFixture({
      key: await readFile(join(temporary, "key.pem")), cert: await readFile(join(temporary, "cert.pem")),
    });
    port.configureTransport({ kind: "wisp", relayUrl: relay.url });
    assert.equal(relay.acceptedSockets, 0, "Selecting a relay with World off must not connect.");
    port.setMode("world");
    await until(() => port.getSnapshot().connectionState === "connected", "verified Wisp connection");
    result = success(await command("nslookup fixture.example"), "Wisp DNS");
    assert.match(result.output, /198\.18\./);
    result = success(await command(`wget -T 10 -qO- ${relay.guestUrl}`), "Wisp HTTP");
    assert.equal(result.output, "Terrarium TCP over secure Wisp is real.\n");
    assert.equal(relay.requests[0].hostname, "fixture.example");
    assert.equal(relay.requests[0].port, Number(new URL(relay.guestUrl).port));
    success(await command(`ping -c 1 -W 3 ${peer.port.ip}`), "LAN with World enabled");
    report("real x86_64 DNS and arbitrary-port HTTP/TCP through certificate-verified loopback Wisp", { hostname: relay.requests[0].hostname });

    const pending = command(`wget -T 6 -qO- ${relay.heldGuestUrl}`, 20_000);
    // Observe the actual upstream request before cutting World, rather than
    // relying on an arbitrary timer which might fire before the guest connects.
    await until(() => relay.heldRequests === 1, "an active guest TCP response");
    port.setMode("local");
    await until(() => relay.activeSockets === 0 && relay.activeUpstreams === 0 && relay.heldRequests === 0, "World off to close relay and upstream sockets");
    const cut = await pending;
    assert.equal(cut.status, "exited", JSON.stringify(cut));
    assert.notEqual(cut.exitCode, 0);
    const opened = relay.acceptedSockets;
    blocked(await command(`wget -T 2 -qO- ${relay.guestUrl}`, 15_000), "new TCP request with World off");
    assert.equal(relay.acceptedSockets, opened);
    assert.equal(port.getSnapshot().connectionState, "off");
    report("World off aborts an existing TCP response, closes relay/upstream sockets and denies new connections", { guestExitCode: cut.exitCode });

    port.setMode("world");
    await until(() => port.getSnapshot().connectionState === "connected", "explicit Wisp reconnection");
    result = success(await command(`wget -T 10 -qO- ${relay.guestUrl}`), "reconnected Wisp HTTP");
    assert.equal(result.output, "Terrarium TCP over secure Wisp is real.\n");
    assert.equal(relay.acceptedSockets, opened + 1);
    report("explicit World enable creates one fresh secure Wisp connection");

    const recordedTcpFlows = port.getFlowLog(200).filter((flow) => flow.protocol === "tcp").length;
    assert.ok(recordedTcpFlows > 0);
    port.clearDiagnostics(); peer.port.clearDiagnostics();
    port.setMode("isolated");
    await until(() => relay.activeSockets === 0, "isolated mode to close World");
    blocked(await command(`ping -c 1 -W 1 ${peer.port.ip}`), "isolated x86_64 egress");
    assert.deepEqual(receivedIcmp(peer.port, port.ip, peer.port.ip), []);
    assert.notEqual((await peer.run(`ping -c 1 -W 1 ${port.ip}`)).exitCode, 0);
    assert.deepEqual(receivedIcmp(port, peer.port.ip, port.ip), []);
    report("isolated x86_64 machine neither sends nor receives peer traffic");
    port.setMode("local");
    success(await command(`ping -c 1 -W 3 ${peer.port.ip}`), "local reconnection");

    assert.ok(port.getSnapshot().capture.packets > 0);
    assert.ok(peer.port.getSnapshot().capture.packets > 0);
    const pcap = port.exportPcap();
    const view = new DataView(pcap.buffer, pcap.byteOffset, pcap.byteLength);
    assert.equal(view.getUint32(0, true), 0xa1b2c3d4);
    assert.ok(pcap.byteLength > 24);
    report("real mixed-backend traffic is available in bounded flow diagnostics and Ethernet PCAP", { capture: port.getSnapshot().capture, pcapBytes: pcap.byteLength, recordedTcpFlows });
    report("complete x86_64 Wisp and mixed-backend VPC integration");
  } catch (error) {
    if (failureStacks) await failureStacks.captureFailure({ runtime, error, reason: "original-mixed-network-smoke-failure" });
    console.error("Recent x86_64 guest output:\n" + qemuTail);
    console.error("Recent v86 peer output:\n" + peerTail);
    console.error("Network state:", JSON.stringify(network.getSnapshot()));
    console.error("Recent QEMU flows:", JSON.stringify(port.getFlowLog(200)));
    console.error("Recent peer flows:", JSON.stringify(peer?.port.getFlowLog(200)));
    console.error("Owned worker input counts:", JSON.stringify([...workers].map((worker) => ({ id: worker.id, inputs: worker.guestInputMessages }))));
    if (runtime.getSnapshot().status === "running") {
      try {
        await runtime.pause();
        console.error("Failure diagnosis: the private monitor still acknowledged CPU pause after the guest command failed.");
      } catch (failure) { console.error("Failure diagnosis: private CPU pause also failed:", failure); }
    }
    throw error;
  } finally {
    unsubscribe();
    port.dispose();
    peer?.port.dispose();
    const teardown = await Promise.allSettled([runtime.destroy(), peer?.emulator.destroy(), relay?.close()]);
    if (!runner.isBusy()) runner.dispose();
    for (const worker of [...workers]) worker.terminate();
    await joinTeardown();
    restoreStartup();
    failureStacks?.reportComplete();
    Object.assign(globalThis, native);
    const failures = teardown.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, "Mixed-backend network teardown failed.");
  }
}

if (process.argv[2] === "--tls-fixture") {
  await smoke(process.argv[3]);
  harnessComplete = true;
  process.send?.({ completed: true });
} else {
  const temporary = await mkdtemp(join(tmpdir(), "terrarium-qemu-network-"));
  try {
    await promisify(execFile)("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", join(temporary, "key.pem"), "-out", join(temporary, "cert.pem"),
      "-days", "1", "-subj", "/CN=fixture.example",
      "-addext", "subjectAltName=DNS:fixture.example,DNS:localhost,IP:127.0.0.1",
    ], { timeout: 30_000 });
    const existingCa = process.env.NODE_EXTRA_CA_CERTS ? await readFile(process.env.NODE_EXTRA_CA_CERTS) : Buffer.alloc(0);
    await writeFile(join(temporary, "trust.pem"), Buffer.concat([existingCa, Buffer.from("\n"), await readFile(join(temporary, "cert.pem"))]));
    await new Promise((resolve, reject) => {
      let completed = false;
      const diagnosticArgs = process.env.TERRARIUM_QEMU_FAILURE_STACKS === "1" ? [String(Date.now() + 600_000)] : [];
      const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url), "--tls-fixture", temporary, ...diagnosticArgs], {
        stdio: ["inherit", "inherit", "inherit", "ipc"],
        env: { ...process.env, NODE_EXTRA_CA_CERTS: join(temporary, "trust.pem") },
      });
      // The watchdog is outside the guest process, so it remains effective if
      // either emulator stalls its Node event loop. Killing that process also
      // tears down every QEMU pthread and the v86 peer it owns.
      const deadline = setTimeout(() => {
        console.error("The mixed-backend network smoke exceeded its ten-minute deadline.");
        child.kill("SIGKILL");
      }, 600_000);
      child.on("message", (message) => { if (message?.completed === true) completed = true; });
      child.once("exit", (code, signal) => console.error(JSON.stringify({ event: "network-guest-process-exit", pid: child.pid, code, signal, completed })));
      child.once("error", (error) => { clearTimeout(deadline); reject(error); });
      child.once("close", (code, signal) => {
        clearTimeout(deadline);
        if (code === 0 && completed) resolve();
        else reject(new Error(`Mixed-backend network smoke did not complete (exit ${code}, signal ${signal}).`));
      });
    });
    harnessComplete = true;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
