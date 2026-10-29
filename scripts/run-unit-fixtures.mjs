// SPDX-License-Identifier: Apache-2.0
// One process per fixture file preserves global-test isolation while retaining
// individual TAP cases. Missing, skipped, cancelled or killed tests cannot pass.
import { spawn } from "node:child_process";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const reportPath = resolve(process.env.TERRARIUM_UNIT_REPORT ?? join(root, ".cache/test-results/unit-fixtures.json"));
const files = [...(await readdir(join(root, "src/lib"))).filter(name => name.endsWith(".test.ts")).sort().map(name => `src/lib/${name}`),
  ...(await readdir(join(root, "scripts"))).filter(name => name.endsWith(".test.mjs")).sort().map(name => `scripts/${name}`)];
const report = { schema: "terrarium.unit-file-validation/v1", startedAt: new Date().toISOString(), status: "running", node: process.version,
  testedSource: process.env.TERRARIUM_TESTED_SOURCE_ID ?? null, command: { cwd: root, argv: process.argv }, cases: [] };
await mkdir(dirname(reportPath), { recursive: true });
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
for (const file of files) {
  const argv = ["--experimental-strip-types", "--test", "--test-reporter=tap", "--test-isolation=none", "--test-concurrency=1", file];
  const item = { file, argv: [process.execPath, ...argv], status: "running", startedAt: new Date().toISOString() };
  report.cases.push(item); await save(); console.log(`UNIT_FILE_START ${file}`);
  const child = spawn(process.execPath, argv, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", failure = null, timedOut = false, hardKill;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); hardKill = setTimeout(() => child.kill("SIGKILL"), 5000); }, 120_000);
  child.stdout.on("data", chunk => { process.stdout.write(chunk); output += chunk; if (Buffer.byteLength(output) > 8 * 1048576) { failure = "Per-file TAP log budget exceeded"; child.kill("SIGTERM"); } });
  child.stderr.on("data", chunk => process.stderr.write(chunk));
  child.on("error", error => { failure = String(error); });
  const completion = await new Promise(resolveEnd => child.on("close", (exitCode, signal) => resolveEnd({ exitCode, signal })));
  clearTimeout(timer); clearTimeout(hardKill);
  const counts = Object.fromEntries(["tests", "pass", "fail", "cancelled", "skipped"].map(key => [key, Number([...output.matchAll(new RegExp(`^# ${key} (\\d+)\\s*$`, "gm"))].at(-1)?.[1] ?? NaN)]));
  Object.assign(item, completion, { counts, timedOut, error: failure, completedAt: new Date().toISOString() });
  item.status = completion.exitCode === 0 && completion.signal === null && !failure && !timedOut && counts.tests > 0 && counts.pass === counts.tests && counts.fail === 0 && counts.cancelled === 0 && counts.skipped === 0 ? "passed" : "failed";
  console.log(`UNIT_FILE_COMPLETE ${JSON.stringify({ file, status: item.status, counts })}`); await save();
  if (item.status !== "passed") break;
}
report.status = report.cases.length === files.length && report.cases.every(item => item.status === "passed") ? "passed" : "failed";
report.expectedFiles = files; report.completedAt = new Date().toISOString();
report.passedTests = report.cases.reduce((sum, item) => sum + (item.counts?.pass ?? 0), 0);
await save(); console.log(`S2_UNIT_FIXTURES_COMPLETE ${JSON.stringify({ status: report.status, files: report.cases.length, passedTests: report.passedTests, report: reportPath })}`);
process.exitCode = report.status === "passed" ? 0 : 1;
