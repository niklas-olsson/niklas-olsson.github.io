// SPDX-License-Identifier: Apache-2.0
// Intrusive, Node-only diagnosis. This does not qualify a guest or a checkpoint.
import { createHash } from "node:crypto";
import { Session, url as inspectorUrl } from "node:inspector";

const LIMITS = Object.freeze({
  discoveredWorkers: 64, recentScriptsPerWorker: 16_384, priorityScriptsPerWorker: 64,
  retainedScriptsTotal: 65_536, scriptsPerWorker: 32, commands: 256,
  rawMessageCharacters: 48 * 1024 * 1024, wasmBytesPerScript: 32 * 1024 * 1024,
  wasmBytesTotal: 64 * 1024 * 1024, errors: 32,
});
const text = (value, limit = 512) => typeof value === "string" ? value.slice(0, limit) : null;
const errorRecord = error => ({ name: text(error?.name) ?? "Error", message: text(error?.message ?? String(error), 1024), code: error?.code ?? null });
const location = value => value && typeof value.scriptId === "string" ? {
  scriptId: text(value.scriptId, 128), lineNumber: Number.isInteger(value.lineNumber) ? value.lineNumber : null,
  columnNumber: Number.isInteger(value.columnNumber) ? value.columnNumber : null,
} : null;
const timeoutError = label => Object.assign(new Error(`${label} exceeded its diagnostic deadline.`), { code: "diagnostic_timeout" });

function options(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Stack capture options must be a plain record.");
  const result = { timeoutMs: 8000, maxWorkers: 8, maxFrames: 24, allowedWorkerIds: null };
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !Object.hasOwn(result, key)) throw new Error("Unsupported stack capture option.");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!("value" in descriptor)) throw new Error("Stack capture options cannot use accessors.");
    result[key] = descriptor.value;
  }
  for (const [key, minimum, maximum] of [["timeoutMs", 500, 30_000], ["maxWorkers", 1, 8], ["maxFrames", 1, 64]])
    if (!Number.isSafeInteger(result[key]) || result[key] < minimum || result[key] > maximum)
      throw new Error(`${key} must be an integer between ${minimum} and ${maximum}.`);
  if (result.allowedWorkerIds !== null && result.allowedWorkerIds !== undefined) {
    if (!Array.isArray(result.allowedWorkerIds) || result.allowedWorkerIds.length > LIMITS.discoveredWorkers)
      throw new Error("allowedWorkerIds must be an array of at most 64 exact inspector worker IDs.");
    result.allowedWorkerIds = [...new Set(result.allowedWorkerIds.map(id => {
      if (Number.isSafeInteger(id) && id > 0) return String(id);
      if (typeof id === "string" && id.length > 0 && id.length <= 128) return id;
      throw new Error("Each allowedWorkerId must be an exact nonempty string or positive integer.");
    }))];
  } else result.allowedWorkerIds = null;
  return result;
}

/** Attach only when called. Never opens an inspector listener or evaluates code. */
export async function captureNodeWorkerStacks(value = {}) {
  const config = options(value), began = performance.now(), hardDeadline = began + config.timeoutMs;
  const reserve = Math.min(1500, Math.max(200, Math.floor(config.timeoutMs / 4)));
  const captureDeadline = hardDeadline - reserve;
  const session = new Session(), children = new Map(), pending = new Map(), timers = new Set();
  let connected = false, sequence = 0, retainedScripts = 0, bytecodeBytes = 0, phase = "discovery";
  const report = {
    schema: "terrarium.node-worker-stacks/v1", intrusive: true, acceptanceGatePass: false,
    startedAt: new Date().toISOString(), endedAt: null, durationMs: null,
    process: { pid: process.pid, node: process.version, v8: process.versions.v8, platform: process.platform, architecture: process.arch },
    limits: { ...config, ...LIMITS, captureBudgetMs: captureDeadline - began, cleanupReserveMs: reserve },
    inspector: { transport: "internal Node Session/NodeWorker", opensNetworkListener: false,
      networkListenerPresentBefore: !!inspectorUrl(), networkListenerPresentAfter: null },
    discoveredWorkers: [], omittedWorkers: 0, workers: [], errors: [], commands: [], omittedCommands: 0,
    observations: { scriptParsedEvents: 0, omittedScriptMetadata: 0, oversizedMessages: 0, ignoredMessages: 0, bytecodeBytesHashed: 0 },
    cleanup: { domainDisableAttempted: false, domainDisabled: false, disconnected: false, pendingCommandsCancelled: 0, timersRemaining: null },
    completed: false, deadlineExceeded: false, budgetOverrunMs: 0,
    limitations: [
      "Debugger pauses and resumes alter scheduling. This is neither an unchanged-condition acceptance pass nor a coherent checkpoint.",
      "Worker and session IDs come from Node's inspector, not worker_threads.threadId. Native C roles cannot be inferred from worker titles alone.",
      "Completed describes selected stack captures and cleanup. Discovered but untargeted workers and unavailable module hashes remain explicit limitations.",
      "A numeric Wasm function index belongs only to its identified script/module; dynamic TCG modules have separate identities.",
      "Idle or blocked workers may not acknowledge pause promptly. A missing capture is reported, not treated as guest progress.",
      "Only bounded frame locations and script metadata are retained. No locals, heap, guest commands, evaluation or full bytecode are returned.",
      "Inspector callbacks can execute synchronously and delay JavaScript timers; any observed overall budget overrun is reported explicitly.",
    ],
  };
  const elapsed = () => Math.round(performance.now() - began);
  const addError = (list, error, stage) => { if (list.length < LIMITS.errors) list.push({ stage, ...errorRecord(error), elapsedMs: elapsed() }); };
  const timer = (fn, delay) => { const id = setTimeout(() => { timers.delete(id); fn(); }, delay); timers.add(id); return id; };
  const clear = id => { if (id !== null) { clearTimeout(id); timers.delete(id); } };

  function commandRecord(method, child, id) {
    const record = { method, sessionId: child?.sessionId ?? null, workerId: child?.workerId ?? null, id, startedMs: elapsed(), endedMs: null, status: "pending" };
    if (report.commands.length < LIMITS.commands) report.commands.push(record); else report.omittedCommands++;
    return record;
  }
  function rootCommand(method, params, deadline, mustSend = false) {
    const record = commandRecord(method, null, null);
    return new Promise((resolve, reject) => {
      let settled = false, handle = null;
      const done = (error, result) => {
        if (settled) return; settled = true; clear(handle);
        record.endedMs = elapsed(); record.status = error ? "error" : "acknowledged";
        if (error) reject(error); else resolve(result);
      };
      const remaining = deadline - performance.now();
      if (remaining <= 0 && !mustSend) { done(timeoutError(method)); return; }
      handle = timer(() => done(timeoutError(method)), Math.max(0, remaining));
      try { session.post(method, params, done); } catch (error) { done(error); }
    });
  }
  function childCommand(child, method, params, deadline, mustSend = false) {
    const id = ++sequence, key = `${child.sessionId}:${id}`, record = commandRecord(method, child, id);
    return new Promise((resolve, reject) => {
      let handle = null;
      const done = (error, result) => {
        if (!pending.has(key)) return;
        pending.delete(key); clear(handle); record.endedMs = elapsed(); record.status = error ? "error" : "acknowledged";
        if (error) reject(error); else resolve(result);
      };
      pending.set(key, { done, child });
      const remaining = deadline - performance.now();
      if (remaining <= 0 && !mustSend) { done(timeoutError(method)); return; }
      handle = timer(() => done(timeoutError(method)), Math.max(0, remaining));
      rootCommand("NodeWorker.sendMessageToWorker", { sessionId: child.sessionId, message: JSON.stringify({ id, method, params }) }, deadline, mustSend)
        .catch(error => done(error));
    });
  }
  function rememberScript(child, value) {
    report.observations.scriptParsedEvents++;
    if (typeof value.scriptId !== "string" || value.scriptId.length > 128) return;
    const metadata = { scriptId: value.scriptId, url: text(value.url, 1024), inspectorHash: text(value.hash, 128),
      scriptLanguage: text(value.scriptLanguage, 32), reportedLength: Number.isSafeInteger(value.length) ? value.length : null,
      startLine: value.startLine ?? null, startColumn: value.startColumn ?? null, endLine: value.endLine ?? null,
      endColumn: value.endColumn ?? null, codeOffset: value.codeOffset ?? null, buildId: text(value.buildId, 128) };
    const priority = metadata.scriptLanguage === "WebAssembly" && metadata.reportedLength >= 1024 * 1024;
    const map = priority ? child.priority : child.scripts;
    if (map.has(value.scriptId)) { map.set(value.scriptId, metadata); return; }
    const limit = priority ? LIMITS.priorityScriptsPerWorker : LIMITS.recentScriptsPerWorker;
    if (map.size >= limit) { map.delete(map.keys().next().value); retainedScripts--; report.observations.omittedScriptMetadata++; }
    if (retainedScripts >= LIMITS.retainedScriptsTotal) {
      const eviction = priority ? [...children.values()].find(value => value.scripts.size) : null;
      if (!eviction) { report.observations.omittedScriptMetadata++; return; }
      eviction.scripts.delete(eviction.scripts.keys().next().value); retainedScripts--; report.observations.omittedScriptMetadata++;
    }
    map.set(value.scriptId, metadata); retainedScripts++;
  }
  function attached({ params }) {
    if (!params || typeof params.sessionId !== "string" || children.has(params.sessionId)) return;
    if (children.size >= LIMITS.discoveredWorkers) { report.omittedWorkers++; return; }
    const info = params.workerInfo ?? {};
    const child = { sessionId: text(params.sessionId, 128), workerId: text(info.workerId, 128), title: text(info.title, 512),
      url: text(info.url, 1024), type: text(info.type, 64), waitingForDebugger: params.waitingForDebugger === true,
      attachedMs: elapsed(), selected: false, lateAttachment: phase !== "discovery", detached: false,
      scripts: new Map(), priority: new Map(), paused: null, pausedWait: null, result: null };
    children.set(child.sessionId, child);
  }
  function detached({ params }) {
    const child = children.get(params?.sessionId); if (!child) return;
    child.detached = true;
    const error = new Error("Inspector worker detached before the diagnostic operation completed.");
    for (const entry of [...pending.values()]) if (entry.child === child) entry.done(error);
    child.pausedWait?.reject(error);
  }
  function received({ params }) {
    const child = children.get(params?.sessionId); if (!child || typeof params?.message !== "string") return;
    if (params.message.length > LIMITS.rawMessageCharacters) {
      report.observations.oversizedMessages++;
      for (const entry of [...pending.values()]) if (entry.child === child) entry.done(new Error("Inspector response exceeded the bounded raw-message limit."));
      return;
    }
    let message;
    try { message = JSON.parse(params.message); } catch { report.observations.ignoredMessages++; return; }
    if (Number.isSafeInteger(message.id)) {
      const entry = pending.get(`${child.sessionId}:${message.id}`);
      if (entry) entry.done(message.error ? Object.assign(new Error(text(message.error.message, 1024) ?? "Inspector command failed."), { code: message.error.code }) : null, message.result);
      else report.observations.ignoredMessages++;
      return;
    }
    if (message.method === "Debugger.scriptParsed") { rememberScript(child, message.params ?? {}); return; }
    if (message.method === "Debugger.paused") {
      const data = message.params ?? {}, frames = Array.isArray(data.callFrames) ? data.callFrames : [];
      child.paused = { observedMs: elapsed(), reason: text(data.reason, 128), totalFrames: frames.length,
        frames: frames.slice(0, config.maxFrames).map(frame => ({ functionName: text(frame.functionName, 512),
          url: text(frame.url, 1024), location: location(frame.location), functionLocation: location(frame.functionLocation) })) };
      child.pausedWait?.resolve(child.paused);
    }
  }
  async function pauseWorker(child) {
    const result = child.result = { workerId: child.workerId, sessionId: child.sessionId, title: child.title, url: child.url,
      status: "pending", pauseRequestedMs: null, pauseAcknowledgedMs: null, pause: null, scripts: [], errors: [],
      cleanup: { resumeAttempted: false, resumeAcknowledged: false, debuggerDisableAttempted: false, debuggerDisabled: false } };
    report.workers.push(result);
    const deadline = Math.min(captureDeadline, performance.now() + Math.min(2000, config.timeoutMs / 2));
    try {
      await childCommand(child, "Debugger.enable", {}, deadline);
      result.pauseRequestedMs = elapsed();
      let handle = null;
      const pause = new Promise((resolve, reject) => {
        child.pausedWait = { resolve: data => { clear(handle); resolve(data); }, reject: error => { clear(handle); reject(error); } };
        handle = timer(() => reject(timeoutError("Debugger.paused notification")), Math.max(0, deadline - performance.now()));
      });
      // Install the notification wait before issuing pause; either can arrive first.
      const [, observed] = await Promise.all([
        childCommand(child, "Debugger.pause", {}, deadline).then(() => { result.pauseAcknowledgedMs = elapsed(); }), pause,
      ]);
      result.pause = observed; result.status = "captured";
    } catch (error) {
      result.status = error?.code === "diagnostic_timeout" ? "timed_out" : "unavailable";
      // A notification can precede an acknowledgement that later times out.
      if (child.paused) result.pause = child.paused;
      addError(result.errors, error, "capture");
    } finally { child.pausedWait = null; }
  }
  async function identifyScript(child, scriptId) {
    const metadata = child.priority.get(scriptId) ?? child.scripts.get(scriptId) ?? { scriptId, metadataUnavailable: true };
    const frameUrl = child.result.pause?.frames.find(frame => frame.location?.scriptId === scriptId)?.url;
    const wasm = metadata.scriptLanguage === "WebAssembly" || metadata.url?.startsWith("wasm:") || frameUrl?.startsWith("wasm:");
    const record = { ...metadata, bytecode: { status: wasm || metadata.metadataUnavailable ? "pending" : "not-wasm" } };
    if (!wasm && !metadata.metadataUnavailable) return record;
    if (metadata.reportedLength > LIMITS.wasmBytesPerScript || bytecodeBytes + Math.max(0, metadata.reportedLength ?? 0) > LIMITS.wasmBytesTotal) {
      record.bytecode = { status: "omitted-budget" }; return record;
    }
    try {
      let method = "Debugger.getScriptSource";
      let source = await childCommand(child, method, { scriptId }, captureDeadline);
      if (typeof source?.bytecode !== "string") {
        if (!wasm) { record.bytecode = { status: "not-returned", method }; return record; }
        method = "Debugger.getWasmBytecode";
        source = await childCommand(child, method, { scriptId }, captureDeadline);
      }
      const encoded = source?.bytecode;
      if (typeof encoded !== "string") throw new Error("Inspector did not return Wasm bytecode.");
      const estimate = Math.floor(encoded.length / 4) * 3;
      if (estimate > LIMITS.wasmBytesPerScript + 2 || bytecodeBytes + estimate > LIMITS.wasmBytesTotal + 2)
        throw new Error("Inspector bytecode exceeded the bounded hashing budget.");
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length > LIMITS.wasmBytesPerScript || bytecodeBytes + bytes.length > LIMITS.wasmBytesTotal)
        throw new Error("Inspector bytecode exceeded the bounded hashing budget.");
      bytecodeBytes += bytes.length;
      record.bytecode = { status: "hashed", method, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    } catch (error) { record.bytecode = { status: "unavailable", error: errorRecord(error) }; }
    return record;
  }

  session.on("NodeWorker.attachedToWorker", attached);
  session.on("NodeWorker.detachedFromWorker", detached);
  session.on("NodeWorker.receivedMessageFromWorker", received);
  try {
    session.connect(); connected = true;
    await rootCommand("NodeWorker.enable", { waitForDebuggerOnStart: false }, captureDeadline);
    // Let already-existing nested-worker attachments drain; no worker is created here.
    await new Promise(resolve => timer(resolve, Math.max(0, Math.min(50, captureDeadline - performance.now()))));
    phase = "capture";
    const allowed = config.allowedWorkerIds === null ? null : new Set(config.allowedWorkerIds);
    const targets = [...children.values()].filter(child => !allowed || allowed.has(child.workerId)).slice(0, config.maxWorkers);
    for (const child of targets) child.selected = true;
    await Promise.all(targets.map(pauseWorker));
    // Hash sequentially to bound peak bytecode memory; response data is discarded.
    for (const child of targets) {
      const ids = [...new Set((child.result.pause?.frames ?? []).map(frame => frame.location?.scriptId).filter(Boolean))];
      for (const scriptId of ids.slice(0, LIMITS.scriptsPerWorker)) child.result.scripts.push(await identifyScript(child, scriptId));
    }
    report.completed = targets.length > 0 && targets.every(child => child.result.status === "captured")
      && (!allowed || [...allowed].every(id => targets.some(child => child.workerId === id)));
  } catch (error) { addError(report.errors, error, "inspector"); }
  finally {
    phase = "cleanup";
    const targets = [...children.values()].filter(child => child.selected);
    // Resume even after a missing pause acknowledgement/notification; disabling
    // the debugger also cancels any latent pause request before disconnecting.
    await Promise.all(targets.map(async child => {
      const cleanup = child.result.cleanup; cleanup.resumeAttempted = true;
      try { await childCommand(child, "Debugger.resume", {}, hardDeadline - 200, true); cleanup.resumeAcknowledged = true; }
      catch (error) { addError(child.result.errors, error, "resume"); }
      cleanup.debuggerDisableAttempted = true;
      try { await childCommand(child, "Debugger.disable", {}, hardDeadline - 75, true); cleanup.debuggerDisabled = true; }
      catch (error) { addError(child.result.errors, error, "debugger-disable"); }
    }));
    if (connected) {
      report.cleanup.domainDisableAttempted = true;
      try { await rootCommand("NodeWorker.disable", {}, hardDeadline, true); report.cleanup.domainDisabled = true; }
      catch (error) { addError(report.errors, error, "domain-disable"); }
      try { session.disconnect(); report.cleanup.disconnected = true; }
      catch (error) { addError(report.errors, error, "disconnect"); }
    }
    for (const entry of [...pending.values()]) { report.cleanup.pendingCommandsCancelled++; entry.done(new Error("Stack capture disconnected.")); }
    for (const handle of [...timers]) clear(handle);
    session.removeAllListeners();
    for (const child of targets) child.result.pause ??= child.paused;
    report.discoveredWorkers = [...children.values()].map(({ workerId, sessionId, title, url, type, waitingForDebugger, attachedMs, selected, lateAttachment, detached }) =>
      ({ workerId, sessionId, title, url, type, waitingForDebugger, attachedMs, selected, lateAttachment, detached }));
    report.observations.bytecodeBytesHashed = bytecodeBytes;
    report.cleanup.timersRemaining = timers.size;
    report.inspector.networkListenerPresentAfter = !!inspectorUrl();
    report.endedAt = new Date().toISOString(); report.durationMs = elapsed();
    report.budgetOverrunMs = Math.max(0, Math.round(performance.now() - hardDeadline));
    report.deadlineExceeded = report.budgetOverrunMs > 0;
    report.completed &&= !report.deadlineExceeded && report.cleanup.domainDisabled && report.cleanup.disconnected
      && targets.every(child => child.result.cleanup.resumeAcknowledged && child.result.cleanup.debuggerDisabled);
  }
  return report;
}
