// SPDX-License-Identifier: Apache-2.0
// Actual Chromium + packaged UI/API + production workers and origin storage.
// The separately identified helper calls production storage/migration modules;
// it neither replaces guest execution nor substitutes an in-memory database.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, mkdir, writeFile, lstat, statfs } from "node:fs/promises";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, release, arch } from "node:os";
import { chromium } from "playwright";
import { serveBuiltApplication } from "./static-server.mjs";
import { QEMU_BUNDLES, OWNED_QEMU_BUNDLE_ID } from "../../public/runtime/qemu/catalog.js";
import { getQemuBundle } from "../../public/runtime/qemu/bundles.js";
import { runMigrations } from "./s2-browser-migrations.mjs";
import { runPersistence } from "./s2-browser-persistence.mjs";
import { reservePersistentProfile, verifyPersistentProfile } from "./s2-persistent-profile.mjs";
import { attachWorkerLifecycle } from "./s2-worker-lifecycle.mjs";
import { runQuota } from "./s2-browser-quota.mjs";
import { runImages, runUi, checkpointUnavailable } from "./s2-browser-image-ui.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const mode = process.argv.find(value => value.startsWith("--mode="))?.slice(7) ?? "migrations";
assert.ok(["migrations", "storage", "quota", "presets", "persistence", "images", "ui"].includes(mode));
assert.ok(process.argv.slice(2).every(value => value.startsWith("--mode=")));
const buildRoot = resolve(process.env.TERRARIUM_BROWSER_BUILD_DIR ?? join(root, "dist"));
const helperPath = resolve(process.env.TERRARIUM_S2_HELPER_DIR ?? join(root, ".cache/s2-browser-helper"), "s2-browser-helper.js");
const reportPath = resolve(process.env.TERRARIUM_BROWSER_REPORT ?? join(root, `.cache/test-results/s2-browser-${mode}.json`));
const imagePath = process.env.TERRARIUM_S2_IMAGE ? resolve(process.env.TERRARIUM_S2_IMAGE) : mode === "images" ? join(root, ".cache/browser-fixtures/orchard-v2.trmimg") : null;
const expectedBundle = getQemuBundle(process.env.TERRARIUM_QEMU_BUNDLE_ID ?? OWNED_QEMU_BUNDLE_ID);
const hash = value => createHash("sha256").update(value).digest("hex");
async function fileIdentity(path) { const digest = createHash("sha256"); let bytes = 0; for await (const chunk of createReadStream(path)) { bytes += chunk.length; digest.update(chunk); } return { path, bytes, sha256: digest.digest("hex") }; }
async function tree(directory, prefix = "") {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const path = join(directory, entry.name), name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await tree(path, name + "/"));
    else { assert.ok(entry.isFile() && !entry.isSymbolicLink()); const identity = await fileIdentity(path); files.push({ path: name, bytes: identity.bytes, sha256: identity.sha256 }); }
  }
  return files;
}
const buildFiles = await tree(buildRoot), helper = await fileIdentity(helperPath);
assert.ok(buildFiles.some(file => file.path === "index.html"));
assert.equal(buildFiles.find(file => file.path === "runtime/qemu/catalog.js")?.sha256, hash(await readFile(join(root, "public/runtime/qemu/catalog.js"))), "Rebuild after catalog changes");
const blankPath = join(root, "scripts/browser/acceptance-blank.html");
const assets = new Map(), fixtures = new Map([["s2-browser-helper.js", { path: helperPath, contentType: "text/javascript" }], ["blank.html", { path: blankPath, contentType: "text/html" }]]);
const runtimeIdentities = [];
for (const bundle of Object.values(QEMU_BUNDLES)) {
  const pins = [];
  for (const [key, pin] of Object.entries(bundle.assets)) {
    const path = /^https:\/\//.test(pin.url)
      ? process.env.TERRARIUM_LEGACY_QEMU_ASSET_DIR && join(process.env.TERRARIUM_LEGACY_QEMU_ASSET_DIR, basename(new URL(pin.url).pathname))
      : join(root, "public", pin.url.replace(/^\.\//, ""));
    if (!path) continue;
    const identity = await fileIdentity(path);
    assert.equal(identity.bytes, pin.bytes); assert.equal(identity.sha256, pin.sha256);
    const existing = assets.get(pin.url);
    if (existing) assert.equal(existing.sha256, pin.sha256);
    else assets.set(pin.url, { ...pin, key, path, fixtureKey: `${bundle.id}/${key}` });
    pins.push({ key, ...identity });
  }
  runtimeIdentities.push({ id: bundle.id, machineMemoryLayout: bundle.machineMemoryLayout ?? "single-ram-block-v1", resources: bundle.resources, pins, manifest: bundle.manifest, pthread: bundle.pthread });
}
if (imagePath) fixtures.set("orchard.trmimg", { path: imagePath });
const report = {
  schema: "terrarium.s2-browser-validation/v1", mode, evidenceClass: "browser-e2e", startedAt: new Date().toISOString(), status: "running",
  testedSource: process.env.TERRARIUM_TESTED_SOURCE_ID ?? "unfrozen-working-tree-preliminary",
  command: { argv: [process.execPath, ...process.execArgv, ...process.argv.slice(1)], cwd: process.cwd() },
  build: { root: buildRoot, sha256: hash(JSON.stringify(buildFiles)), files: buildFiles }, helper, blankFixture: await fileIdentity(blankPath), runtimeIdentities,
  image: imagePath ? await fileIdentity(imagePath) : null,
  environment: { node: process.version, platform: platform(), kernel: release(), architecture: arch(), browser: null,
    playwright: JSON.parse(await readFile(join(root, "node_modules/playwright/package.json"), "utf8")).version,
    browserExecutable: process.env.TERRARIUM_BROWSER_SUPERVISOR_EXECUTABLE ?? process.env.TERRARIUM_CHROMIUM_EXECUTABLE ?? "playwright-managed",
    sandboxDisabled: process.env.TERRARIUM_BROWSER_NO_SANDBOX === "1", productionOrigin: false },
  limitations: ["Localhost packaged application; production-origin validation is not claimed.", "Exact pinned runtime requests use a verified local streaming cache; internet availability is not measured.",
    "Storage helper calls actual production APIs on Chromium IndexedDB/Web Locks; explicit injected transaction failures are distinct from physical browser quota exhaustion.",
    "Wasm buffer length and cache counters are not total browser resident memory. Browser heap/storage observations retain their actual measurement category."],
  cases: [],
};
await mkdir(dirname(reportPath), { recursive: true });
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
let server, browser, persistentContext, persistentFixtureCreated = false;
let storageContext = null;
const pageWorkerObservers = new WeakMap();
const browserOptions = { headless: true, chromiumSandbox: process.env.TERRARIUM_BROWSER_NO_SANDBOX !== "1",
  ...(process.env.TERRARIUM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.TERRARIUM_CHROMIUM_EXECUTABLE } : {}),
  args: process.env.TERRARIUM_BROWSER_NO_SANDBOX === "1" ? ["--no-sandbox"] : [] };
const contextOptions = { viewport: { width: 1365, height: 900 }, serviceWorkers: "allow" };
async function closePersistentContext(reason) {
  if (!persistentContext) return;
  const context = persistentContext, owner = context.browser();
  const launch = report.environment.persistence.launches.at(-1);
  launch.closeRequestedAt = new Date().toISOString(); launch.closeReason = reason;
  if (owner.isConnected()) {
    // Browser exposes an EventEmitter-style disconnected event, not Page's
    // waitForEvent API. Register before close so a synchronous event is kept.
    let timer, listener;
    const disconnected = new Promise((resolveDisconnect, rejectDisconnect) => {
      listener = () => resolveDisconnect();
      owner.once("disconnected", listener);
      timer = setTimeout(() => rejectDisconnect(new Error("Persistent browser did not disconnect within 30000 ms")), 30_000);
    });
    try { await Promise.all([context.close(), disconnected]); }
    finally { clearTimeout(timer); owner.removeListener("disconnected", listener); }
  }
  else await context.close();
  assert.equal(owner.isConnected(), false, "Closing the persistent context must disconnect its browser");
  launch.closedAt = new Date().toISOString(); launch.disconnected = true;
  persistentContext = null; if (browser === owner) browser = null;
  await save();
}
async function launchPersistentContext() {
  const evidence = report.environment.persistence;
  assert.ok(evidence.launches.length < 2, "Persistence validation permits only two browser launches");
  assert.equal(persistentContext, null, "The previous persistent context must close before restart");
  await verifyPersistentProfile(evidence.profile);
  const launch = { sequence: evidence.launches.length + 1, profile: evidence.profile.path,
    origin: server.origin, startedAt: new Date().toISOString(), browser: null, disconnected: false };
  evidence.launches.push(launch); await save();
  persistentContext = await chromium.launchPersistentContext(evidence.profile.path, { ...browserOptions, ...contextOptions });
  browser = persistentContext.browser(); assert.ok(browser?.isConnected());
  launch.browser = browser.version(); launch.readyAt = new Date().toISOString();
  if (report.environment.browser) assert.equal(launch.browser, report.environment.browser, "The restart must use the same browser version");
  report.environment.browser = launch.browser; await save();
  return persistentContext;
}
// Positive storage has its own single-launch persistent profile. G4 keeps its
// existing two-launch/restart/worker-observer path unchanged.
async function storageBounded(action, label, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs; let timer;
  try {
    const result = await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
    })]);
    assert.ok(performance.now() < deadline, `${label} completed after its deadline`);
    return result;
  } finally { clearTimeout(timer); }
}
async function storageProfileFilesystem(profile) {
  await verifyPersistentProfile(profile);
  const value = await statfs(profile.path);
  return { path: profile.path, device: profile.device, inode: profile.inode,
    filesystemType: value.type, filesystemTypeHex: "0x" + value.type.toString(16), blockBytes: value.bsize,
    totalBytes: value.blocks * value.bsize, freeBytes: value.bfree * value.bsize, availableBytes: value.bavail * value.bsize,
    limitation: "Actual filesystem-backed Chromium storage; tmpfs does not establish physical-disk, power-loss or host-reboot durability." };
}
async function launchStorageContext() {
  assert.equal(mode, "storage");
  const evidence = report.environment.storage;
  assert.equal(evidence.launches.length, 0, "Positive storage permits exactly one fresh browser launch");
  assert.equal(storageContext, null);
  evidence.filesystemBefore = await storageProfileFilesystem(evidence.profile);
  const launch = { sequence: 1, profile: evidence.profile.path, origin: server.origin,
    startedAt: new Date().toISOString(), browser: null, disconnected: false };
  evidence.launches.push(launch); await save();
  // Use Playwright's owned launch timeout, then retain the returned owner
  // before a post-fulfillment deadline check can fail. An outer Promise.race
  // must not discard a context which completed just after its timeout.
  const launchDeadline = performance.now() + 30_000;
  storageContext = await chromium.launchPersistentContext(evidence.profile.path,
    { ...browserOptions, ...contextOptions, timeout: 30_000 });
  browser = storageContext.browser(); assert.ok(browser?.isConnected());
  assert.ok(performance.now() < launchDeadline, "Positive storage browser launch completed after30000ms");
  launch.browser = browser.version(); launch.readyAt = new Date().toISOString();
  report.environment.browser = launch.browser; await save(); return storageContext;
}
async function closeStorageContext(reason) {
  if (!storageContext) return;
  const context = storageContext, owner = context.browser(), evidence = report.environment.storage;
  const launch = evidence.launches.at(-1);
  launch.closeRequestedAt = new Date().toISOString(); launch.closeReason = reason;
  if (owner.isConnected()) {
    let listener;
    const disconnected = new Promise(resolveDisconnect => {
      listener = () => resolveDisconnect(); owner.once("disconnected", listener);
    });
    try { await storageBounded(() => Promise.all([context.close(), disconnected]), "Positive storage browser close", 30_000); }
    finally { owner.removeListener("disconnected", listener); }
  } else await storageBounded(() => context.close(), "Positive storage context close", 30_000);
  assert.equal(owner.isConnected(), false, "Positive storage must close its only owned browser");
  launch.closedAt = new Date().toISOString(); launch.disconnected = true;
  evidence.filesystemAfter = await storageProfileFilesystem(evidence.profile);
  storageContext = null; if (browser === owner) browser = null;
  await save();
}
const deadline = setTimeout(async () => { report.status = "failed"; report.error = "S2 browser harness overall deadline exceeded"; report.completedAt = new Date().toISOString(); await save(); console.error("S2_BROWSER_DEADLINE_EXCEEDED"); await closePersistentContext("harness-deadline").catch(() => {}); await browser?.close().catch(() => {}); await server?.close().catch(() => {}); process.exit(1); }, mode === "storage" ? 35 * 60_000 : 18 * 60_000);
async function run(id, procedure, task) {
  const item = { id, procedure, status: "running", startedAt: new Date().toISOString(), observations: {} }; report.cases.push(item); await save();
  const began = performance.now(); console.log(`RUN ${id}: ${procedure}`);
  try { item.observations = await task(); item.status = "passed"; console.log(`PASS ${id}`); }
  catch (error) { item.status = "failed"; item.error = error.stack ?? String(error); if (error.browserEvidence) item.observations = error.browserEvidence; console.error(`FAIL ${id}: ${item.error}`); }
  finally { item.elapsedMs = Math.round(performance.now() - began); item.completedAt = new Date().toISOString(); await save(); }
}
async function ready(page, { closedOwner } = {}) {
  const began = performance.now(), deadline = began + 30_000;
  const remaining = () => { const ms = deadline - performance.now(); assert.ok(ms > 0, "Workspace readiness exceeded 30000 ms"); return ms; };
  const observe = () => page.evaluate(async () => ({
    workspace: window.terrarium?.workspace?.status(), locks: await navigator.locks.query(),
    manifest: localStorage.getItem("terrarium.workspace.v1"),
    isolated: crossOriginIsolated, url: location.href,
  }));
  let timer, lockRelease = null, beforeTakeControl = null, takeControlRequested = false, readinessStage = "initial-observation";
  try {
    return await Promise.race([ (async () => {
      if (closedOwner) {
        assert.equal(closedOwner.context(), page.context(), "Ownership recovery must stay in the same browser context");
        assert.ok(closedOwner.isClosed(), "Ownership recovery requires a confirmed closed owner page");
        // Startup uses ifAvailable and can refuse while the closed document's
        // lock is still retiring. A read-only tab requires explicit takeover;
        // waiting for automatic promotion is not the product contract.
        await page.waitForFunction(() => {
          return window.terrarium?.cloud && window.terrarium.workspace.status().mode !== "opening";
        }, null, { timeout: remaining() });
        beforeTakeControl = await observe();
        if (beforeTakeControl.workspace.mode === "read-only") {
          // waitForFunction predicates must be synchronous. Await each actual
          // lock query here; a Promise is not a successful boolean observation.
          readinessStage = "lock-release";
          lockRelease = await page.evaluate(async budgetMs => {
            const began = performance.now(); let queries = 0, first = null, last = null;
            while (performance.now() - began < budgetMs) {
              const locks = await navigator.locks.query(); queries++;
              last = { held: locks.held.filter(lock => lock.name === "terrarium-workspace-writer-v1"),
                pending: locks.pending.filter(lock => lock.name === "terrarium-workspace-writer-v1") };
              first ??= last;
              if (last.held.length === 0 && last.pending.length === 0)
                return { queries, first, last, elapsedMs: performance.now() - began };
              await new Promise(resolve => requestAnimationFrame(resolve));
            }
            throw new Error("The closed owner's workspace lock was not released within the readiness budget");
          }, remaining());
          remaining();
          readinessStage = "takeover";
          takeControlRequested = true;
          // Exactly one supported takeover after observed release. Its own
          // ifAvailable request still refuses any intervening live owner.
          await page.evaluate(() => window.terrarium.workspace.takeControl());
        }
      }
      await page.waitForFunction(() => window.terrarium?.cloud && window.terrarium.workspace?.status().mode === "writable", null, { timeout: remaining() });
      remaining();
      return { budgetMs: 30_000, elapsedMs: Math.round(performance.now() - began), takeControlRequested, beforeTakeControl, lockRelease };
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Workspace readiness exceeded 30000 ms")), remaining()); }) ]);
  }
  catch (error) {
    // Failure-only observation cannot promote the page or restart readiness.
    let observationTimer;
    try {
      const readinessFailure = { stage: readinessStage, budgetMs: 30_000, elapsedMs: Math.round(performance.now() - began) };
      error.browserEvidence = { readinessFailure, readiness: await Promise.race([observe(), new Promise((_, reject) => {
        observationTimer = setTimeout(() => reject(new Error("Readiness diagnostic exceeded 5000 ms")), 5000);
      })]).catch(error => ({ observationError: String(error) })), beforeTakeControl, takeControlRequested };
    } finally { clearTimeout(observationTimer); }
    throw error;
  } finally { clearTimeout(timer); }
}
async function fixtureContext() {
  const persistent = mode === "persistence";
  if (persistent) {
    assert.equal(persistentFixtureCreated, false, "G4 has one dedicated persistent fixture");
    persistentFixtureCreated = true;
  }
  let context = persistent ? await launchPersistentContext()
    : mode === "storage" ? await launchStorageContext() : await browser.newContext(contextOptions);
  const observations = { pageErrors: [], consoleErrors: [], workersCreated: 0, workersClosed: 0 };
  let workerLifecycle = null;
  const lifecycleObservers = [];
  if (persistent) Object.defineProperty(observations, "workerLifecycle", {
    enumerable: true, get: () => lifecycleObservers.map(observer => observer.snapshot()),
  });
  const armWorkerObserver = async () => {
    try {
      workerLifecycle = await attachWorkerLifecycle(context.browser(), {
        launchId: "G4-browser-" + report.environment.persistence.launches.length,
        allowedServiceWorkerUrls: [new URL("terrarium-isolation.js", server.origin + "/").href],
      });
      lifecycleObservers.push(workerLifecycle);
    } catch (error) {
      error.browserEvidence = { browser: observations, observerSetup: error.workerLifecycle ?? null };
      throw error;
    }
  };
  if (persistent) await armWorkerObserver();
  const requests = new Map([...assets.values()].map(asset => [new URL(asset.url, server.origin + "/").href, asset]));
  const installRoutes = () => context.route(url => requests.has(url.href), async route => {
    const asset = requests.get(route.request().url());
    await route.fulfill({ status: 307, headers: { Location: server.origin + "/__browser-fixtures/qemu/" + encodeURIComponent(asset.fixtureKey), "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin" } }).catch(error => { if (!/closed|cancel|abort|interception/i.test(String(error))) throw error; });
  });
  const observePage = async page => {
    page.setDefaultTimeout(30_000);
    page.on("pageerror", error => observations.pageErrors.push(error.message));
    page.on("console", value => { const text = value.text(); if (text.startsWith("S2_BROWSER_PROGRESS ")) console.log(text); if (value.type() === "error" && observations.consoleErrors.length < 40) observations.consoleErrors.push(text.slice(0, 4000)); });
    page.on("worker", worker => { observations.workersCreated++; worker.on("close", () => observations.workersClosed++); });
    if (persistent) {
      try { await workerLifecycle.observePage(page); pageWorkerObservers.set(page, workerLifecycle); }
      catch (error) { error.browserEvidence = { browser: observations }; throw error; }
    }
    return page;
  };
  const newPage = async () => observePage(await context.newPage());
  const close = async () => {
    if (mode === "storage") return closeStorageContext("storage-fixture-finally");
    if (!persistent) return context.close();
    let failure;
    const retain = (phase, error) => {
      failure ??= error;
      (observations.workerLifecycleCleanupErrors ??= []).push({ phase, code: error.code ?? null, error: error.stack ?? String(error) });
    };
    if (!workerLifecycle.snapshot().sealed) {
      try { await workerLifecycle.sealForBrowserClose("before-final-browser-shutdown"); }
      catch (error) { retain("connected-worker-cleanup-proof", error); }
    }
    // A failed proof must remain a failure, but never prevents owned cleanup.
    try { await closePersistentContext("fixture-finally"); }
    catch (error) { retain("persistent-browser-close", error); }
    if (!failure) {
      try { workerLifecycle.confirmBrowserClosed(); }
      catch (error) { retain("sealed-browser-disconnect", error); }
    }
    if (failure) throw failure;
  };
  await installRoutes();
  const test = { get context() { return context; }, get workerLifecycle() { return workerLifecycle; },
    page: context.pages().length ? await observePage(context.pages()[0]) : await newPage(),
    observations, newPage, close };
  if (persistent) test.restartBrowser = async () => {
    assert.equal(report.environment.persistence.launches.length, 1, "Only one orderly browser restart is authorized");
    assert.equal(context.pages().reduce((count, page) => count + page.workers().length, 0), 0,
      "The clean browser restart requires the stopped guest's workers to be gone");
    const workerCleanup = await workerLifecycle.sealForBrowserClose("before-orderly-browser-restart");
    await closePersistentContext("G4-orderly-restart-after-clean-stop-and-page-reopen");
    workerLifecycle.confirmBrowserClosed();
    context = await launchPersistentContext(); await armWorkerObserver(); await installRoutes();
    test.page = context.pages().length ? await observePage(context.pages()[0]) : await newPage();
    return { profile: report.environment.persistence.profile.path, origin: server.origin, workerCleanup,
      first: { ...report.environment.persistence.launches[0] }, second: { ...report.environment.persistence.launches[1] },
      mechanism: "Orderly persistent-context close, observed browser disconnect, then same-profile browser launch; no storageState import/export." };
  };
  return test;
}

async function openApp(test) { await test.page.goto(server.origin, { waitUntil: "networkidle" }); await ready(test.page); return test; }
async function enableIsolation(page) {
  if (!await page.evaluate(() => crossOriginIsolated)) {
    await page.getByRole("button", { name: "Workspace & storage", exact: true }).first().click();
    await page.getByRole("button", { name: "Enable x86_64 & reload", exact: true }).click();
    await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Enable, stop & reload", exact: true }).click()]); await ready(page);
  }
  const state = await page.evaluate(() => ({ isolated: crossOriginIsolated, sharedMemory: typeof SharedArrayBuffer !== "undefined", controller: navigator.serviceWorker.controller?.scriptURL }));
  assert.equal(state.isolated, true); assert.equal(state.sharedMemory, true); assert.match(state.controller, /terrarium-isolation\.js$/); return state;
}
async function helperCall(page, functionName, input) {
  return page.evaluate(async ({ functionName, input }) => { const helper = await import("/__browser-fixtures/acceptance/s2-browser-helper.js"); return helper[functionName](input); }, { functionName, input });
}
async function createGuest(page, presetId, name) {
  return page.evaluate(async ({ presetId, name, smallBundle }) => {
    const helper = await import("/__browser-fixtures/acceptance/s2-browser-helper.js");
    const machine = helper.defaultX86MachineConfiguration({ presetId, ...(presetId === "small" ? { runtimeBundleId: smallBundle } : {}) });
    const created = await window.terrarium.cloud.instances.create({ name, imageId: "alpine-x86_64", machine }).wait();
    await window.terrarium.cloud.instances.setNetwork(created.id, "local").wait(); return created;
  }, { presetId, name, smallBundle: expectedBundle.id });
}
async function bootGuest(page, id) {
  const procedure = () => page.evaluate(async id => {
    const vm = window.terrarium.get(id), began = performance.now();
    const timer = setInterval(() => { const state = vm.status(); console.info("S2_BROWSER_PROGRESS " + JSON.stringify({ id, phase: "boot", elapsedMs: Math.round(performance.now() - began), status: state.status, message: state.message, controlReady: state.controlReady })); }, 15_000);
    try { const status = await vm.boot(); return { status, elapsedMs: Math.round(performance.now() - began), jsHeap: performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize, jsHeapSizeLimit: performance.memory.jsHeapSizeLimit } : null }; }
    finally { clearInterval(timer); }
  }, id);
  const observer = pageWorkerObservers.get(page);
  if (!observer) return procedure();
  const { result, cohorts } = await observer.coverDuringStartup(page, "boot:" + id, procedure);
  return { ...result, startupWorkerCohorts: cohorts };
}
async function executeGuestCommand(page, id, script, timeoutMs = 60_000) {
  assert.ok(typeof script === "string" && Buffer.byteLength(script, "utf8") <= 8192, "Acceptance commands must obey the production 8 KiB command budget");
  const readinessStarted = performance.now();
  // The real UI may briefly use the shared control channel for an inspection.
  // Observe its existing single-command contract; never retry an already
  // submitted command or bypass the runner's busy refusal.
  await page.waitForFunction(id => {
    const state = window.terrarium.get(id).status();
    return state.status === "running" && state.commandReady && !state.commandBusy;
  }, id, { timeout: 20_000 });
  const readinessWaitMs = Math.round(performance.now() - readinessStarted);
  const result = await page.evaluate(async ({ id, script, timeoutMs }) => window.terrarium.get(id).exec(script, { timeoutMs }), { id, script, timeoutMs });
  assert.equal(result.status, "exited", JSON.stringify(result)); return { script, readinessWaitMs, ...result };
}
async function command(page, id, script, timeoutMs = 60_000) {
  const result = await executeGuestCommand(page, id, script, timeoutMs);
  assert.equal(result.exitCode, 0, JSON.stringify(result)); return result;
}
async function stopGuest(page, id) {
  await page.evaluate(async id => { await window.terrarium.cloud.instances.stop(id).wait(); }, id);
  await page.waitForFunction(id => window.terrarium.get(id).status().status === "idle", id);
  const workerObserver = pageWorkerObservers.get(page);
  if (!workerObserver) {
    const deadline = Date.now() + 10_000; while (page.workers().length && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 25));
    assert.equal(page.workers().length, 0, "Guest workers must close after successful stop");
    return;
  }
  const deadline = performance.now() + 10_000;
  while (page.workers().length && performance.now() < deadline)
    await new Promise(resolveWait => setTimeout(resolveWait, Math.min(25, Math.max(0, deadline - performance.now()))));
  assert.equal(page.workers().length, 0, "Guest workers must close after successful stop");
  return workerObserver.assertEmpty("clean-stop:" + id, { deadline });
}
async function guestFailure(page, id, observations, error) {
  error.browserEvidence = { ...(error.browserEvidence ?? {}), ...observations, guest: await page.evaluate(id => {
    if (!id) return null; const vm = window.terrarium.get(id);
    return { state: vm.status(), transcripts: [0, 1, 2, 3].map(port => ({ port, tail: vm.readOutput({ port }).slice(-16_384) })) };
  }, id).catch(error => ({ observationError: String(error) })) }; throw error;
}

try {
  server = await serveBuiltApplication(buildRoot, new Map([...assets.values()].map(asset => [asset.fixtureKey, asset])), fixtures);
  if (mode === "persistence") {
    if (process.env.TERRARIUM_BROWSER_SUPERVISOR_SOCKET)
      assert.equal(process.env.TERRARIUM_BROWSER_SUPERVISOR_MAX_LAUNCHES, "2",
        "G4 requires explicit supervisor --browser-max-launches 2 before any guest boot");
    report.environment.persistence = { profile: await reservePersistentProfile(root, process.env.TERRARIUM_S2_PROFILE_DIR),
      launches: [], origin: server.origin, context: "Chromium persistent userDataDir", maximumLaunches: 2,
      limitation: "A same-origin browser-process restart. The profile's backing filesystem is the recorded host environment; OS reboot, power loss, origin eviction and physical-disk persistence are not established." };
    persistentContext = null;
  } else if (mode === "storage") {
    if (process.env.TERRARIUM_BROWSER_SUPERVISOR_SOCKET)
      assert.equal(process.env.TERRARIUM_BROWSER_SUPERVISOR_MAX_LAUNCHES, "1",
        "Positive storage requires exactly one supervised browser launch");
    report.environment.storage = { profile: await reservePersistentProfile(root, process.env.TERRARIUM_S2_PROFILE_DIR),
      launches: [], origin: server.origin, context: "Fresh Chromium persistent userDataDir", maximumLaunches: 1,
      quotaOverride: false, limitation: "One natural-quota filesystem-backed browser context, without restart. Navigator estimates and native quota remain distinct. No physical-disk, host-reboot, power-loss or production-origin durability claim." };
  } else {
    browser = await chromium.launch(browserOptions); report.environment.browser = browser.version();
  }
  await save();

  if (mode === "migrations") await runMigrations({ run, fixtureContext, server, ready, helperCall, createGuest });
  if (mode === "quota") await runQuota({ run, fixtureContext, openApp, server });
  if (mode === "persistence") await runPersistence({ run, fixtureContext, openApp, ready, enableIsolation, createGuest, bootGuest, command, executeGuestCommand, stopGuest, guestFailure, server });
  if (mode === "images" || mode === "ui") await (mode === "images" ? runImages : runUi)({ run, fixtureContext, openApp, server, ready, enableIsolation, helperCall, createGuest, bootGuest, command, stopGuest, guestFailure, imagePath, report, root });

  if (mode === "storage") await run("S2-G2-large-sparse-browser-storage", "Use actual Chromium IndexedDB/Web Locks in a fresh persistent profile at its natural quota for an8GiB logical disk,256MiB nonzero writes,cacheeviction,boundedcopy/rawexport,RO and explicit aborted-transaction failures", async () => {
    const test = await openApp(await fixtureContext());
    const observations = { isolation: null, storage: null, storageContext: report.environment.storage,
      quotaObservations: [], observationErrors: [], browser: test.observations, cleanupErrors: [] };
    let failure = null, cdp = null;
    const observeQuota = async label => {
      const entry = { label, at: new Date().toISOString(), native: null, navigatorStorage: null };
      observations.quotaObservations.push(entry);
      entry.native = await storageBounded(() => cdp.send("Storage.getUsageAndQuota", { origin: server.origin }), "Positive storage native quota query");
      entry.navigatorStorage = await storageBounded(() => test.page.evaluate(async () => ({ origin: location.origin,
        crossOriginIsolated, estimate: await navigator.storage.estimate(), persisted: await navigator.storage.persisted() })), "Positive storage navigator estimate");
      assert.equal(entry.native.overrideActive, false, "The positive storage fixture must use the browser's natural quota");
      assert.ok(Number.isFinite(entry.native.usage) && entry.native.usage >= 0 && Number.isFinite(entry.native.quota) && entry.native.quota >= 0);
      assert.equal(entry.navigatorStorage.origin, server.origin); assert.equal(entry.navigatorStorage.crossOriginIsolated, true);
      assert.ok(Number.isFinite(entry.navigatorStorage.estimate.usage) && entry.navigatorStorage.estimate.usage >= 0);
      assert.ok(Number.isFinite(entry.navigatorStorage.estimate.quota) && entry.navigatorStorage.estimate.quota >= 0);
      assert.equal(typeof entry.navigatorStorage.persisted, "boolean");
      entry.estimateMinusNativeQuota = entry.navigatorStorage.estimate.quota - entry.native.quota;
      // Preserve completed preflight observations in the recorder's stdout even
      // if the long helper is later interrupted before it can return a report.
      console.log("S2_STORAGE_QUOTA_OBSERVATION " + JSON.stringify(entry));
    };
    try {
      observations.isolation = await enableIsolation(test.page);
      cdp = await storageBounded(() => test.context.newCDPSession(test.page), "Positive storage CDP session");
      await observeQuota("before-storage-helper");
      observations.storage = await test.page.evaluate(async () => {
        const { runStorageAcceptance } = await import("/__browser-fixtures/acceptance/s2-browser-helper.js");
        return runStorageAcceptance({ onStep: step => console.info("S2_BROWSER_PROGRESS " + JSON.stringify({ phase: "storage", ...step })) });
      });
      // Retain the complete returned report before assertions. Its failed result
      // includes completed steps, navigator estimates, error and owned cleanup.
      assert.equal(observations.storage.status, "passed", observations.storage.error);
      assert.equal(observations.storage.completionMarker, "TERRARIUM_S2_STORAGE_COMPLETE");
      assert.deepEqual(test.observations.pageErrors, []);
    } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
    finally {
      if (cdp) {
        // The helper has already attempted owned cleanup before returning. This
        // native sample is not its peak usage or the precise failure-time quota.
        try { await observeQuota(observations.storage ? "after-helper-return-and-owned-cleanup" : "after-harness-failure-before-helper-return"); }
        catch (error) { observations.observationErrors.push({ phase: "native-quota-after", error: error.stack ?? String(error) }); failure ??= error instanceof Error ? error : new Error(String(error)); }
        try { await storageBounded(() => cdp.detach(), "Positive storage CDP detach"); }
        catch (error) { observations.cleanupErrors.push({ phase: "CDP-detach", error: error.stack ?? String(error) }); failure ??= error instanceof Error ? error : new Error(String(error)); }
      }
      try { await test.close(); }
      catch (error) {
        observations.cleanupErrors.push({ phase: "storage-context", error: error.stack ?? String(error) });
        // A cleanup-only failure still fails; it must not erase a primary
        // storage failure or its partial returned report.
        failure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    if (failure) {
      failure.browserEvidence = { ...(failure.browserEvidence ?? {}), ...observations }; throw failure;
    }
    return { ...observations.storage, isolation: observations.isolation, storageContext: observations.storageContext,
      quotaObservations: observations.quotaObservations, observationErrors: observations.observationErrors,
      cleanupErrors: observations.cleanupErrors, browser: test.observations };
  });

  if (mode === "presets") for (const presetId of ["small", "worker", "server"]) await run(`S2-G1-${presetId}`, "Boot the actual configured preset; observeCPU/RAM/interrupts,scheduling,packetI/O and pause/resume through the packaged API", async () => {
    const test = await openApp(await fixtureContext()), observations = {}; let id;
    try {
      observations.isolation = await enableIsolation(test.page);
      observations.definition = await createGuest(test.page, presetId, `s2-${presetId}`); id = observations.definition.id;
      observations.boot = await bootGuest(test.page, id); const state = observations.boot.status;
      assert.equal(state.status, "running"); assert.equal(state.commandReady, true);
      assert.deepEqual(state.sessions.map(port => [port.port, port.status]), [[1, "ready"], [2, "ready"], [3, "ready"]]);
      const cpus = presetId === "server" ? 2 : 1, memoryMiB = { small: 512, worker: 1024, server: 2048 }[presetId];
      assert.equal(state.resourceObservation.configuredGuestMemoryMiB, memoryMiB);
      assert.equal(state.resourceObservation.observedWasmMemoryBytes, getQemuBundle(observations.definition.machine.runtimeBundleId).resources.reservedWasmMiB * 1048576);
      observations.hardware = await command(test.page, id, `set -e; uname -a; cat /sys/devices/system/cpu/online; grep '^processor' /proc/cpuinfo; cat /proc/meminfo; test "$(grep -c '^processor' /proc/cpuinfo)" -eq ${cpus}; test "$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)" -ge ${Math.floor(memoryMiB * 1024 * 0.9)}; cat /proc/cmdline; cat /sys/devices/system/clocksource/clocksource0/current_clocksource; cat /proc/interrupts`);
      if (presetId !== "small") { assert.doesNotMatch(observations.hardware.output, /noapic/); assert.match(observations.hardware.output, /IO-APIC/); }
      if (presetId === "server") {
        const probePath = join(root, "build/qemu/fixtures/memory-probe-command-sequence.json");
        observations.probeCommandSequence = await fileIdentity(probePath);
        const sequence = JSON.parse(await readFile(probePath, "utf8"));
        assert.equal(sequence.schema, "terrarium.guest-command-sequence/v1");
        assert.equal(sequence.artifactSha256, "025d6c95b2e2e3f355246258ba09addac784b43546bff31da5a3e0493e13532a");
        assert.ok(Array.isArray(sequence.commands) && sequence.commands.length > 1);
        observations.probeCommands = [];
        for (const script of sequence.commands) observations.probeCommands.push(await command(test.page, id, script));
        observations.pressure = observations.probeCommands.at(-1);
        assert.match(observations.pressure.output, /TERRARIUM_MEMORY_PROBE_OK allocated_bytes=1207959552 verified_pages=294912 page_bytes=4096/);
        const rss = /VmRSS:\s+(\d+)\s+kB/.exec(observations.pressure.output);
        assert.ok(rss && Number(rss[1]) >= 1152 * 1024, "Real guest must retain and verify more than 1 GiB of resident pages");
      } else {
        observations.pressure = await command(test.page, id, "set -e; cat /proc/uptime; cat /proc/stat; dd if=/dev/zero of=/tmp/s2-memory-probe bs=1M count=64; sync; sleep 2; cat /proc/meminfo; cat /proc/uptime; cat /proc/stat; rm /tmp/s2-memory-probe; printf 'S2_MEMORY_PRESSURE_COMPLETE\\n'");
        assert.match(observations.pressure.output, /S2_MEMORY_PRESSURE_COMPLETE/);
      }
      if (presetId === "server") observations.scheduling = await command(test.page, id, "set -e; awk '/^cpu[01] / { print $1, $2 }' /proc/stat > /tmp/s2-cpu-before; sh -c 'i=0; while [ $i -lt 10000 ]; do i=$((i+1)); done; echo TASK_A_COMPLETED' & p0=$!; sh -c 'i=0; while [ $i -lt 10000 ]; do i=$((i+1)); done; echo TASK_B_COMPLETED' & p1=$!; printf 'TASK_PIDS %s %s\\n' $p0 $p1; wait $p0; wait $p1; awk 'NR==FNR { before[$1]=$2; next } /^cpu[01] / { delta=$2-before[$1]; print $1, \"user_jiffies_delta\", delta; if (delta<=0) failed=1; count++ } END { if (count!=2 || failed) exit 1 }' /tmp/s2-cpu-before /proc/stat; cat /proc/interrupts");
      observations.network = await command(test.page, id, "set -e; route -n; _gateway=$(ip route | awk '/^default/ {print $3; exit}'); test -n \"$_gateway\"; ping -c 2 -W 3 \"$_gateway\"; printf 'S2_PACKET_IO_COMPLETE\\n'");
      observations.pause = await test.page.evaluate(async id => { const vm = window.terrarium.get(id); const state = await vm.pause(); let rejection; try { await vm.exec("echo forbidden"); } catch (error) { rejection = error.message; } return { status: state.status, rejectedCommand: rejection }; }, id);
      assert.equal(observations.pause.status, "paused"); assert.ok(observations.pause.rejectedCommand);
      if (presetId === "server") {
        const extra = await createGuest(test.page, "small", "s2-budget-refused");
        // A single QEMU VM owns its parent and nested pthread Workers. Prove
        // admission creates no additional Worker and preserves those exact
        // objects, rather than mistaking one VM for one Playwright Worker.
        const existingWorkers = test.page.workers();
        assert.ok(existingWorkers.length > 0, "The paused server must retain its live Worker objects");
        const createdDuringRefusal = [], recordNewWorker = worker => createdDuringRefusal.push(worker);
        test.page.on("worker", recordNewWorker);
        try {
          observations.admission = await test.page.evaluate(async id => { try { await window.terrarium.get(id).boot(); return { booted: true }; } catch (error) { return { booted: false, error: error.message, state: window.terrarium.get(id).status() }; } }, extra.id);
        } finally { test.page.off("worker", recordNewWorker); }
        const afterRefusalWorkers = test.page.workers();
        const unchangedWorkerObjects = afterRefusalWorkers.length === existingWorkers.length
          && existingWorkers.every(worker => afterRefusalWorkers.includes(worker));
        observations.admission.workerOwnership = { beforeCount: existingWorkers.length, afterCount: afterRefusalWorkers.length,
          beforeUrls: existingWorkers.map(worker => worker.url()), afterUrls: afterRefusalWorkers.map(worker => worker.url()),
          createdDuringRefusal: createdDuringRefusal.length, unchangedWorkerObjects,
          identityCheck: "Strict JavaScript Worker object references; URL lists retain multiplicity but are not used as identities." };
        assert.equal(observations.admission.booted, false); assert.match(observations.admission.error, /resource budget.*full/);
        assert.equal(createdDuringRefusal.length, 0, "A refused additional VM must create no Worker");
        assert.equal(unchangedWorkerObjects, true, "Admission refusal must preserve the exact existing Worker object set");
        await test.page.evaluate(async id => { await window.terrarium.cloud.instances.delete(id).wait(); }, extra.id);
      }
      await test.page.evaluate(async id => window.terrarium.get(id).resume(), id);
      observations.resumed = await command(test.page, id, "set -e; sleep 1; cat /proc/uptime; printf 'S2_RESUME_COMMAND_COMPLETE\\n'");
      if (presetId !== "small") {
        assert.equal(state.capabilities.snapshots, false);
        observations.checkpoint = await checkpointUnavailable(test.page, id, observations.definition.name);
      }
      await stopGuest(test.page, id); observations.stoppedWorkers = test.page.workers().length;
      assert.deepEqual(test.observations.pageErrors, []); return { ...observations, browser: test.observations };
    } catch (error) { return await guestFailure(test.page, id, observations, error); }
    finally { await test.close(); }
  });

  // Each mode is independently bounded and needs its own completion receipt.
  report.status = report.cases.length && report.cases.every(item => item.status === "passed") ? "passed" : "failed";
} catch (error) { report.status = "failed"; report.error = error.stack ?? String(error); console.error(report.error); }
finally {
  clearTimeout(deadline);
  // A teardown failure must fail acceptance, preserve the original outcome,
  // and still attempt every remaining owned cleanup and terminal report.
  for (const [stage, close] of [
    ["storage-context", () => closeStorageContext("harness-finally")],
    ["persistent-context", () => closePersistentContext("harness-finally")],
    ["browser", () => browser?.close()],
    ["server", () => server?.close()],
  ]) {
    try { await close(); }
    catch (error) {
      report.status = "failed";
      (report.cleanupErrors ??= []).push({ stage, error: error.stack ?? String(error) });
      console.error(`S2_BROWSER_CLEANUP_FAILED ${stage}: ${error.stack ?? String(error)}`);
    }
  }
  try {
    const after = hash(JSON.stringify(await tree(buildRoot))); report.buildUnchanged = after === report.build.sha256;
    report.helperUnchanged = (await fileIdentity(helperPath)).sha256 === helper.sha256;
    if (!report.buildUnchanged || !report.helperUnchanged) report.status = "failed";
  } catch (error) {
    report.status = "failed";
    report.finalIdentityError = error.stack ?? String(error);
  }
  report.completedAt = new Date().toISOString(); await save();
}
console.log(`S2_BROWSER_COMPLETION ${JSON.stringify({ status: report.status, mode, cases: report.cases.map(item => ({ id: item.id, status: item.status })), report: reportPath })}`);
process.exitCode = report.status === "passed" ? 0 : 1;
