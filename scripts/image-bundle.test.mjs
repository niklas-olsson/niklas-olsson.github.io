// SPDX-License-Identifier: Apache-2.0
// CLI regression uses non-bootable parser fixtures, never a real guest.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fixtureComponents, fixtureManifest } from "../src/lib/machine-image.test-fixtures.ts";

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text) => { stdout += text; }); child.stderr.on("data", (text) => { stderr += text; });
    child.on("error", reject); child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("CLI pack reaches explicit completion, preserves existing outputs, and rejects corrupt components before creating output", async () => {
  const directory = await mkdtemp(join(process.cwd(), "machine-image-cli-fixture-"));
  try {
    const components = fixtureComponents(); const manifest = fixtureManifest(components);
    for (const [kind, bytes] of Object.entries(components)) await writeFile(join(directory, kind), bytes);
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    const script = resolve("scripts/image-bundle.mjs");
    const base = ["--max-old-space-size=32", "--experimental-strip-types", script, "pack", "--manifest", join(directory, "manifest.json"),
      "--kernel", join(directory, "kernel"), "--initramfs", join(directory, "initramfs"), "--rootfs", join(directory, "rootfs")];
    const output = join(directory, "fixture.trmimg"); const report = join(directory, "report.json");
    const run = await runNode([...base, "--output", output, "--report", report]);
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(await readFile(report, "utf8"));
    assert.equal(result.status, "data-validated-not-boot-qualified");
    assert.equal(result.bundleSha256, createHash("sha256").update(await readFile(output)).digest("hex"));
    const inspectReport = join(directory, "inspection.json");
    const inspect = await runNode(["--experimental-strip-types", script, "inspect", "--input", output, "--report", inspectReport]);
    assert.equal(inspect.status, 0, inspect.stderr);
    assert.equal(JSON.parse(await readFile(inspectReport, "utf8")).imageId, result.imageId);
    const existing = join(directory, "preserved.trmimg"); await writeFile(existing, "original user file");
    const duplicate = await runNode([...base, "--output", existing]);
    assert.equal(duplicate.status, 1);
    assert.equal(await readFile(existing, "utf8"), "original user file");
    components.rootfs[components.rootfs.length - 1] = 1; await writeFile(join(directory, "rootfs"), components.rootfs);
    const rejected = join(directory, "must-not-exist.trmimg");
    const bad = await runNode([...base, "--output", rejected]);
    assert.equal(bad.status, 1); assert.equal(existsSync(rejected), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
