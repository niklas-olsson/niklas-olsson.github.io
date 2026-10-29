// SPDX-License-Identifier: Apache-2.0

const MAX_MONITOR_BYTES = 65_536;
const MAX_REQUESTS = 32;
const PROMPT = "(qemu) ";
const COMMANDS = Object.freeze({
  stop: "stop", cont: "cont", "query-status": "info status",
  "query-registers": "info registers",
  "query-translation-stats": "info jit",
  "save-checkpoint": "savevm terrarium", "load-checkpoint": "loadvm terrarium",
  "attach-checkpoint": "drive_add 0 if=none,id=checkpoint,file=/checkpoint/state.qcow2,format=qcow2",
  "detach-checkpoint": "drive_del checkpoint",
});

/** Render only the cursor operations emitted by the pinned HMP readline editor. */
function responseLines(text, maxLines = 32, allowHistogram = false) {
  const lines = [];
  let line = [], cursor = 0;
  for (let at = 0; at < text.length; at++) {
    const character = text[at];
    if (character === "\r") { cursor = 0; continue; }
    if (character === "\n") {
      lines.push(line.join("")); line = []; cursor = 0;
      if (lines.length > maxLines) throw new Error("The QEMU monitor returned too many lines.");
      continue;
    }
    if (character === "\x1b") {
      const control = /^\x1b\[(\d*)([CDK])/.exec(text.slice(at));
      if (!control) throw new Error("The QEMU monitor returned an unsupported terminal control.");
      const count = control[1] ? Number(control[1]) : 1;
      if (!Number.isSafeInteger(count) || count > 4096) throw new Error("The QEMU monitor cursor exceeded its limit.");
      if (control[2] === "D") cursor = Math.max(0, cursor - count);
      else if (control[2] === "C") cursor += count;
      else {
        if (control[1] && control[1] !== "0") throw new Error("The QEMU monitor returned an unsupported erase operation.");
        line.length = Math.min(line.length, cursor);
      }
      at += control[0].length - 1;
    } else {
      if ((character < " " || character > "~") && !(allowHistogram && character >= "\u2581" && character <= "\u2588"))
        throw new Error("The QEMU monitor returned invalid text.");
      if (cursor >= 4096) throw new Error("The QEMU monitor line exceeded its limit.");
      while (line.length < cursor) line.push(" ");
      line[cursor++] = character;
    }
    if (cursor > 4096) throw new Error("The QEMU monitor cursor exceeded its limit.");
  }
  if (line.length) lines.push(line.join(""));
  return lines;
}

/** Fixed QEMU 8.2 info-jit format. These are linear-memory buffer counters, not RSS. */
export function parseQemuTranslationStats(text) {
  const invalid = () => { throw new Error("QEMU did not return exact translation-buffer statistics."); };
  if (typeof text !== "string" || text.length > MAX_MONITOR_BYTES || new TextEncoder().encode(text).length > MAX_MONITOR_BYTES
    || /[^\n\x20-\x7e\u2581-\u2588]/.test(text)) invalid();
  const lines = text.split("\n");
  if (lines.length > 32 || lines.some(line => line.length > 4096)) invalid();
  let at = 0;
  const match = (pattern) => { const found = pattern.exec(lines[at++] ?? ""); if (!found) invalid(); return found; };
  const exact = (line) => { if (lines[at++] !== line) invalid(); };
  const uint32 = (value) => {
    if (!/^(?:0|[1-9][0-9]{0,9})$/.test(value)) invalid();
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number > 0xffff_ffff) invalid();
    return number;
  };
  exact("Accelerator settings:");
  match(/^one-insn-per-tb: (?:on|off)$/);
  exact(""); exact("Translation buffer state:");
  const code = match(/^gen code size +(\d+)\/(\d+)$/);
  const generatedCodeUsedBytes = uint32(code[1]), generatedCodeCapacityBytes = uint32(code[2]);
  if (!generatedCodeCapacityBytes || generatedCodeUsedBytes > generatedCodeCapacityBytes) invalid();
  const translationBlockCount = uint32(match(/^TB count +(\d+)$/)[1]);
  match(/^TB avg target size +\d+ max=\d+ bytes$/);
  match(/^TB avg host size +\d+ bytes \(expansion ratio: \d+\.\d+\)$/);
  match(/^cross page TB count +\d+ \(\d+%\)$/);
  match(/^direct jump count +\d+ \(\d+%\) \(2 jumps=\d+ \d+%\)$/);
  if (lines[at]?.startsWith("TB hash buckets")) {
    match(/^TB hash buckets +\d+\/\d+ \(\d+\.\d+% head buckets used\)$/);
    // QEMU's qdist_pr emits only these block glyphs, on these two histogram
    // lines. They are retained as bounded evidence, never interpreted as metrics.
    match(/^TB hash occupancy +\d+\.\d+% avg chain occ\. Histogram: [\x20-\x7e\u2581-\u2588]{1,512}$/);
    match(/^TB hash avg chain +\d+\.\d+ buckets\. Histogram: [\x20-\x7e\u2581-\u2588]{1,512}$/);
  }
  exact(""); exact("Statistics:");
  const translationBlockFlushCount = uint32(match(/^TB flush count +(\d+)$/)[1]);
  const translationBlockInvalidateCount = uint32(match(/^TB invalidate count +(\d+)$/)[1]);
  uint32(match(/^TLB full flushes +(\d+)$/)[1]);
  uint32(match(/^TLB partial flushes +(\d+)$/)[1]);
  uint32(match(/^TLB elided flushes +(\d+)$/)[1]);
  exact("[TCG profiler not compiled]");
  if (at !== lines.length) invalid();
  return Object.freeze({ generatedCodeUsedBytes, generatedCodeCapacityBytes, translationBlockCount,
    translationBlockFlushCount, translationBlockInvalidateCount });
}

/**
 * A private HMP character pipe. HMP stays on QEMU's main loop; this pinned Wasm
 * build stalls with QMP's additional monitor I/O thread. Guest serial data never
 * enters this parser. Only fixed host commands are accepted, one at a time.
 */
export function createPipeMonitor({ onError, readyTimeoutMs = 15_000, commandTimeoutMs = 10_000 }) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let installed = false, closed = false, ready = false;
  let input = new Uint8Array(), output = "";
  let active = null, readyTimer = null;
  const queued = [];

  const finish = (reason, report) => {
    if (closed) return;
    closed = true; ready = false; input = new Uint8Array(); output = "";
    const error = reason instanceof Error ? reason : new Error(String(reason));
    if (readyTimer !== null) clearTimeout(readyTimer);
    readyTimer = null;
    if (active) { clearTimeout(active.timer); active.reject(error); active = null; }
    for (const request of queued.splice(0)) request.reject(error);
    if (report) onError(error);
  };

  const pump = () => {
    if (closed || !ready || active || !queued.length) return;
    const request = queued.shift();
    active = request;
    request.timer = setTimeout(() => finish(new Error(`QEMU did not acknowledge ${request.command}. The monitor was closed.`), true),
      request.command.endsWith("-checkpoint") ? Math.max(commandTimeoutMs, 120_000) : commandTimeoutMs);
    input = encoder.encode(request.wire + "\n");
  };

  const consume = (bytes) => {
    if (closed) return;
    if (bytes.length > MAX_MONITOR_BYTES) throw new Error("QEMU monitor output exceeded its limit.");
    if (ready && !active && bytes.length) throw new Error("QEMU sent unsolicited monitor output.");
    // Browser TextDecoder rejects a SharedArrayBuffer view. The monitor limit
    // above bounds this ordinary-buffer copy before interpreting any text.
    output += decoder.decode(new Uint8Array(bytes), { stream: true });
    if (encoder.encode(output).length > MAX_MONITOR_BYTES) throw new Error("QEMU monitor output exceeded its limit.");
    const prompt = output.indexOf(PROMPT);
    if (prompt === -1) return;
    if (prompt + PROMPT.length !== output.length) throw new Error("QEMU sent an unexpected monitor prompt boundary.");
    const lines = responseLines(output.slice(0, prompt), active?.command === "query-registers" ? 128 : 32,
      active?.command === "query-translation-stats");
    if (!ready) {
      if (lines.length !== 1 || lines[0] !== "QEMU 8.2.0 monitor - type 'help' for more information")
        throw new Error("QEMU did not provide the expected private monitor greeting.");
      ready = true; output = "";
      if (readyTimer !== null) clearTimeout(readyTimer);
      readyTimer = null;
      queueMicrotask(pump);
      return;
    }
    if (!active || input.length || lines[0] !== active.wire)
      throw new Error("QEMU returned an unmatched monitor response.");
    let result = {};
    if (active.command === "query-status") {
      if (lines.length !== 2 || !/^VM status: (running|paused(?: \((?:prelaunch|restore-vm)\))?)$/.test(lines[1]))
        throw new Error("QEMU did not return one exact VM status line.");
      const status = lines[1].startsWith("VM status: running") ? "running" : "paused";
      result = { status, running: status === "running" };
    } else if (active.command === "attach-checkpoint") {
      if (lines.length !== 2 || lines[1] !== "OK") throw new Error("QEMU did not attach its private checkpoint device.");
    } else if (active.command === "query-translation-stats") {
      const monitorText = lines.slice(1).join("\n");
      result = { translationStats: parseQemuTranslationStats(monitorText), monitorText };
    } else if (active.command === "query-registers") {
      const registers = lines.slice(1).join("\n");
      if (!/\bRAX=[0-9a-fA-F]{16}\b/.test(registers) || !/\bRIP=[0-9a-fA-F]{16}\b/.test(registers)
        || !/\bCR0=[0-9a-fA-F]{8,16}\b/.test(registers) || /\b(?:Error|error|failed|unknown)\b/.test(registers))
        throw new Error("QEMU did not return the expected x86_64 register observation.");
      result = { registers };
    } else if (lines.length !== 1) {
      throw new Error("QEMU rejected the monitor command: " + lines.slice(1).join(" ").slice(0, 512));
    }
    const current = active;
    active = null; output = ""; clearTimeout(current.timer);
    current.resolve(result);
    queueMicrotask(pump);
  };

  return {
    install(FS) {
      if (closed || installed) throw new Error("The QEMU monitor device cannot be installed again.");
      installed = true;
      const device = FS.makedev(81, 0);
      FS.registerDevice(device, {
        open(stream) { stream.seekable = false; },
        close() {},
        read(_stream, buffer, offset, length) {
          if (!length || closed) return 0;
          if (!input.length) throw new FS.ErrnoError(6);
          const count = Math.min(length, input.length);
          buffer.set(input.subarray(0, count), offset); input = input.slice(count); return count;
        },
        write(_stream, buffer, offset, length) {
          if (closed) throw new FS.ErrnoError(29);
          try { consume(buffer.subarray(offset, offset + length)); }
          catch (error) { finish(error, true); throw new FS.ErrnoError(29); }
          return length;
        },
        // QEMU opens separate .in/.out nodes O_RDWR. Its poll implementation
        // masks this readiness against each descriptor's requested events.
        poll() { return closed ? 16 : (input.length ? 1 : 0) | 4; },
        llseek() { throw new FS.ErrnoError(70); },
      });
      FS.mkdirTree("/control");
      FS.mkdev("/control/qmp.in", 0o600, device);
      FS.mkdev("/control/qmp.out", 0o600, device);
    },
    execute(command, args) {
      if (!Object.hasOwn(COMMANDS, command) || args !== undefined)
        return Promise.reject(new Error("Unsupported QEMU control command."));
      if (closed) return Promise.reject(new Error("The QEMU monitor is closed."));
      if (queued.length + (active ? 1 : 0) >= MAX_REQUESTS)
        return Promise.reject(new Error("The QEMU monitor request queue is full."));
      const result = new Promise((resolve, reject) => queued.push({ command, wire: COMMANDS[command], resolve, reject, timer: null }));
      if (!ready && readyTimer === null)
        readyTimer = setTimeout(() => finish(new Error("The QEMU monitor did not become ready. The monitor was closed."), true), readyTimeoutMs);
      pump();
      return result;
    },
    close() { finish(new Error("The QEMU monitor is closed."), false); },
  };
}
