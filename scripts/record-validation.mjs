// SPDX-License-Identifier: Apache-2.0
// Record a real CLI invocation without turning incomplete or drifting runs into passes.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import * as os from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_QEMU_BUNDLE_ID } from "../public/runtime/qemu/catalog.js";
import { getQemuBundle } from "../public/runtime/qemu/bundles.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const classes = new Set(["static-analysis", "unit-fixture", "real-guest-node", "browser-e2e", "resource-measurement", "reproducible-build"]);
const environmentNames = [
  "TERRARIUM_QEMU_BUNDLE_ID", "TERRARIUM_QEMU_ASSET_DIR", "TERRARIUM_LEGACY_QEMU_ASSET_DIR",
  "TERRARIUM_VM_ASSET_DIR", "TERRARIUM_QEMU_CACHE", "TERRARIUM_TESTED_SOURCE_ID", "TERRARIUM_CHROMIUM_EXECUTABLE",
  "TERRARIUM_QEMU_DIAGNOSTICS", "TERRARIUM_QEMU_POLL_EXPERIMENT", "TERRARIUM_QEMU_FAILURE_STACKS", "TMPDIR",
  "TERRARIUM_QEMU_VERBOSE", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS",
  "TERRARIUM_BROWSER_BUILD_DIR", "TERRARIUM_BROWSER_REPORT", "TERRARIUM_BROWSER_NO_SANDBOX",
  "TERRARIUM_BROWSER_CHECKPOINT_IMPORT", "TERRARIUM_S2_PROFILE_DIR", "TERRARIUM_BROWSER_SUPERVISOR_MAX_LAUNCHES",
    "TERRARIUM_S2_HELPER_DIR", "TERRARIUM_S2_IMAGE", "TERRARIUM_UNIT_REPORT", "TERRARIUM_BROWSER_CHECKPOINT_EXPORT",
];
const usage = "node scripts/record-validation.mjs --id NAME --class CLASS --marker LITERAL [--marker LITERAL] [--bundle ID] -- COMMAND [ARG ...]";
const errorRecord = (error) => ({ code: error?.code ?? null, message: String(error?.message ?? error) });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function options(argv) {
  const split = argv.indexOf("--");
  if (split < 0) throw new Error(usage);
  const value = { markers: [], command: argv.slice(split + 1) };
  for (let at = 0; at < split; at += 2) {
    const key = argv[at], argument = argv[at + 1];
    if (!["--id", "--class", "--marker", "--bundle"].includes(key) || argument === undefined || at + 1 >= split)
      throw new Error(usage);
    if (key === "--marker") value.markers.push(argument);
    else {
      const name = key.slice(2);
      if (value[name] !== undefined) throw new Error(`Duplicate ${key}. ${usage}`);
      value[name] = argument;
    }
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value.id ?? "") || !classes.has(value.class)
    || !value.command.length || !value.markers.length || value.markers.some((marker) => !marker || marker.length > 4096))
    throw new Error(usage);
  return value;
}

export function changedSourcePaths(before, after) {
  const first = new Map(before.files.map((file) => [file.path, file]));
  const last = new Map(after.files.map((file) => [file.path, file]));
  return [...new Set([...first.keys(), ...last.keys()])].sort().flatMap((path) => {
    const a = first.get(path), b = last.get(path);
    if (a?.sha256 === b?.sha256 && a?.bytes === b?.bytes) return [];
    return [{ path, change: !a ? "added" : !b ? "removed" : "modified", before: a ?? null, after: b ?? null }];
  });
}

async function observeHost() {
  const measured = (fn) => { try { return { available: true, value: fn() }; } catch (error) { return { available: false, error: errorRecord(error) }; } };
  const paths = ["/proc/self/cgroup", "/sys/fs/cgroup/cpu.max", "/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.high", "/sys/fs/cgroup/cpuset.cpus.effective", "/sys/fs/cgroup/pids.max"];
  const cgroup = Object.fromEntries(await Promise.all(paths.map(async (path) => {
    try { return [path, { available: true, value: (await readFile(path, "utf8")).trim() }]; }
    catch (error) { return [path, { available: false, error: errorRecord(error) }]; }
  })));
  return {
    node: process.version, nodeExecutable: process.execPath, versions: process.versions,
    platform: os.platform(), architecture: os.arch(), kernelRelease: os.release(), hostname: measured(() => os.hostname()),
    logicalCpus: measured(() => os.cpus().length), availableParallelism: measured(() => os.availableParallelism()),
    hostTotalMemoryBytes: measured(() => os.totalmem()), cgroup,
    limitation: "Host totals are not container guarantees or guest RSS. Cgroup files are observations at the recorded paths; membership is recorded separately. The wrapper does not observe a browser version or guest execution itself.",
  };
}

async function sourceSnapshot(directory, phase) {
  const path = join(directory, `source-${phase}.json`);
  const log = join(directory, `source-${phase}.log`);
  const output = await open(log, "wx");
  const child = spawn(process.execPath, [join(root, "scripts/source-manifest.mjs"), "create", path], { cwd: root, stdio: ["ignore", output.fd, output.fd] });
  let failure = null;
  child.once("error", (error) => { failure = errorRecord(error); });
  const completion = await new Promise((yes) => child.once("close", (exitCode, signal) => yes({ exitCode, signal })));
  await output.close();
  if (failure || completion.exitCode !== 0 || completion.signal)
    return { ok: false, path: relative(root, path), log: relative(root, log), ...completion, error: failure };
  const bytes = await readFile(path), manifest = JSON.parse(bytes.toString("utf8"));
  return { ok: true, path: relative(root, path), log: relative(root, log), sha256: hash(bytes), digest: manifest.sourceDigest, manifest };
}

async function writeRecord(path, report) {
  const temporary = path + ".tmp";
  await writeFile(temporary, JSON.stringify(report, null, 2) + "\n");
  await rename(temporary, path);
}

export async function recordValidation(argv) {
  const config = options(argv);
  if (config.bundle && process.env.TERRARIUM_QEMU_BUNDLE_ID && config.bundle !== process.env.TERRARIUM_QEMU_BUNDLE_ID)
    throw new Error("The --bundle selection and TERRARIUM_QEMU_BUNDLE_ID disagree.");
  const bundle = getQemuBundle(config.bundle ?? process.env.TERRARIUM_QEMU_BUNDLE_ID ?? DEFAULT_QEMU_BUNDLE_ID);
  const startedAt = new Date().toISOString(), began = performance.now();
  const directory = join(root, ".cache/validation/checks", startedAt.replace(/[-:.]/g, "") + "-" + config.id + "-" + randomUUID().slice(0, 8));
  await mkdir(directory, { recursive: true });
  const reportPath = join(directory, "result.json");
  const configuredEnvironment = Object.fromEntries(environmentNames.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  const report = {
    schema: "terrarium.cli-validation/v1", id: config.id, evidenceClass: config.class, startedAt, endedAt: null,
    command: { argv: config.command, cwd: root, shell: false },
    environment: { recordedNames: environmentNames, configured: configuredEnvironment, effective: null, host: await observeHost(),
      outputCapture: { transport: "inherited-file-descriptors", completionMarkersChecked: "retained stdout bytes after child close",
        limitation: "Child output is retained directly in the receipt directory rather than relayed through parent pipes. Read those files for live progress." } },
    selectedBundle: bundle,
    execution: { status: "not-started", startedAt: null, endedAt: null, exitCode: null, signal: null, markers: config.markers.map((text) => ({ text, stream: "stdout", observed: false })) },
    source: { before: null, after: null, sourceStable: null, changedPaths: [] },
    artifacts: {}, result: { status: "in-progress", reasons: [] },
    limitations: ["A completed command and stable source provide evidence for review, not an automatic acceptance-gate pass.", "Evidence classes are declared by the caller. Real guest, browser, storage, measurements and reproducibility must still be established by the invoked procedure.", "A killed wrapper retains an incomplete record; it cannot count as a pass."],
  };
  await writeRecord(reportPath, report);
  console.log(`VALIDATION_RECORD ${relative(root, reportPath)}`);
  const before = await sourceSnapshot(directory, "before");
  report.source.before = { ...before, manifest: undefined };
  if (!before.ok) {
    report.result = { status: "failed", reasons: ["source-before-failed"] };
    report.endedAt = new Date().toISOString(); await writeRecord(reportPath, report); return 1;
  }
  const childEnvironment = { ...process.env, TERRARIUM_QEMU_BUNDLE_ID: bundle.id, TERRARIUM_TESTED_SOURCE_ID: before.digest };
  report.environment.effective = Object.fromEntries(environmentNames.filter((key) => childEnvironment[key] !== undefined).map((key) => [key, childEnvironment[key]]));
  report.execution.status = "running"; report.execution.startedAt = new Date().toISOString();
  await writeRecord(reportPath, report);
  const stdoutPath = join(directory, "stdout.log"), stderrPath = join(directory, "stderr.log");
  // Some managed runners cannot relay nested child pipes. Direct descriptors
  // preserve the child's original stdout/stderr bytes and allow exact marker
  // checks after close, without treating an empty/missing transcript as a pass.
  const stdout = await open(stdoutPath, "wx"), stderr = await open(stderrPath, "wx");
  const child = spawn(config.command[0], config.command.slice(1), { cwd: root, env: childEnvironment, shell: false, stdio: ["ignore", stdout.fd, stderr.fd] });
  let spawnError = null, forwardedSignal = null;
  child.once("error", (error) => { spawnError = errorRecord(error); });
  const forward = (signal) => { forwardedSignal = signal; child.kill(signal); };
  const onInterrupt = () => forward("SIGINT"), onTerminate = () => forward("SIGTERM");
  process.on("SIGINT", onInterrupt); process.on("SIGTERM", onTerminate);
  report.execution.pid = child.pid ?? null;
  const completion = new Promise((yes) => child.once("close", (exitCode, signal) => yes({ exitCode, signal })));
  await writeRecord(reportPath, report);
  const completed = await completion;
  process.off("SIGINT", onInterrupt); process.off("SIGTERM", onTerminate);
  const logs = await Promise.allSettled([stdout.close(), stderr.close()]);
  const logErrors = logs.flatMap((value) => value.status === "rejected" ? [errorRecord(value.reason)] : []);
  for (const [name, path] of [["stdout", stdoutPath], ["stderr", stderrPath]]) {
    try {
      const bytes = await readFile(path);
      report.artifacts[name] = { path: relative(root, path), bytes: bytes.length, sha256: hash(bytes) };
      if (name === "stdout") {
        const text = bytes.toString("utf8");
        for (const marker of report.execution.markers) marker.observed = text.includes(marker.text);
      }
    } catch (error) { logErrors.push(errorRecord(error)); }
  }
  const executionPassed = completed.exitCode === 0 && !completed.signal && !spawnError && !forwardedSignal && !logErrors.length && report.execution.markers.every((marker) => marker.observed);
  Object.assign(report.execution, completed, { status: executionPassed ? "passed" : "failed", endedAt: new Date().toISOString(), spawnError, forwardedSignal, logErrors });
  const after = await sourceSnapshot(directory, "after");
  report.source.after = { ...after, manifest: undefined };
  report.source.sourceStable = after.ok ? before.digest === after.digest : false;
  report.source.changedPaths = after.ok ? changedSourcePaths(before.manifest, after.manifest) : [];
  const reasons = [];
  if (!executionPassed) reasons.push("command-failed-signaled-incomplete-or-unlogged");
  if (!after.ok) reasons.push("source-after-failed");
  else if (!report.source.sourceStable) reasons.push("source-changed-review-affected-scope");
  report.result = { status: !executionPassed ? "failed" : report.source.sourceStable ? "passed" : "requires-review", reasons };
  report.endedAt = new Date().toISOString(); report.durationMs = Math.round(performance.now() - began);
  await writeRecord(reportPath, report);
  console.log(`VALIDATION_RESULT ${report.result.status} ${relative(root, reportPath)}`);
  return report.result.status === "passed" ? 0 : report.result.status === "requires-review" ? 2 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await recordValidation(process.argv.slice(2)); }
  catch (error) { console.error(error?.stack ?? String(error)); process.exitCode = 1; }
}
