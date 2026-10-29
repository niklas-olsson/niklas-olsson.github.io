// SPDX-License-Identifier: Apache-2.0
// Tiny real child processes validate the recorder; no guest or browser is run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { changedSourcePaths } from "./record-validation.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
function recordedChild(args, options) {
  const temporary = mkdtempSync(join(tmpdir(), "terrarium-recorder-fixture-"));
  const paths = [join(temporary, "stdout.log"), join(temporary, "stderr.log")];
  const descriptors = paths.map(path => openSync(path, "wx"));
  try {
    const result = spawnSync(process.execPath, args, { ...options, stdio: ["ignore", ...descriptors] });
    return { ...result, stdout: readFileSync(paths[0], "utf8"), stderr: readFileSync(paths[1], "utf8") };
  } finally { descriptors.forEach(closeSync); rmSync(temporary, { recursive: true }); }
}
test("CLI recorder retains successful, failed, missing-marker and signaled invocations", async () => {
  for (const scenario of [
    { id: "success", script: 'console.log("RECORDER_FIXTURE_COMPLETE"); console.error("stderr retained");', passed: true, code: 0, signal: null },
    { id: "failure", script: 'console.log("RECORDER_FIXTURE_COMPLETE"); process.exitCode = 7;', passed: false, code: 7, signal: null },
    { id: "missing-marker", script: 'console.log("incomplete fixture");', passed: false, code: 0, signal: null },
    { id: "signal", script: 'console.log("RECORDER_FIXTURE_COMPLETE"); process.kill(process.pid, "SIGTERM");', passed: false, code: null, signal: "SIGTERM" },
  ]) {
    const run = recordedChild(["scripts/record-validation.mjs", "--id", `recorder-fixture-${scenario.id}`, "--class", "unit-fixture", "--marker", "RECORDER_FIXTURE_COMPLETE", "--", process.execPath, "-e", scenario.script], {
      cwd: root, encoding: "utf8", env: { ...process.env, RECORDER_TEST_SECRET: "this-must-never-be-recorded", TERRARIUM_TESTED_SOURCE_ID: "previous-caller-hint" },
    });
    assert.equal(run.error, undefined);
    const path = /^VALIDATION_RECORD (.+)$/m.exec(run.stdout)?.[1]; assert.ok(path, run.stderr);
    const recordText = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    const report = JSON.parse(recordText);
    assert.equal(report.execution.status, scenario.passed ? "passed" : "failed");
    assert.equal(report.execution.exitCode, scenario.code);
    assert.equal(report.execution.signal, scenario.signal);
    assert.equal(report.environment.effective.TERRARIUM_TESTED_SOURCE_ID, report.source.before.digest);
    assert.equal(recordText.includes("this-must-never-be-recorded"), false);
    assert.equal(recordText.includes("RECORDER_TEST_SECRET"), false);
    assert.ok(report.execution.startedAt && report.execution.endedAt && report.endedAt);
    assert.equal(report.environment.outputCapture.transport, "inherited-file-descriptors");
    assert.ok(Number.isSafeInteger(report.execution.pid) && report.execution.pid > 0);
    assert.ok(report.artifacts.stdout.sha256 && report.artifacts.stderr.sha256);
    assert.ok(report.source.before.path !== report.source.after.path);
    if (scenario.passed) {
      assert.ok(["passed", "requires-review"].includes(report.result.status));
      assert.equal(run.status, report.source.sourceStable ? 0 : 2, "Concurrent source edits require review while retaining successful execution.");
      assert.equal(await readFile(new URL(`../${report.artifacts.stderr.path}`, import.meta.url), "utf8"), "stderr retained\n");
      assert.equal(await readFile(new URL(`../${report.artifacts.stdout.path}`, import.meta.url), "utf8"), "RECORDER_FIXTURE_COMPLETE\n");
      assert.match(await readFile(new URL(`../${report.source.before.log}`, import.meta.url), "utf8"), /Recorded \d+ source files: [a-f0-9]{64}/);
    } else { assert.equal(report.result.status, "failed"); assert.notEqual(run.status, 0); }
  }
});

test("source changes retain added, removed and modified paths with both identities", () => {
  const before = { files: [{ path: "same", bytes: 1, sha256: "a" }, { path: "changed", bytes: 2, sha256: "b" }, { path: "removed", bytes: 3, sha256: "c" }] };
  const after = { files: [{ path: "same", bytes: 1, sha256: "a" }, { path: "changed", bytes: 2, sha256: "d" }, { path: "added", bytes: 4, sha256: "e" }] };
  const changes = changedSourcePaths(before, after);
  assert.deepEqual(changes.map(({ path, change }) => ({ path, change })), [{ path: "added", change: "added" }, { path: "changed", change: "modified" }, { path: "removed", change: "removed" }]);
  assert.equal(changes[1].before.sha256, "b"); assert.equal(changes[1].after.sha256, "d");
});
