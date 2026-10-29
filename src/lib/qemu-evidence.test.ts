// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { createEvidenceArchive, sha256Bytes } from "./evidence.ts";
import { createQemuEvidenceImage, captureQemuEvidenceFiles } from "./qemu-evidence.ts";
import type { EvidenceExecutor } from "./runtime-types.ts";

test("evidence disks preserve immutable inputs and deterministically include large files and Unicode paths", async () => {
  const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, index) => (index * 17 + 31) & 255);
  const archive = await createEvidenceArchive("Read-only view", [
    { path: "/var/data/λ雪.bin", bytes },
    { path: "/etc/empty", bytes: new Uint8Array() },
  ], { method: "guest-assisted-logical", guestExecuted: true });
  const before = JSON.stringify(archive);
  const image = createQemuEvidenceImage(archive);
  assert.equal(image.byteLength, 32 * 1024 * 1024);
  assert.equal(new DataView(image).getUint16(1024 + 56, true), 0xef53);
  assert.equal(await sha256Bytes(image), await sha256Bytes(createQemuEvidenceImage(archive)));
  assert.equal(JSON.stringify(archive), before);
  assert.throws(() => createQemuEvidenceImage({ ...archive, totalBytes: archive.totalBytes + 1 }), /does not match/);
  assert.throws(() => createQemuEvidenceImage({ ...archive, files: [{ ...archive.files[0], path: "/etc/../escape" }] }), /canonical absolute/);
});

test("serial evidence transfer rejects a growing staged file before reading bytes and attempts bounded cleanup", async () => {
  const calls: string[] = [];
  const execute: EvidenceExecutor = async (command) => {
    calls.push(command);
    return { id: "fixture", command, status: "exited", exitCode: 0,
      output: command.includes("wc -c") ? "1048577\n" : "", startedAt: 0, durationMs: 0, recovery: "not_needed" };
  };
  await assert.rejects(captureQemuEvidenceFiles(["/etc/data"], execute, () => {}), /exceeds 1 MiB/);
  assert.equal(calls.some((command) => command.includes("| base64")), false);
  assert.ok(calls.at(-1)?.includes("rmdir"));
});

test("serial evidence transfer rejects malformed chunk data and stale machine ownership", async () => {
  const execute: EvidenceExecutor = async (command) => ({
    id: "fixture", command, status: "exited", exitCode: 0,
    output: command.includes("wc -c") ? "4\n" : command.includes("| base64") ? "bad guest output!\n" : "",
    startedAt: 0, durationMs: 0, recovery: "not_needed",
  });
  await assert.rejects(captureQemuEvidenceFiles(["/etc/data"], execute, () => {}), /invalid binary/);
  let called = false;
  await assert.rejects(captureQemuEvidenceFiles(["/etc/data"], async (command) => { called = true; return execute(command); }, () => { throw new Error("stale machine"); }), /stale machine/);
  assert.equal(called, false);
});
