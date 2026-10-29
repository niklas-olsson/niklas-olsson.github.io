// SPDX-License-Identifier: Apache-2.0
// Real Chromium, the packaged app, production isolation worker, and real QEMU.
// Cached emulator/guest responses keep their pinned bytes and pass app hashing.
// No replacement Worker, SharedArrayBuffer, IndexedDB, or guest implementation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, mkdir, writeFile, lstat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, release, arch, cpus, totalmem } from "node:os";
import { chromium } from "playwright";
import { serveBuiltApplication } from "./static-server.mjs";
import { DEFAULT_QEMU_BUNDLE_ID, LEGACY_QEMU_BUNDLE_ID } from "../../public/runtime/qemu/catalog.js";
import { getQemuBundle } from "../../public/runtime/qemu/bundles.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const buildRoot = resolve(process.env.TERRARIUM_BROWSER_BUILD_DIR ?? join(root, "dist"));
const mode = process.argv.find(value => value.startsWith("--mode="))?.slice(7) ?? "all";
assert.ok(["all", "failures", "guest", "checkpoint-import"].includes(mode), "Use --mode=all, --mode=failures, --mode=guest, or --mode=checkpoint-import");
assert.ok(process.argv.slice(2).every(value => value.startsWith("--mode=")), "Unknown browser harness option");
const cache = process.env.TERRARIUM_QEMU_ASSET_DIR ?? process.env.TERRARIUM_QEMU_CACHE;
assert.ok(cache, "Set TERRARIUM_QEMU_ASSET_DIR to the hash-verified QEMU asset cache (run npm run runtime:cache:qemu or scripts/cache-qemu-assets.mjs).");
const reportPath = resolve(process.env.TERRARIUM_BROWSER_REPORT ?? join(root, ".cache/test-results/s1-browser-results.json"));
const manifestBytes = await readFile(join(root, "public/runtime/qemu/provenance.json"));
const catalogBytes = await readFile(join(root, "public/runtime/qemu/catalog.js"));
const expectedBundle = getQemuBundle(process.env.TERRARIUM_QEMU_BUNDLE_ID ?? DEFAULT_QEMU_BUNDLE_ID);
const importPath = process.env.TERRARIUM_BROWSER_CHECKPOINT_IMPORT ? resolve(process.env.TERRARIUM_BROWSER_CHECKPOINT_IMPORT) : null;
const exportPath = process.env.TERRARIUM_BROWSER_CHECKPOINT_EXPORT ? resolve(process.env.TERRARIUM_BROWSER_CHECKPOINT_EXPORT) : null;
assert.ok(mode !== "checkpoint-import" || importPath, "--mode=checkpoint-import requires TERRARIUM_BROWSER_CHECKPOINT_IMPORT");
assert.ok(!importPath || expectedBundle.id !== LEGACY_QEMU_BUNDLE_ID, "Cross-default checkpoint evidence requires a registered default different from the saved legacy runtime");
assert.ok(!importPath || (importPath !== exportPath && importPath !== reportPath), "Checkpoint input must not also be an output path");
assert.ok(!exportPath || exportPath !== reportPath, "Checkpoint and report outputs must use different paths");
if (exportPath) {
  let existing = false;
  try { await lstat(exportPath); existing = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
  assert.equal(existing, false, "Checkpoint export refuses to overwrite existing evidence; choose a new path");
}
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const playwrightPackage = JSON.parse(await readFile(join(root, "node_modules/playwright/package.json"), "utf8"));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const assets = new Map();
const bundleCaches = [{ bundle: expectedBundle, directory: resolve(cache) }];
if (expectedBundle.id !== LEGACY_QEMU_BUNDLE_ID && process.env.TERRARIUM_LEGACY_QEMU_ASSET_DIR) bundleCaches.push({ bundle: getQemuBundle(LEGACY_QEMU_BUNDLE_ID), directory: resolve(process.env.TERRARIUM_LEGACY_QEMU_ASSET_DIR) });
assert.ok(!importPath || bundleCaches.some(({ bundle }) => bundle.id === LEGACY_QEMU_BUNDLE_ID), "Legacy checkpoint import requires its exact cache via TERRARIUM_LEGACY_QEMU_ASSET_DIR when the build default is owned");
for (const { bundle, directory } of bundleCaches) {
  for (const [key, asset] of Object.entries(bundle.assets)) {
    const path = join(directory, basename(new URL(asset.url, "https://catalog.invalid/").pathname));
    const bytes = await readFile(path);
    assert.equal(bytes.length, asset.bytes, `${bundle.id}/${key} cached size`);
    assert.equal(digest(bytes), asset.sha256, `${bundle.id}/${key} cached SHA-256`);
    const existing = assets.get(asset.url);
    if (existing) assert.equal(existing.sha256, asset.sha256, "A shared pinned URL cannot identify different runtime bytes");
    else assets.set(asset.url, { ...asset, key, path, bundleId: bundle.id, fixtureKey: `${bundle.id}/${key}` });
  }
}

async function buildIdentity(directory, prefix = "") {
  const directoryInfo = await lstat(directory);
  assert.ok(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink(), `Build directory must be a real directory: ${directory}`);
  const entries = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) entries.push(...await buildIdentity(join(directory, entry.name), name + "/"));
    else if (entry.isFile()) {
      const bytes = await readFile(join(directory, entry.name));
      entries.push({ path: name, bytes: bytes.length, sha256: digest(bytes) });
    } else throw new Error(`Build identity refuses symlinks/nonregular entries: ${name}`);
  }
  return entries;
}
const builtFiles = await buildIdentity(buildRoot);
assert.ok(builtFiles.some(file => file.path === "index.html"), "Run npm run build before browser validation");
const packagedCatalog = builtFiles.find(file => file.path === "runtime/qemu/catalog.js");
assert.equal(packagedCatalog?.sha256, digest(catalogBytes), "The served worker catalog must match the source catalog used to select and verify test assets; rebuild after catalog changes");
const entryHtml = await readFile(join(buildRoot, "index.html"), "utf8");
const entryScripts = [...entryHtml.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map(match => {
  const path = match[1].replace(/^\.\//, "");
  const entry = builtFiles.find(file => file.path === path);
  assert.ok(entry, `HTML entry script is not identified in this packaged build: ${match[1]}`);
  return entry;
});
assert.ok(entryScripts.length, "The built HTML must reference an identified application entry script");
const packagedPins = [];
for (const { bundle } of bundleCaches) {
  const local = [
    { role: "manifest", path: `runtime/qemu/${bundle.manifest.file}`, ...bundle.manifest },
    { role: "pthread", path: `runtime/qemu/${bundle.pthread.file}`, ...bundle.pthread },
    ...Object.entries(bundle.assets).filter(([, asset]) => !/^https:\/\//.test(asset.url)).map(([role, asset]) => ({ role, path: asset.url.replace(/^\.\//, ""), ...asset })),
  ];
  for (const pin of local) {
    const packaged = builtFiles.find(file => file.path === pin.path);
    assert.ok(packaged, `Selected local runtime artifact is absent from the packaged build: ${pin.path}`);
    assert.equal(packaged.bytes, pin.bytes, `${pin.path} packaged size`);
    assert.equal(packaged.sha256, pin.sha256, `${pin.path} packaged SHA-256`);
    packagedPins.push({ bundleId: bundle.id, role: pin.role, ...packaged });
  }
}
const report = {
  schema: "terrarium.browser-validation/v1", startedAt: new Date().toISOString(), mode,
  evidenceClass: "browser-e2e", version: packageJson.version,
  invocation: { argv: [process.execPath, ...process.execArgv, ...process.argv.slice(1)], inputs: { buildDirectory: buildRoot, assetDirectory: resolve(cache), expectedBuildBundleId: expectedBundle.id, legacyAssetDirectory: process.env.TERRARIUM_LEGACY_QEMU_ASSET_DIR ? resolve(process.env.TERRARIUM_LEGACY_QEMU_ASSET_DIR) : null, checkpointImportPath: importPath, checkpointExportPath: exportPath, chromiumExecutable: process.env.TERRARIUM_CHROMIUM_EXECUTABLE ?? "playwright-managed", browserSandboxDisabled: process.env.TERRARIUM_BROWSER_NO_SANDBOX === "1" } },
  testedSource: process.env.TERRARIUM_TESTED_SOURCE_ID ?? "unfrozen-working-tree-preliminary",
  builtArtifact: { directory: buildRoot, sha256: digest(JSON.stringify(builtFiles)), entryScripts, files: builtFiles, verifiedRuntimePins: packagedPins },
  runtimeAndImageIds: { catalogSha256: digest(catalogBytes), ...(expectedBundle.id === LEGACY_QEMU_BUNDLE_ID ? { provenanceSha256: digest(manifestBytes) } : { legacyProvenanceSha256: digest(manifestBytes) }), runtimeCompatibility: expectedBundle.id, manifest: expectedBundle.manifest, pthread: expectedBundle.pthread, assets: Object.fromEntries(Object.entries(expectedBundle.assets).map(([key, asset]) => [key, { bytes: asset.bytes, sha256: asset.sha256 }])), cachedBundles: bundleCaches.map(({ bundle, directory }) => ({ runtimeCompatibility: bundle.id, directory, manifest: bundle.manifest, pthread: bundle.pthread, assets: Object.fromEntries(Object.entries(bundle.assets).map(([key, asset]) => [key, { bytes: asset.bytes, sha256: asset.sha256 }])) })) },
  environment: { node: process.version, playwright: playwrightPackage.version, platform: platform(), release: release(), architecture: arch(), cwd: process.cwd(), temporaryDirectory: process.env.TMPDIR ?? null, browser: null },
  limitations: ["Pinned guest/emulator requests are redirected to a verified local streaming cache; upstream availability and real internet latency are not measured. The production app still performs its normal size and SHA-256 verification.", "The app is served over localhost without host isolation headers. The production service worker supplies isolation after explicit UI activation.", "This harness does not make the upstream runtime an owned/rebuilt artifact or satisfy all S1-G4 guest-parity requirements by itself."],
  cases: [], status: "running",
};
try { report.environment.logicalCpus = cpus().length; report.environment.hostTotalMemoryBytes = totalmem(); } catch { report.environment.hostResourceObservation = "unavailable"; }
await mkdir(dirname(reportPath), { recursive: true });
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
let browser; let server;
const deadline = setTimeout(async () => {
  report.status = "failed";
  report.harnessError = "Browser validation exceeded its 20-minute overall deadline.";
  report.completedAt = new Date().toISOString();
  await save();
  await browser?.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
  console.error("S1_BROWSER_DEADLINE_EXCEEDED");
  process.exit(1);
}, 20 * 60_000);

async function executeCase(id, procedure, task) {
  const record = { id, procedure, status: "running", startedAt: new Date().toISOString(), evidenceClass: "browser-e2e", observations: {} };
  report.cases.push(record); await save();
  const started = performance.now();
  console.log(`RUN ${id}: ${procedure}`);
  try {
    record.observations = await task(); record.status = "passed";
    console.log(`PASS ${id}`);
  } catch (error) {
    record.status = "failed"; record.error = error.stack ?? String(error);
    if (error.browserEvidence) record.observations = error.browserEvidence;
    console.error(`FAIL ${id}: ${error.stack ?? error}`);
  } finally {
    record.durationMs = Math.round(performance.now() - started); record.completedAt = new Date().toISOString(); await save();
  }
}

async function freshPage({ prefix = "/", corruptAsset = null, holdAsset = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, serviceWorkers: "allow" });
  let releaseHeld; const held = new Promise(resolveHeld => { releaseHeld = resolveHeld; });
  let settleHeld; const heldSettled = new Promise(resolveSettled => { settleHeld = resolveSettled; });
  const observed = { errors: [], console: [], failedRequests: [], assetRequests: [], workersCreated: 0, workersClosed: 0 };
  const requestAssets = new Map([...assets.values()].map(asset => [new URL(asset.url, server.origin + prefix).href, asset]));
  await context.route(url => requestAssets.has(url.href), async route => {
    const asset = requestAssets.get(route.request().url()); observed.assetRequests.push(asset.key);
    if (asset.key === holdAsset) await held;
    try {
      // Keep large binaries on the real browser HTTP stream, not base64 CDP messages.
      const target = `${server.origin}/__browser-fixtures/qemu/${encodeURIComponent(asset.fixtureKey)}${asset.key === corruptAsset ? "?corrupt=1" : ""}`;
      await route.fulfill({ status: 307, headers: { Location: target, "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin" } });
    } catch (error) {
      // An aborted fetch can finish after cancelBoot. Other route failures are retained.
      if (!/closed|cancel|abort|invalid interception/i.test(String(error))) observed.errors.push(String(error));
    } finally { if (asset.key === holdAsset) settleHeld(); }
  });
  const page = await context.newPage(); page.setDefaultTimeout(30_000);
  page.on("pageerror", error => observed.errors.push(error.message));
  page.on("crash", () => observed.errors.push("Chromium page crashed"));
  page.on("console", message => {
    const text = message.text();
    if (text.startsWith("S1_BROWSER_BOOT_PROGRESS ")) console.log(text);
    if (["error", "warning"].includes(message.type()) && observed.console.length < 40) observed.console.push({ type: message.type(), text: text.slice(0, 2000) });
  });
  context.on("requestfailed", request => { if (observed.failedRequests.length < 40) observed.failedRequests.push({ url: request.url(), failure: request.failure() }); });
  page.on("worker", worker => { observed.workersCreated++; worker.on("close", () => observed.workersClosed++); });
  await page.goto(server.origin + prefix, { waitUntil: "networkidle" });
  await ready(page);
  return { context, page, observed, releaseHeld, heldSettled, close: async () => {
    releaseHeld();
    try { if (browser.isConnected()) await context.close(); }
    catch (cleanupError) {
      const primary = readinessErrors.get(page);
      if (!primary) throw cleanupError;
      (primary.browserEvidence.readinessFailure.cleanupErrors ??= []).push({ phase: "context-close",
        error: String(cleanupError?.stack ?? cleanupError).slice(0, 2_000) });
      throw primary;
    }
  } };
}

// Failure evidence only. This never takes a workspace lock, reloads a page,
// retries readiness, changes the predicate, or submits guest input.
const readinessErrors = new WeakMap();
async function observeReadinessFailure(page, waitElapsedMs) {
  const began = performance.now(), deadline = began + 2_000;
  const observation = { kind: "readiness-failure-diagnostic", at: new Date().toISOString(),
    readinessTimeoutMs: 30_000, waitElapsedMs, diagnosticBudgetMs: 2_000,
    predicate: "window.terrarium.cloud && workspace.status().mode === writable",
    pageClosed: page.isClosed(), url: null, document: null, webLocks: null, errors: [] };
  const boundedText = value => String(value).slice(0, 2_000);
  const retain = (phase, error) => observation.errors.push({ phase, name: error?.name ?? null,
    code: error?.code ?? null, error: boundedText(error?.stack ?? error) });
  const inspect = async (phase, action) => {
    let timer;
    try {
      const remaining = deadline - performance.now();
      const expired = () => Object.assign(new Error("Readiness diagnostic exceeded its shared 2000 ms budget"), { code: "S1_READINESS_DIAGNOSTIC_DEADLINE" });
      if (remaining <= 0) throw expired();
      const value = await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
        timer = setTimeout(() => reject(expired()), Math.ceil(remaining));
      })]);
      if (performance.now() >= deadline) throw expired();
      return value;
    } catch (error) { retain(phase, error); return null; }
    finally { clearTimeout(timer); }
  };
  try { observation.url = boundedText(page.url()); } catch (error) { retain("page-url", error); }
  observation.document = await inspect("document-workspace", () => page.evaluate(() => {
    const text = (value, maximum = 2_000) => value == null ? null : String(value).slice(0, maximum);
    let workspaceState = null, workspaceObservationError = null;
    try {
      const state = window.terrarium?.workspace?.status?.();
      if (state) workspaceState = { mode: text(state.mode, 64), error: text(state.error),
        revision: typeof state.revision === "number" && Number.isFinite(state.revision) ? state.revision : null,
        updatedAt: typeof state.updatedAt === "number" && Number.isFinite(state.updatedAt) ? state.updatedAt : null };
    } catch (error) { workspaceObservationError = text(error?.stack ?? error); }
    const controller = navigator.serviceWorker?.controller;
    return { url: text(location.href), documentUrl: text(document.URL), baseUri: text(document.baseURI),
      readyState: document.readyState, visibilityState: document.visibilityState,
      title: text(document.title, 256), bodyPresent: Boolean(document.body),
      rootPresent: Boolean(document.getElementById("root")), rootChildCount: document.getElementById("root")?.childElementCount ?? null,
      terrariumPresent: Boolean(window.terrarium), cloudPresent: Boolean(window.terrarium?.cloud),
      workspacePresent: Boolean(window.terrarium?.workspace), workspaceStatusType: typeof window.terrarium?.workspace?.status,
      workspaceState, workspaceObservationError, isolated: globalThis.crossOriginIsolated === true,
      sharedMemory: typeof SharedArrayBuffer !== "undefined", secureContext: globalThis.isSecureContext === true,
      serviceWorkerAvailable: Boolean(navigator.serviceWorker),
      controller: controller ? { scriptUrl: text(controller.scriptURL), state: text(controller.state, 64) } : null };
  }));
  observation.webLocks = await inspect("web-locks-query", () => page.evaluate(async () => {
    if (typeof navigator.locks?.query !== "function") return { available: false };
    const snapshot = await navigator.locks.query();
    const bounded = entries => ({ count: entries.length, truncated: entries.length > 32,
      entries: entries.slice(0, 32).map(entry => ({ name: String(entry.name).slice(0, 256),
        mode: String(entry.mode).slice(0, 32), clientId: entry.clientId == null ? null : String(entry.clientId).slice(0, 128) })) });
    return { available: true, held: bounded(snapshot.held), pending: bounded(snapshot.pending) };
  }));
  observation.pageClosedAfter = page.isClosed(); observation.elapsedMs = Math.round(performance.now() - began);
  return observation;
}
async function ready(page) {
  const began = performance.now();
  try {
    await page.waitForFunction(() => window.terrarium?.cloud && window.terrarium?.workspace?.status().mode === "writable", null, { timeout: 30_000 });
    readinessErrors.delete(page);
  } catch (error) {
    let diagnostic;
    try { diagnostic = await observeReadinessFailure(page, Math.round(performance.now() - began)); }
    catch (diagnosticError) { diagnostic = { kind: "readiness-failure-diagnostic", readinessTimeoutMs: 30_000,
      errors: [{ phase: "diagnostic-setup", error: String(diagnosticError?.stack ?? diagnosticError).slice(0, 2_000) }] }; }
    error.browserEvidence = { ...(error.browserEvidence ?? {}), readinessFailure: diagnostic };
    readinessErrors.set(page, error);
    console.error("S1_BROWSER_READINESS_FAILURE " + JSON.stringify(diagnostic));
    throw error;
  }
}
async function createGuest(page, suffix) {
  return page.evaluate(async ({ name, expectedBundleId }) => {
    const machine = await window.terrarium.cloud.instances.create({ name, imageId: "alpine-x86_64" }).wait();
    if (window.terrarium.get(machine.id).status().runtimeBundle?.defaultBootBundleId !== expectedBundleId) throw new Error("The served application does not use the expected registered build-time default.");
    await window.terrarium.cloud.instances.setNetwork(machine.id, "local").wait();
    return machine.id;
  }, { name: `browser-${suffix}`, expectedBundleId: expectedBundle.id });
}
async function enableIsolation(page) {
  assert.equal(await page.evaluate(() => crossOriginIsolated), false);
  await page.getByRole("button", { name: "Workspace & storage", exact: true }).first().click();
  await page.getByRole("button", { name: "Enable x86_64 & reload", exact: true }).click();
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Enable, stop & reload", exact: true }).click(),
  ]);
  await ready(page);
  const support = await page.evaluate(() => ({ isolated: crossOriginIsolated, sharedMemory: typeof SharedArrayBuffer !== "undefined", controller: navigator.serviceWorker.controller?.scriptURL }));
  assert.equal(support.isolated, true); assert.equal(support.sharedMemory, true); assert.match(support.controller, /terrarium-isolation\.js$/);
  return support;
}
async function startWithoutAwaiting(page, id) {
  await page.evaluate(id => { window.__terrariumBrowserStart = window.terrarium.get(id).boot().then(() => ({ ok: true }), error => ({ ok: false, error: error.message })); }, id);
}
async function cancelAndMeasure(page, id) {
  const result = await page.evaluate(async id => {
    const started = performance.now();
    const status = await window.terrarium.get(id).cancelBoot();
    return { status: status.status, cancelDurationMs: Math.round(performance.now() - started) };
  }, id);
  if (result.cancelDurationMs > 5000) {
    const error = new Error(`Boot cancellation exceeded the declared 5-second objective: ${result.cancelDurationMs}ms`);
    error.browserEvidence = { cancellation: result }; throw error;
  }
  return result;
}
async function assertInactive(page, id, status = "idle") {
  await page.waitForFunction(({ id, status }) => {
    const machine = window.terrarium.get(id).status();
    return machine.status === status && !machine.commandReady;
  }, { id, status });
  const deadline = Date.now() + 10_000;
  while (page.workers().length && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 50));
  assert.equal(page.workers().length, 0, "No real dedicated QEMU worker may remain after failure/teardown");
  const snapshot = await page.evaluate(id => window.terrarium.get(id).status(), id);
  await page.getByRole("button", { name: "Playground", exact: true }).first().click();
  // The shipped UI renders LINK UP only while the real port is attached and ready.
  // Read that user-facing observation instead of introducing a privileged test API.
  const link = page.locator(".network-controls .network-address").filter({ hasText: "LINK ON BOOT" }).first();
  await link.waitFor();
  return { status: snapshot.status, networkLinkLabel: "LINK ON BOOT", commandReady: snapshot.commandReady, workers: page.workers().length };
}

async function inspectStoredCheckpoint(page, title) {
  // Read the actual browser store without moving hundreds of MB through CDP.
  // Only metadata and an independently calculated digest leave the browser.
  return page.evaluate(async title => {
    const db = await new Promise((resolveOpen, rejectOpen) => {
      const request = indexedDB.open("terrarium-snapshots-v1", 1);
      request.onsuccess = () => resolveOpen(request.result);
      request.onerror = () => rejectOpen(request.error);
    });
    try {
      const stored = await new Promise((resolveRead, rejectRead) => {
        const tx = db.transaction(["metadata", "state"], "readonly");
        let metadata; let buffer;
        const all = tx.objectStore("metadata").getAll();
        all.onsuccess = () => {
          const matches = all.result.filter(record => record.title === title);
          if (matches.length !== 1) { tx.abort(); return; }
          metadata = matches[0];
          const state = tx.objectStore("state").get(metadata.id);
          state.onsuccess = () => { buffer = state.result; };
        };
        tx.oncomplete = () => resolveRead({ metadata, buffer });
        tx.onerror = () => rejectRead(tx.error ?? new Error("Checkpoint read failed"));
        tx.onabort = () => rejectRead(tx.error ?? new Error("Exactly one stored checkpoint was required"));
      });
      if (!(stored.buffer instanceof ArrayBuffer)) throw new Error("Checkpoint state is not an ArrayBuffer");
      const digest = await crypto.subtle.digest("SHA-256", stored.buffer);
      return { metadata: stored.metadata, bytes: stored.buffer.byteLength, sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("") };
    } finally { db.close(); }
  }, title);
}

async function observeKernelLogging(page, id) {
  return page.evaluate(async id => {
    const vm = window.terrarium.get(id);
    const marker = "TRM_BROWSER_KERNEL_" + crypto.randomUUID().replaceAll("-", "");
    const injectCommand = [
      "set -e",
      "_trm_level=$(cat /proc/sys/kernel/printk)",
      "_trm_level=${_trm_level%%[[:space:]]*}",
      '[ "$_trm_level" = 0 ]',
      `printf '<4>${marker}\\n' > /dev/kmsg`,
      "printf 'command-output-only'",
    ].join("\n");
    const retainCommand = `dmesg | grep -F '${marker}'`;
    const observation = { marker, commands: { inject: injectCommand, retain: retainCommand }, command: null, commandError: null, retained: null, retainedError: null };
    try { observation.command = await vm.exec(injectCommand); }
    catch (error) { observation.commandError = error.stack ?? String(error); }
    // Do not issue another request after a failed or blocked command channel.
    if (observation.command?.status === "exited" && observation.command.exitCode === 0) {
      try { observation.retained = await vm.exec(retainCommand); }
      catch (error) { observation.retainedError = error.stack ?? String(error); }
    }
    return observation;
  }, id);
}

function assertKernelLogging(observation) {
  assert.equal(observation.command?.status, "exited", JSON.stringify(observation));
  assert.equal(observation.command.exitCode, 0, JSON.stringify(observation.command));
  assert.equal(observation.command.output, "command-output-only", "An actual kernel warning must not enter ordinary command stdout");
  assert.equal(observation.retained?.status, "exited", JSON.stringify(observation));
  assert.equal(observation.retained?.exitCode, 0, JSON.stringify(observation));
  assert.ok(observation.retained.output.includes(observation.marker), "The actual kernel warning must remain available in the dmesg ring");
}

async function checkpointRoundTrip(page, id, observations) {
  const title = "S1 browser cold checkpoint";
  const card = () => page.locator("article.snapshot-card").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  const binaryExpected = digest(Buffer.from([0, 1, 127, 128, 255]));
  const seed = await page.evaluate(async id => {
    const vm = window.terrarium.get(id);
    vm.setInitScript("printf 'UNEXPECTED_RESTORE_INIT\\n' > /tmp/browser-init-script");
    return vm.exec("printf '\\000\\001\\177\\200\\377' > /tmp/browser-binary; printf 'SAVED_CHECKPOINT_MARKER\\n' > /tmp/browser-init-script; sha256sum /tmp/browser-binary");
  }, id);
  assert.equal(seed.status, "exited"); assert.equal(seed.exitCode, 0); assert.match(seed.output, new RegExp(`^${binaryExpected} `));
  await page.getByRole("button", { name: "Snapshots & evidence", exact: true }).first().click();
  await page.getByRole("button", { name: "New snapshot", exact: true }).click();
  await page.getByLabel("Snapshot name", { exact: true }).fill(title);
  console.log(`S1_BROWSER_PHASE ${JSON.stringify({ phase: "checkpoint-save-start", sourceId: id })}`);
  const saveStarted = performance.now();
  await page.getByRole("button", { name: "Save in browser", exact: true }).click();
  await card().waitFor({ state: "visible", timeout: 180_000 });
  observations.saveDurationMs = Math.round(performance.now() - saveStarted);
  observations.before = await inspectStoredCheckpoint(page, title);
  console.log(`S1_BROWSER_PHASE ${JSON.stringify({ phase: "checkpoint-stored", durationMs: observations.saveDurationMs, bytes: observations.before.bytes, sha256: observations.before.sha256 })}`);
  assert.equal(observations.before.metadata.runtime, expectedBundle.id);
  assert.equal(observations.before.metadata.kind, "qemu-checkpoint");
  assert.equal(observations.before.metadata.sha256, observations.before.sha256);
  assert.equal(observations.before.metadata.size, observations.before.bytes);
  assert.equal(await card().locator(".snapshot-digest").getAttribute("title"), observations.before.sha256);
  if (exportPath) {
    const path = exportPath;
    await mkdir(dirname(path), { recursive: true });
    const downloading = page.waitForEvent("download");
    await card().getByRole("button", { name: `Download ${title}`, exact: true }).click();
    const download = await downloading;
    await download.saveAs(path);
    const hash = createHash("sha256"); let bytes = 0;
    for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
    observations.export = { path, bytes, sha256: hash.digest("hex"), filename: download.suggestedFilename() };
    assert.equal(observations.export.bytes, observations.before.bytes);
    assert.equal(observations.export.sha256, observations.before.sha256);
  }
  const sourceState = await page.evaluate(async id => {
    const vm = window.terrarium.get(id);
    const beforeMutation = vm.status();
    const altered = await vm.exec("printf 'MUTATED_AFTER_SAVE\\n' > /tmp/browser-unicode; printf 'CHANGED' > /tmp/browser-binary; cat /tmp/browser-unicode");
    const afterMutation = vm.status();
    const transcripts = [0, 1, 2, 3].map(port => ({ port, tail: vm.readOutput({ port }).slice(-4096) }));
    let failurePause = null;
    if (altered.status !== "exited" || altered.exitCode !== 0) {
      const began = performance.now();
      try { failurePause = { status: (await vm.pause()).status, durationMs: Math.round(performance.now() - began) }; }
      catch (error) { failurePause = { error: error.message, durationMs: Math.round(performance.now() - began), status: vm.status().status }; }
    }
    const started = performance.now(); await window.terrarium.cloud.instances.stop(id).wait();
    return { altered, beforeMutation, afterMutation, transcripts, failurePause, registerObservation: "No live register reader is exposed by the shipped browser API; saved checkpoint registers are not substituted for this failed live state.", teardownDurationMs: Math.round(performance.now() - started) };
  }, id);
  observations.sourceState = sourceState;
  console.log(`S1_BROWSER_PHASE ${JSON.stringify({ phase: "post-save-command", result: sourceState.altered, status: sourceState.afterMutation.status, message: sourceState.afterMutation.message, controlReady: sourceState.afterMutation.controlReady, failurePause: sourceState.failurePause, transcriptTail: sourceState.transcripts[0].tail.slice(-1200) })}`);
  assert.equal(sourceState.altered.status, "exited", JSON.stringify(sourceState.altered));
  assert.equal(sourceState.altered.exitCode, 0, JSON.stringify(sourceState.altered));
  assert.equal(sourceState.altered.output, "MUTATED_AFTER_SAVE\n");
  assert.ok(sourceState.teardownDurationMs <= 20_000, `Worker teardown exceeded 20 seconds: ${sourceState.teardownDurationMs}ms`);
  observations.sourceInactive = await assertInactive(page, id);
  await page.reload({ waitUntil: "networkidle" }); await ready(page);
  const cold = await page.evaluate(id => ({ source: window.terrarium.get(id).status(), isolated: crossOriginIsolated }), id);
  assert.equal(cold.source.status, "idle"); assert.equal(cold.source.commandReady, false);
  assert.equal(cold.source.runtimeBundle.activeBundleId, null); assert.equal(cold.isolated, true); assert.equal(page.workers().length, 0);
  observations.coldPage = { sourceStatus: cold.source.status, workers: page.workers().length, isolated: cold.isolated };
  assert.deepEqual(await inspectStoredCheckpoint(page, title), observations.before, "Reload must preserve the exact original checkpoint bytes and metadata");
  await restorePreservedCheckpoint(page, title, observations, id);
}

async function restorePreservedCheckpoint(page, title, observations, sourceId = null) {
  const binaryExpected = digest(Buffer.from([0, 1, 127, 128, 255]));
  const card = () => page.locator("article.snapshot-card").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  const existing = await page.evaluate(() => window.terrarium.list().map(machine => machine.id));
  await page.getByRole("button", { name: "Snapshots & evidence", exact: true }).first().click();
  await card().getByRole("button", { name: "Inspect", exact: true }).click();
  const restoreStarted = performance.now();
  await page.getByRole("button", { name: "Create paused quarantine clone", exact: true }).click();
  await page.waitForFunction(existing => window.terrarium.list().some(machine => !existing.includes(machine.id) && machine.status === "paused" && machine.operation === null), existing, { timeout: 180_000 });
  const clone = await page.evaluate(existing => window.terrarium.list().find(machine => !existing.includes(machine.id))?.id, existing);
  assert.ok(clone, "Paused checkpoint restore must create an independent machine");
  observations.restoreDurationMs = Math.round(performance.now() - restoreStarted);
  observations.cloneId = clone;
  const paused = await page.evaluate(async id => {
    const vm = window.terrarium.get(id); let command; let world;
    try { await vm.exec("printf 'MUST_NOT_RUN'"); command = "unexpected execution"; } catch (error) { command = error.message; }
    try { await window.terrarium.cloud.instances.setNetwork(id, "world").wait(); world = "unexpected World access"; } catch (error) { world = error.message; }
    return { status: vm.status(), instance: await window.terrarium.cloud.instances.get(id), command, world };
  }, clone);
  observations.paused = paused;
  console.log(`S1_BROWSER_PHASE ${JSON.stringify({ phase: "cold-checkpoint-paused", durationMs: observations.restoreDurationMs, status: paused.status.status, passiveRestore: paused.status.passiveRestore, runtimeBundle: paused.status.runtimeBundle, sourceCheckpointSha256: paused.status.sourceCheckpointSha256 })}`);
  assert.equal(paused.status.status, "paused"); assert.equal(paused.status.passiveRestore, true); assert.equal(paused.status.init.status, "skipped");
  assert.equal(paused.status.commandReady, false); assert.notEqual(paused.command, "unexpected execution");
  assert.equal(paused.status.runtimeBundle.activeBundleId, observations.before.metadata.runtime);
  assert.equal(paused.status.runtimeBundle.defaultBootBundleId, expectedBundle.id);
  assert.equal(paused.status.sourceCheckpointSha256, observations.before.sha256);
  assert.equal(paused.instance.quarantined, true); assert.equal(paused.instance.ephemeral, true); assert.equal(paused.instance.networkMode, "isolated");
  assert.match(paused.world, /quarantin/i);
  const resumed = await page.evaluate(id => window.terrarium.get(id).resume(), clone);
  observations.resumedStatus = resumed.status;
  // The older checkpoint may preserve its original printk console level.
  // Observe the production policy only after the user's explicit resume.
  observations.resumedKernelLogging = await observeKernelLogging(page, clone);
  assertKernelLogging(observations.resumedKernelLogging);
  const restored = await page.evaluate(async id => {
    const vm = window.terrarium.get(id);
    const files = await vm.exec("cat /tmp/browser-unicode; cat /tmp/browser-init-script; sha256sum /tmp/browser-binary; printf 'CLONE_CHANGED_AFTER_READ\\n' > /tmp/browser-unicode");
    const started = performance.now(); await window.terrarium.cloud.instances.stop(id).wait();
    return { files, teardownDurationMs: Math.round(performance.now() - started), stopped: vm.status(), instance: await window.terrarium.cloud.instances.get(id) };
  }, clone);
  restored.resumed = resumed.status;
  observations.restored = restored;
  console.log(`S1_BROWSER_PHASE ${JSON.stringify({ phase: "restored-command", result: restored.files, teardownDurationMs: restored.teardownDurationMs })}`);
  assert.equal(restored.resumed, "running"); assert.equal(restored.files.status, "exited"); assert.equal(restored.files.exitCode, 0);
  assert.equal(restored.files.output, `Terrarium åäö ☘\nSAVED_CHECKPOINT_MARKER\n${binaryExpected}  /tmp/browser-binary\n`);
  assert.equal(restored.stopped.status, "idle"); assert.equal(restored.stopped.commandReady, false);
  assert.equal(restored.instance.quarantined, true); assert.equal(restored.instance.networkMode, "isolated");
  assert.ok(restored.teardownDurationMs <= 20_000, `Restored worker teardown exceeded 20 seconds: ${restored.teardownDurationMs}ms`);
  const until = Date.now() + 10_000;
  while (page.workers().length && Date.now() < until) await new Promise(resolveWait => setTimeout(resolveWait, 50));
  assert.equal(page.workers().length, 0);
  observations.after = await inspectStoredCheckpoint(page, title);
  assert.deepEqual(observations.after, observations.before, "Restoring and mutating a clone must preserve the source checkpoint");
  await page.evaluate(async ({ sourceId, clone }) => { await window.terrarium.cloud.instances.delete(clone).wait(); if (sourceId) await window.terrarium.cloud.instances.delete(sourceId).wait(); }, { sourceId, clone });
  assert.equal(await page.evaluate(({ sourceId, clone }) => window.terrarium.list().some(machine => machine.id === sourceId || machine.id === clone), { sourceId, clone }), false);
  assert.deepEqual(await inspectStoredCheckpoint(page, title), observations.before, "Deleting machines must preserve the independently stored checkpoint");
  observations.independentCheckpointPreservedAfterMachineDeletion = true;
}

try {
  server = await serveBuiltApplication(buildRoot, new Map([...assets.values()].map(asset => [asset.fixtureKey, asset])));
  browser = await chromium.launch({ headless: true, chromiumSandbox: process.env.TERRARIUM_BROWSER_NO_SANDBOX !== "1", ...(process.env.TERRARIUM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.TERRARIUM_CHROMIUM_EXECUTABLE } : {}), args: process.env.TERRARIUM_BROWSER_NO_SANDBOX === "1" ? ["--no-sandbox"] : [] });
  report.environment.browser = browser.version(); report.environment.origin = server.origin;
  report.environment.chromiumSandboxDisabled = process.env.TERRARIUM_BROWSER_NO_SANDBOX === "1";
  await save();

  if (["all", "failures"].includes(mode)) {
    await executeCase("isolation-unavailable", "Boot from a fresh real browser context before isolation activation; verify refusal and zero workers", async () => {
      const test = await freshPage();
      try {
        const id = await createGuest(test.page, "no-isolation");
        const result = await test.page.evaluate(async id => { try { await window.terrarium.get(id).boot(); return { ok: true }; } catch (error) { return { ok: false, error: error.message }; } }, id);
        assert.equal(result.ok, false); assert.match(result.error, /shared memory|enable|isolat/i);
        return { result, inactive: await assertInactive(test.page, id, "error"), ...test.observed };
      } finally { await test.close(); }
    });
    await executeCase("conflicting-service-worker", "Install a real unrelated overlapping service worker; production UI must refuse replacement and remain on the page", async () => {
      const test = await freshPage();
      try {
        const before = await test.page.evaluate(async () => { await navigator.serviceWorker.register("/__browser-fixtures/conflict-worker.js", { scope: "/" }); await navigator.serviceWorker.ready; return (await navigator.serviceWorker.getRegistration("/")).active.scriptURL; });
        await test.page.reload(); await ready(test.page);
        await test.page.getByRole("button", { name: "Workspace & storage", exact: true }).first().click();
        await test.page.getByRole("button", { name: "Enable x86_64 & reload", exact: true }).click();
        await test.page.getByRole("button", { name: "Enable, stop & reload", exact: true }).click();
        const error = test.page.getByRole("alert").filter({ hasText: /Another application/ }).first();
        await error.waitFor();
        const after = await test.page.evaluate(() => navigator.serviceWorker.controller?.scriptURL);
        assert.equal(after, before); assert.equal(await test.page.evaluate(() => crossOriginIsolated), false);
        return { before, after, error: await error.innerText(), workers: test.page.workers().length };
      } finally { await test.close(); }
    });
    for (const prefix of ["/", "/terrarium/"]) {
      await executeCase(prefix === "/" ? "production-isolation-root" : "production-isolation-subpath", "Activate production isolation through the UI and verify scope after controlled reload", async () => {
        const test = await freshPage({ prefix });
        try { const support = await enableIsolation(test.page); assert.equal(support.controller, server.origin + prefix + "terrarium-isolation.js"); return support; }
        finally { await test.close(); }
      });
    }
    await executeCase("unsupported-x86_64-hardware", "Reject unsupported memoryMiB and virtualCpus overrides through the real cloud API before operation, inventory, or Worker allocation", async () => {
      const test = await freshPage(); let observations = {};
      try {
        observations.support = await enableIsolation(test.page);
        const result = await test.page.evaluate(async () => {
          const before = window.terrarium.list().map(machine => machine.id).sort();
          const attempts = [];
          for (const [key, value] of [["memoryMiB", 1024], ["virtualCpus", 2]]) {
            const input = { name: `unsupported-${key}`, imageId: "alpine-x86_64", [key]: value };
            let operationReturned = false; let rejection = null;
            try {
              const operation = window.terrarium.cloud.instances.create(input);
              operationReturned = true;
              await operation.wait();
            } catch (error) { rejection = { code: error.code ?? null, message: error.message }; }
            attempts.push({ key, input, operationReturned, rejection, inventoryAfter: window.terrarium.list().map(machine => machine.id).sort() });
          }
          return { before, attempts };
        });
        observations = { ...observations, ...result, workers: test.page.workers().length };
        for (const attempt of result.attempts) {
          assert.equal(attempt.operationReturned, false, "Unsupported hardware must be rejected before an operation handle is submitted");
          assert.equal(attempt.rejection?.code, "unsupported", JSON.stringify(attempt));
          assert.equal(attempt.rejection.message, `x86_64 instance creation has unsupported option "${attempt.key}". x86_64 uses fixed hardware and boot assets from its registered profile; overrides and arbitrary emulator arguments are not supported.`);
          assert.deepEqual(attempt.inventoryAfter, result.before, "Unsupported hardware must not allocate an instance");
        }
        assert.equal(test.page.workers().length, 0); assert.equal(test.observed.workersCreated, 0);
        return { ...observations, ...test.observed };
      } catch (error) { error.browserEvidence = { ...(error.browserEvidence ?? {}), ...observations, ...test.observed }; throw error; }
      finally { await test.close(); }
    });
    await executeCase("bad-asset-sha256", "Corrupt one byte of a pinned asset with unchanged length; production hash validation must reject before Worker creation", async () => {
      const test = await freshPage({ corruptAsset: "module" });
      try {
        await enableIsolation(test.page); const id = await createGuest(test.page, "bad-hash"); await startWithoutAwaiting(test.page, id);
        const result = await test.page.evaluate(() => window.__terrariumBrowserStart);
        assert.equal(result.ok, false); assert.match(result.error, /integrity check/);
        const inactive = await assertInactive(test.page, id, "error"); assert.equal(test.observed.workersCreated, 0);
        return { result, inactive, ...test.observed };
      } finally { await test.close(); }
    });
    await executeCase("cancel-during-download", "Hold a real fetch response, cancel boot through the production API, then release the late response and verify no reactivation", async () => {
      const test = await freshPage({ holdAsset: "wasm" });
      try {
        await enableIsolation(test.page); const id = await createGuest(test.page, "cancel-load"); await startWithoutAwaiting(test.page, id);
        const until = Date.now() + 30_000; while (!test.observed.assetRequests.includes("wasm") && Date.now() < until) await new Promise(resolveWait => setTimeout(resolveWait, 25));
        assert.ok(test.observed.assetRequests.includes("wasm"));
        const cancellation = await cancelAndMeasure(test.page, id); test.releaseHeld();
        await test.heldSettled;
        const result = await test.page.evaluate(() => window.__terrariumBrowserStart); assert.equal(result.ok, false);
        const inactive = await assertInactive(test.page, id);
        await test.page.waitForTimeout(300); assert.equal(await test.page.evaluate(id => window.terrarium.get(id).status().status, id), "idle");
        assert.equal(test.observed.workersCreated, 0);
        return { result, cancellation, inactive, ...test.observed };
      } finally { await test.close(); }
    });
    await executeCase("worker-load-failure", "Return HTTP 503 for the real dedicated-worker entry script and verify runtime/port failure cleanup", async () => {
      const test = await freshPage(); const priorResponses = server.controls.workerFailureResponses; server.controls.failWorker = true;
      try {
        await enableIsolation(test.page); const id = await createGuest(test.page, "worker-failure"); await startWithoutAwaiting(test.page, id);
        const result = await test.page.evaluate(() => window.__terrariumBrowserStart); assert.equal(result.ok, false);
        assert.equal(server.controls.workerFailureResponses - priorResponses, 1, "The intentional worker503 must actually reach the browser");
        assert.match(result.error, /worker failed to load/i);
        return { result, workerFailureResponses: server.controls.workerFailureResponses - priorResponses, inactive: await assertInactive(test.page, id, "error"), ...test.observed };
      } finally { server.controls.failWorker = false; await test.close(); }
    });
  }

  if (["all", "guest"].includes(mode)) {
    await executeCase("real-guest-boot-control-teardown", "Boot actual pinned x86_64 Linux in Chromium, verify UART/control parity, save to IndexedDB, stop/reload, restore a paused quarantine clone, explicitly resume and verify saved files, then delete machines while preserving the checkpoint", async () => {
      const test = await freshPage();
      let id;
      const phaseObservations = {};
      try {
        const support = await enableIsolation(test.page); id = await createGuest(test.page, "actual-guest");
        const started = performance.now();
        const boot = await test.page.evaluate(async id => {
          const vm = window.terrarium.get(id); const began = performance.now();
          window.__terrariumBootObservations = [];
          let last = ""; let lastProgressMs = -15_000;
          const observe = () => {
            const state = vm.status();
            const elapsedMs = Math.round(performance.now() - began);
            const value = { status: state.status, message: state.message, controlReady: state.controlReady, sessions: state.sessions, resourceObservation: state.resourceObservation };
            const identity = JSON.stringify(value);
            if (identity !== last && window.__terrariumBootObservations.length < 64) {
              last = identity; window.__terrariumBootObservations.push({ elapsedMs, ...value });
            }
            if (elapsedMs - lastProgressMs >= 15_000) {
              lastProgressMs = elapsedMs;
              console.info("S1_BROWSER_BOOT_PROGRESS " + JSON.stringify({ elapsedMs, ...value, transcripts: [0, 1, 2, 3].map(port => ({ port, tail: vm.readOutput({ port }).slice(-768) })) }));
            }
          };
          const timer = setInterval(observe, 100); observe();
          try { return await vm.boot(); } finally { observe(); clearInterval(timer); }
        }, id);
        assert.equal(boot.status, "running"); assert.equal(boot.commandReady, true);
        assert.equal(boot.runtimeBundle?.defaultBootBundleId, expectedBundle.id, "Built application must use the explicitly selected registered default");
        assert.equal(boot.runtimeBundle?.activeBundleId, expectedBundle.id);
        assert.deepEqual(boot.sessions.map(session => [session.port, session.status]), [[1, "ready"], [2, "ready"], [3, "ready"]]);
        const bootMs = Math.round(performance.now() - started);
        phaseObservations.bootMs = bootMs;
        phaseObservations.bootObservations = await test.page.evaluate(() => window.__terrariumBootObservations);
        phaseObservations.resourceObservation = boot.resourceObservation;
        assert.equal(boot.resourceObservation?.source, "emulator-memory-buffer");
        assert.equal(boot.resourceObservation.observedWasmMemoryBytes, expectedBundle.resources.reservedWasmMiB * 1024 * 1024, "Observed Wasm buffer must match the selected runtime's declared fixed reservation");
        phaseObservations.kernelLogging = await observeKernelLogging(test.page, id);
        assertKernelLogging(phaseObservations.kernelLogging);
        const results = await test.page.evaluate(async id => {
          const vm = window.terrarium.get(id);
          const uname = await vm.exec("uname -m; uname -r; cat /etc/alpine-release; printf '\\nBROWSER_CONTROL_OK\\n'");
          const unicode = await vm.exec("printf 'Terrarium åäö ☘\\n' > /tmp/browser-unicode; cat /tmp/browser-unicode");
          const nonzero = await vm.exec("printf 'NONZERO_STATUS'; exit 7");
          const pause = await vm.pause(); let pausedCommand;
          try { await vm.exec("true"); pausedCommand = "unexpected execution"; } catch (error) { pausedCommand = error.message; }
          const resume = await vm.resume(); const preserved = await vm.exec("cat /tmp/browser-unicode");
          return { uname, unicode, nonzero, pause: pause.status, pausedCommand, resume: resume.status, preserved };
        }, id);
        phaseObservations.results = results;
        assert.equal(results.uname.status, "exited"); assert.equal(results.uname.exitCode, 0); assert.match(results.uname.output, /x86_64/); assert.match(results.uname.output, /BROWSER_CONTROL_OK/);
        assert.ok(results.uname.output.split("\n").includes(expectedBundle.guest.kernel), "The actual guest kernel must match the selected image identity");
        assert.equal(results.unicode.status, "exited"); assert.equal(results.unicode.exitCode, 0); assert.equal(results.unicode.output, "Terrarium åäö ☘\n");
        assert.equal(results.nonzero.status, "exited"); assert.equal(results.nonzero.exitCode, 7);
        assert.equal(results.pause, "paused"); assert.notEqual(results.pausedCommand, "unexpected execution"); assert.equal(results.resume, "running");
        assert.equal(results.preserved.status, "exited"); assert.equal(results.preserved.exitCode, 0); assert.equal(results.preserved.output, results.unicode.output);
        phaseObservations.checkpoint = {};
        await checkpointRoundTrip(test.page, id, phaseObservations.checkpoint);
        assert.deepEqual(test.observed.errors, []);
        return { support, ...phaseObservations, runtimeBundle: boot.runtimeBundle, resourceObservation: boot.resourceObservation, results, ...test.observed };
      } catch (error) {
        error.browserEvidence = { ...(error.browserEvidence ?? {}), ...phaseObservations, ...test.observed, guest: await test.page.evaluate(id => {
          if (!id) return null;
          const vm = window.terrarium.get(id);
          return { status: vm.status(), bootObservations: window.__terrariumBootObservations ?? [], transcripts: [0, 1, 2, 3].map(port => ({ port, tail: vm.readOutput({ port }).slice(-16_384) })) };
        }, id).catch(failure => ({ observationError: String(failure) })) };
        throw error;
      } finally { await test.close(); }
    });
  }
  if (["all", "guest", "failures"].includes(mode)) {
    await executeCase("cancel-during-worker-start", "Cancel after the real QEMU Worker exists, then verify shutdown and no delayed ready/port reactivation", async () => {
      const test = await freshPage();
      try {
        await enableIsolation(test.page); const id = await createGuest(test.page, "cancel-worker");
        const workerCreated = test.page.waitForEvent("worker", { predicate: worker => worker.url().endsWith("/runtime/qemu/worker.js") });
        await startWithoutAwaiting(test.page, id); await workerCreated;
        const cancellation = await cancelAndMeasure(test.page, id);
        const result = await test.page.evaluate(() => window.__terrariumBrowserStart); assert.equal(result.ok, false);
        const inactive = await assertInactive(test.page, id);
        await test.page.waitForTimeout(500); assert.equal(await test.page.evaluate(id => window.terrarium.get(id).status().status, id), "idle");
        assert.ok(test.observed.workersCreated >= 1);
        return { result, cancellation, inactive, ...test.observed };
      } finally { await test.close(); }
    });
  }
  if (importPath && mode !== "failures") {
    await executeCase("legacy-checkpoint-under-selected-default", "Import the actual legacy browser checkpoint download into the selected-default build, reload its IndexedDB state, restore an independent paused legacy quarantine clone, explicitly resume and verify saved files, then preserve original bytes after clone deletion", async () => {
      const test = await freshPage(); const observations = {};
      try {
        observations.support = await enableIsolation(test.page);
        const hash = createHash("sha256"); let bytes = 0;
        for await (const chunk of createReadStream(importPath)) { hash.update(chunk); bytes += chunk.length; }
        observations.input = { path: importPath, bytes, sha256: hash.digest("hex") };
        await test.page.getByRole("button", { name: "Snapshots & evidence", exact: true }).first().click();
        const choosing = test.page.waitForEvent("filechooser");
        await test.page.getByRole("button", { name: "Import", exact: true }).click();
        await (await choosing).setFiles(importPath);
        await test.page.getByRole("button", { name: "Create paused quarantine clone", exact: true }).waitFor({ state: "visible", timeout: 180_000 });
        const title = basename(importPath).replace(/\.bin$/i, "").trim().slice(0, 80) || "Untitled experiment";
        observations.before = await inspectStoredCheckpoint(test.page, title);
        assert.equal(observations.before.metadata.runtime, LEGACY_QEMU_BUNDLE_ID);
        assert.equal(observations.before.bytes, observations.input.bytes);
        assert.equal(observations.before.sha256, observations.input.sha256);
        assert.equal(observations.before.metadata.sha256, observations.input.sha256);
        assert.equal(test.page.workers().length, 0, "Import and passive inspection must not start a guest");
        await test.page.reload({ waitUntil: "networkidle" }); await ready(test.page);
        assert.deepEqual(await inspectStoredCheckpoint(test.page, title), observations.before);
        assert.equal(test.page.workers().length, 0);
        await restorePreservedCheckpoint(test.page, title, observations);
        assert.deepEqual(test.observed.errors, []);
        return { ...observations, ...test.observed };
      } catch (error) {
        error.browserEvidence = {
          ...(error.browserEvidence ?? {}), ...observations, ...test.observed,
          machines: await test.page.evaluate(() => window.terrarium?.list()).catch(failure => ({ observationError: String(failure) })),
          machineTranscripts: await test.page.evaluate(() => window.terrarium.list().map(({ id }) => ({
            id, transcripts: [0, 1, 2, 3].map(port => ({ port, tail: window.terrarium.get(id).readOutput({ port }).slice(-16_384) })),
          }))).catch(failure => ({ observationError: String(failure) })),
        };
        throw error;
      } finally { await test.close(); }
    });
  }
  report.status = report.cases.every(test => test.status === "passed") ? "passed" : "failed";
} catch (error) {
  report.status = "blocked"; report.harnessError = error.stack ?? String(error); console.error(report.harnessError);
} finally {
  clearTimeout(deadline);
  await browser?.close(); await server?.close();
  try {
    const finalBuildSha256 = digest(JSON.stringify(await buildIdentity(buildRoot)));
    report.buildVerification = { finalSha256: finalBuildSha256, unchanged: finalBuildSha256 === report.builtArtifact.sha256 };
    if (!report.buildVerification.unchanged) { report.status = "failed"; report.harnessError = "Packaged application files changed during browser validation; this build identity is not accepted."; }
  } catch (error) { report.status = "failed"; report.harnessError = `Unable to verify immutable build output: ${error.message}`; }
  report.completedAt = new Date().toISOString(); await save();
}
console.log(`S1_BROWSER_COMPLETION ${JSON.stringify({ status: report.status, mode, cases: report.cases.map(test => ({ id: test.id, status: test.status })), report: reportPath })}`);
process.exitCode = report.status === "passed" ? 0 : 1;
