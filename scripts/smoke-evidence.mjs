// SPDX-License-Identifier: Apache-2.0
// Real Node-host VM integration. Does not cover browser UI or IndexedDB.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { V86 } from "v86";
import "../public/runtime/libv86.js";
import { LinuxRuntime } from "../src/lib/linux-runtime.ts";
import { CommandRunner } from "../src/lib/command-runner.ts";
import { VirtualNetwork } from "../src/lib/network.ts";
import { inspectSnapshot } from "../src/lib/snapshot-format.ts";
import {
  sha256Bytes,
  decodeEvidenceBytes,
  exportEvidenceArchive,
  importEvidenceArchive,
} from "../src/lib/evidence.ts";
const provenance = JSON.parse(
  await readFile(
    new URL("../public/runtime/provenance.json", import.meta.url),
    "utf8",
  ),
);
async function verifiedAsset(file) {
  const asset = provenance.externalGuestAssets.find(
    (entry) => entry.file === file,
  );
  assert.ok(asset, "Missing pinned provenance for " + file);
  let bytes;
  if (process.env.TERRARIUM_VM_ASSET_DIR) {
    bytes = await readFile(
      resolve(
        process.env.TERRARIUM_VM_ASSET_DIR,
        file === "buildroot-bzimage68.bin" ? file : "bios/" + file,
      ),
    );
  } else {
    const response = await fetch(asset.url, {
      signal: AbortSignal.timeout(60000),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok || !response.body)
      throw Error("Could not fetch " + file + " from its upstream host.");
    bytes = new Uint8Array(asset.bytes);
    let received = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (received + value.byteLength > bytes.byteLength)
          throw Error("Unexpected asset size");
        bytes.set(value, received);
        received += value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    assert.equal(received, asset.bytes, "Incomplete upstream asset");
  }
  assert.equal(bytes.byteLength, asset.bytes, "Unexpected " + file + " size");
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    asset.sha256,
    "Unexpected " + file + " digest",
  );
  return [asset.url, bytes];
}
const assets = new Map(
  await Promise.all(
    ["buildroot-bzimage68.bin", "seabios.bin", "vgabios.bin"].map(
      verifiedAsset,
    ),
  ),
);
const instances = [];
class HostV86 extends V86 {
  runCalls = 0;
  constructor(options) {
    super({ ...options, wasm_path: fileURLToPath(options.wasm_path) });
    instances.push(this);
  }
  run() {
    this.runCalls++;
    return super.run();
  }
}
globalThis.window = { setTimeout, clearTimeout, V86: HostV86 };
globalThis.document = { baseURI: new URL("../public/", import.meta.url).href };
globalThis.fetch = async (url) => {
  const asset = assets.get(String(url));
  if (!asset) throw Error("Unexpected URL: " + url);
  return new Response(asset);
};
const report = (name, extra = {}) =>
  console.log(JSON.stringify({ name, passed: true, ...extra }));
const network = new VirtualNetwork();
const sourcePort = network.createPort("source", "192.168.76.10");
const clonePort = network.createPort("clone", "192.168.76.11", {
  quarantined: true,
});
const analystPort = network.createPort("analyst", "192.168.76.12");
const source = new LinuxRuntime({ networkPort: sourcePort });
const clone = new LinuxRuntime({
  networkPort: clonePort,
  initScript: "echo MUST_NOT_RUN > /root/should-not-exist",
});
const analyst = new LinuxRuntime({ networkPort: analystPort });
const sourceRunner = new CommandRunner(source),
  cloneRunner = new CommandRunner(clone),
  analystRunner = new CommandRunner(analyst);
const run = async (runner, command) => {
  const result = await runner.execute(command);
  assert.equal(result.status, "exited", JSON.stringify(result));
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  return result.output;
};
try {
  await source.boot();
  await run(
    sourceRunner,
    "printf 'original checkpoint file\\n' > /root/evidence.txt; printf '\\000\\001\\377ABC' > /root/binary.dat",
  );
  const checkpoint = await source.save();
  const originalDigest = await sha256Bytes(checkpoint);
  const inspection = await inspectSnapshot(checkpoint);
  assert.equal(inspection.sha256, originalDigest);
  assert.equal(inspection.memoryMiB, 128);
  assert.equal(Object.keys(inspection.cpu.generalRegisters).length, 8);
  report(
    "passive format inspection decodes pinned registers and original digest",
    { cpu: inspection.cpu },
  );
  await run(
    sourceRunner,
    "printf changed-after-checkpoint > /root/evidence.txt",
  );
  await clone.restore(checkpoint, { paused: true });
  const paused = instances.at(-1);
  const count = paused.get_instruction_counter();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(paused.runCalls, 0);
  assert.equal(paused.get_instruction_counter(), count);
  assert.equal(clone.getSnapshot().status, "paused");
  assert.equal(clone.getSnapshot().passiveRestore, true);
  assert.equal(clone.getSnapshot().init.status, "skipped");
  assert.equal(clonePort.getSnapshot().quarantined, true);
  assert.throws(() => clonePort.setMode("world"), /quarant/i);
  report("new quarantined clone restores paused without a CPU run", {
    runCalls: paused.runCalls,
    instructions: count,
  });
  await clone.resume();
  assert.equal(
    await run(cloneRunner, "cat /root/evidence.txt"),
    "original checkpoint file\n",
  );
  assert.equal(
    await run(cloneRunner, "test ! -e /root/should-not-exist && echo skipped"),
    "skipped\n",
  );
  assert.equal(
    await run(sourceRunner, "cat /root/evidence.txt"),
    "changed-after-checkpoint",
  );
  report(
    "explicit resume skips init and preserves source machine independence",
  );
  const acquisition = clone.captureEvidence(
    ["/root/evidence.txt", "/root/binary.dat"],
    cloneRunner.executeInternal,
    {
      title: "Guest-assisted test capture",
      machineId: "clone",
      machineName: "clone",
      checkpointSha256: originalDigest,
    },
  );
  await assert.rejects(clone.reset(), /evidence acquisition/);
  await assert.rejects(clone.save(), /evidence acquisition/);
  const archive = await acquisition;
  assert.equal(archive.source.checkpointSha256, originalDigest);
  assert.equal(
    new TextDecoder().decode(
      decodeEvidenceBytes(
        archive.files.find((file) => file.path === "/root/evidence.txt"),
      ),
    ),
    "original checkpoint file\n",
  );
  assert.deepEqual(
    [
      ...decodeEvidenceBytes(
        archive.files.find((file) => file.path === "/root/binary.dat"),
      ),
    ],
    [0, 1, 255, 65, 66, 67],
  );
  assert.equal(
    (await importEvidenceArchive(exportEvidenceArchive(archive))).sha256,
    archive.sha256,
  );
  assert.equal(await sha256Bytes(checkpoint), originalDigest);
  report(
    "binary logical capture is host-hashed, bounded, immutable, and round-trips",
    { files: archive.files.length, sha256: archive.sha256 },
  );
  await source.pause();
  await clone.pause();
  await analyst.attachEvidence(archive);
  assert.equal(analyst.capabilities.snapshots, false);
  await analyst.boot();
  assert.equal(
    await run(analystRunner, "cat /mnt/evidence/files/root/evidence.txt"),
    "original checkpoint file\n",
  );
  assert.match(
    await run(analystRunner, "cat /mnt/evidence/manifest.json"),
    /guest-assisted-logical/,
  );
  const initialWrite = await analystRunner.execute(
    "printf tampered > /mnt/evidence/files/root/evidence.txt",
  );
  assert.notEqual(initialWrite.exitCode, 0);
  await run(analystRunner, "mount -o remount,rw /mnt/evidence");
  const hostWrite = await analystRunner.execute(
    "printf tampered > /mnt/evidence/files/root/evidence.txt",
  );
  assert.notEqual(hostWrite.exitCode, 0);
  assert.ok(analyst.evidenceServer.getDeniedWrites() > 0);
  assert.equal(
    await run(analystRunner, "cat /mnt/evidence/files/root/evidence.txt"),
    "original checkpoint file\n",
  );
  await assert.rejects(analyst.save(), /external read-only views/);
  assert.equal(
    (await importEvidenceArchive(exportEvidenceArchive(archive))).sha256,
    archive.sha256,
  );
  assert.equal(await sha256Bytes(checkpoint), originalDigest);
  report(
    "clean analyst mounts evidence; host rejects mutation even after guest remount rw",
    { deniedWrites: analyst.evidenceServer.getDeniedWrites() },
  );
  report("snapshot investigation and read-only mount smoke complete");
} finally {
  for (const runtime of [source, clone, analyst])
    await runtime.destroy().catch(() => {});
  for (const runner of [sourceRunner, cloneRunner, analystRunner])
    runner.dispose();
  for (const port of [sourcePort, clonePort, analystPort]) port.dispose();
}
