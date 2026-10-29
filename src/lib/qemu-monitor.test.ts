// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPipeMonitor, parseQemuTranslationStats, type MonitorDeviceOperations } from "../../public/runtime/qemu/monitor.js";
import { QEMU_JIT_FIXTURE_TEXT, QEMU_JIT_FIXTURE_STATS } from "./fixtures/qemu-jit.ts";

const tick = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));
const encoder = new TextEncoder();
const greeting = "QEMU 8.2.0 monitor - type 'help' for more information\r\n(qemu) ";
class ErrnoError extends Error {
  readonly errno: number;
  constructor(errno: number) { super(`errno ${errno}`); this.errno = errno; }
}

// Actual QEMU 8.2 readline echoes redraw every growing command prefix.
function echo(command: string): string {
  return [...command].map((_character, index) => "\x1b[D".repeat(index) + command.slice(0, index + 1) + "\x1b[K").join("") + "\r\n";
}
const reply = (command: string, text = ""): string => echo(command) + text + "(qemu) ";

function harness(timeouts: { readyTimeoutMs?: number; commandTimeoutMs?: number } = {}) {
  let operations!: MonitorDeviceOperations;
  const paths: [string, number, number][] = [];
  const errors: Error[] = [];
  const monitor = createPipeMonitor({ onError: (error) => errors.push(error), ...timeouts });
  const FS = {
    ErrnoError,
    makedev: (major: number, minor: number) => major * 256 + minor,
    registerDevice: (_device: number, value: MonitorDeviceOperations) => { operations = value; },
    mkdirTree: (path: string) => { assert.equal(path, "/control"); },
    mkdev: (path: string, mode: number, device: number) => { paths.push([path, mode, device]); },
  };
  monitor.install(FS);
  const writeBytes = (bytes: Uint8Array) => {
    const padded = new Uint8Array(bytes.length + 4); padded.set(bytes, 2);
    return operations.write({}, padded, 2, bytes.length);
  };
  const write = (text: string) => writeBytes(encoder.encode(text));
  const read = (): string => {
    const chunks: Uint8Array[] = [];
    while (true) {
      const buffer = new Uint8Array(9);
      try {
        const length = operations.read({}, buffer, 2, 5);
        if (!length) break;
        chunks.push(buffer.slice(2, 2 + length));
      } catch (error) { if (error instanceof ErrnoError && error.errno === 6) break; throw error; }
    }
    return chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");
  };
  return { monitor, operations, FS, paths, errors, write, writeBytes, read, ready: () => write(greeting) };
}

test("private HMP pipe negotiates the complete greeting and accepts split readline echo and prompt", async () => {
  const h = harness();
  assert.deepEqual(h.paths, [["/control/qmp.in", 0o600, 81 * 256], ["/control/qmp.out", 0o600, 81 * 256]]);
  const stream: { seekable?: boolean } = {}; h.operations.open(stream); assert.equal(stream.seekable, false);
  assert.equal(h.operations.read({}, new Uint8Array(), 0, 0), 0);
  assert.throws(() => h.operations.llseek(), (error: unknown) => error instanceof ErrnoError && error.errno === 70);
  let settled = false;
  const stop = h.monitor.execute("stop").then((result) => { settled = true; return result; });
  for (const byte of encoder.encode(greeting.slice(0, -1))) h.writeBytes(new Uint8Array([byte]));
  await tick(); assert.equal(h.read(), "");
  h.write(" "); await tick(); assert.equal(h.read(), "stop\n");
  const response = reply("stop");
  assert.equal(echo("stop"), "s\x1b[K\x1b[Dst\x1b[K\x1b[D\x1b[Dsto\x1b[K\x1b[D\x1b[D\x1b[Dstop\x1b[K\r\n");
  for (const byte of encoder.encode(response.slice(0, -1))) h.writeBytes(new Uint8Array([byte]));
  await tick(); assert.equal(settled, false, "a partial prompt is not an acknowledgment");
  h.write(" "); assert.deepEqual(await stop, {});
  assert.equal(h.errors.length, 0); h.monitor.close();
});

test("fixed commands are serialized and status requires the actual paused or running response", async () => {
  const h = harness(); h.ready();
  const stop = h.monitor.execute("stop");
  const status = h.monitor.execute("query-status");
  const cont = h.monitor.execute("cont");
  assert.equal(h.read(), "stop\n"); assert.equal(h.read(), "");
  h.write(reply("stop")); await stop; await tick();
  assert.equal(h.read(), "info status\n");
  h.write(reply("info status", "VM status: paused\r\n"));
  assert.deepEqual(await status, { status: "paused", running: false }); await tick();
  assert.equal(h.read(), "cont\n"); h.write(reply("cont")); await cont;
  const resumed = h.monitor.execute("query-status"); assert.equal(h.read(), "info status\n");
  h.write(reply("info status", "VM status: running\r\n"));
  assert.deepEqual(await resumed, { status: "running", running: true });
  h.monitor.close();
});

test("arbitrary commands and arguments cannot reach the private monitor", async () => {
  const h = harness(); h.ready();
  for (const command of ["quit", "system_reset", "query-version", "human-monitor-command", "stop\ncont", "toString"])
    await assert.rejects(h.monitor.execute(command), /Unsupported/);
  await assert.rejects(h.monitor.execute("stop", { arbitrary: true }), /Unsupported/);
  assert.equal(h.read(), ""); assert.equal(h.errors.length, 0); h.monitor.close();
});

test("checkpoint controls are fixed and paused register observations require real x86_64 fields", async () => {
  const h = harness(); h.ready();
  for (const [command, wire] of [["save-checkpoint", "savevm terrarium"], ["load-checkpoint", "loadvm terrarium"]]) {
    const pending = h.monitor.execute(command); assert.equal(h.read(), wire + "\n"); h.write(reply(wire)); assert.deepEqual(await pending, {});
  }
  const attached = h.monitor.execute("attach-checkpoint");
  const attachWire = "drive_add 0 if=none,id=checkpoint,file=/checkpoint/state.qcow2,format=qcow2";
  assert.equal(h.read(), attachWire + "\n"); h.write(reply(attachWire, "OK\r\n")); assert.deepEqual(await attached, {});
  const detached = h.monitor.execute("detach-checkpoint");
  assert.equal(h.read(), "drive_del checkpoint\n"); h.write(reply("drive_del checkpoint")); assert.deepEqual(await detached, {});
  for (const reason of ["prelaunch", "restore-vm"]) {
    const pending = h.monitor.execute("query-status"); assert.equal(h.read(), "info status\n");
    h.write(reply("info status", `VM status: paused (${reason})\r\n`));
    assert.deepEqual(await pending, { status: "paused", running: false });
  }
  const pending = h.monitor.execute("query-registers"); assert.equal(h.read(), "info registers\n");
  const registers = "CPU#0\r\nRAX=0000000000000000 RIP=ffffffff81000000\r\nCR0=80050033\r\n";
  h.write(reply("info registers", registers));
  assert.deepEqual(await pending, { registers: registers.replaceAll("\r", "").trimEnd() });
  h.monitor.close();
  const malformed = harness(); malformed.ready();
  const failure = assert.rejects(malformed.monitor.execute("query-registers"), /register observation/); malformed.read();
  assert.throws(() => malformed.write(reply("info registers", "RAX=oops\r\n")), ErrnoError); await failure; malformed.monitor.close();
});

test("the fixed translation query preserves split UTF-8 histograms and exact buffer counters", async () => {
  const h = harness(); h.ready();
  const pending = h.monitor.execute("query-translation-stats");
  assert.equal(h.read(), "info jit\n");
  const text = reply("info jit", QEMU_JIT_FIXTURE_TEXT.replaceAll("\n", "\r\n") + "\r\n");
  for (const byte of encoder.encode(text)) h.writeBytes(new Uint8Array([byte]));
  assert.deepEqual(await pending, { translationStats: QEMU_JIT_FIXTURE_STATS, monitorText: QEMU_JIT_FIXTURE_TEXT });
  assert.equal(h.errors.length, 0);
  const status = h.monitor.execute("query-status");
  assert.equal(h.read(), "info status\n");
  h.write(reply("info status", "VM status: paused\r\n"));
  assert.deepEqual(await status, { status: "paused", running: false });
  h.monitor.close();
});

test("translation statistics reject missing, duplicate, unsafe and unrecognized fields", () => {
  assert.deepEqual(parseQemuTranslationStats(QEMU_JIT_FIXTURE_TEXT), QEMU_JIT_FIXTURE_STATS);
  const noHistogram = QEMU_JIT_FIXTURE_TEXT.split("\n").filter(line => !line.startsWith("TB hash ")).join("\n");
  assert.deepEqual(parseQemuTranslationStats(noHistogram), QEMU_JIT_FIXTURE_STATS);
  for (const text of [
    QEMU_JIT_FIXTURE_TEXT.replace("TB count            1234\n", ""),
    QEMU_JIT_FIXTURE_TEXT.replace("TB count            1234", "TB count            1234\nTB count            1234"),
    QEMU_JIT_FIXTURE_TEXT.replace("12345678/524221440", "524221441/524221440"),
    QEMU_JIT_FIXTURE_TEXT.replace("12345678/524221440", "0/0"),
    QEMU_JIT_FIXTURE_TEXT.replace("12345678/524221440", "0/4294967296"),
    QEMU_JIT_FIXTURE_TEXT.replace("TB count            1234", "TB count            9007199254740993"),
    QEMU_JIT_FIXTURE_TEXT.replace("TB flush count      2", "TB flush count      -1"),
    QEMU_JIT_FIXTURE_TEXT.replace("TB flush count      2", "TB flush count      02"),
    QEMU_JIT_FIXTURE_TEXT.replace("TB count            1234", "TB count            1.5"),
    QEMU_JIT_FIXTURE_TEXT.replace("TB count            1234", "TB count            1█34"),
    QEMU_JIT_FIXTURE_TEXT.replace("▁", "é"),
    QEMU_JIT_FIXTURE_TEXT + "\nError: incomplete statistics",
    QEMU_JIT_FIXTURE_TEXT.replace("Accelerator settings:", "guest:~#"),
    QEMU_JIT_FIXTURE_TEXT.replace("1|█|1", "1|\x1b[2J█|1"),
    QEMU_JIT_FIXTURE_TEXT.replace("1|█|1", "x".repeat(4097)),
    "x".repeat(65_537),
  ]) assert.throws(() => parseQemuTranslationStats(text), /exact translation-buffer statistics/);
});

test("translation parsing failures close the monitor and do not relax other commands", async () => {
  for (const [command, wire, text] of [
    ["query-translation-stats", "info jit", QEMU_JIT_FIXTURE_TEXT.replace("▁", "é")],
    ["query-translation-stats", "info jit", QEMU_JIT_FIXTURE_TEXT.replace("TB count            1234", "TB count            -1")],
    ["query-status", "info status", "VM status: paused█"],
  ]) {
    const h = harness(); h.ready();
    const rejected = assert.rejects(h.monitor.execute(command), /invalid text|translation-buffer/);
    assert.equal(h.read(), wire + "\n");
    assert.throws(() => h.write(reply(wire, text + "\r\n")), ErrnoError);
    await rejected; assert.equal(h.errors.length, 1);
    await assert.rejects(h.monitor.execute("stop"), /closed/); h.monitor.close();
  }
});

test("missing, ambiguous and error status output permanently closes the monitor", async () => {
  for (const output of [
    "", "VM status: unknown\r\n", "VM status: paused-error\r\n", "Error: VM status: paused\r\n",
    "VM status: paused\r\nVM status: running\r\n", "VM status: paused\r\nError: failure\r\n",
  ]) {
    const h = harness(); h.ready();
    const failed = assert.rejects(h.monitor.execute("query-status"), /exact VM status/);
    assert.equal(h.read(), "info status\n");
    assert.throws(() => h.write(reply("info status", output)), ErrnoError); await failed;
    assert.equal(h.errors.length, 1);
    await assert.rejects(h.monitor.execute("stop"), /closed/); h.monitor.close();
  }
});

test("unmatched echo, command errors and malformed framing cannot acknowledge an operation", async () => {
  for (const output of [
    reply("cont"), reply("stop", "unknown command: stop\r\n"), "(qemu) ",
    reply("stop") + "unexpected", "\x1b[2Jstop\r\n(qemu) ",
  ]) {
    const h = harness(); h.ready();
    const failed = assert.rejects(h.monitor.execute("stop"), /unmatched|rejected|boundary|terminal control/);
    h.read(); assert.throws(() => h.write(output), ErrnoError); await failed;
    assert.equal(h.errors.length, 1); h.monitor.close();
  }
  const unread = harness(); unread.ready();
  const unreadFailure = assert.rejects(unread.monitor.execute("stop"), /unmatched/);
  assert.throws(() => unread.write(reply("stop")), ErrnoError); await unreadFailure; unread.monitor.close();
});

test("guest-like output, repeated greetings, invalid UTF-8 and unsolicited replies fail closed", async () => {
  for (const payload of ["guest:~# (qemu) ", "QEMU 99.0.0 monitor - type 'help' for more information\r\n(qemu) "]) {
    const h = harness(); const failed = assert.rejects(h.monitor.execute("stop"), /greeting/);
    assert.throws(() => h.write(payload), ErrnoError); await failed; assert.equal(h.errors.length, 1); h.monitor.close();
  }
  const h = harness(); h.ready();
  assert.throws(() => h.write(greeting), ErrnoError); assert.match(h.errors[0].message, /unsolicited/); h.monitor.close();
  const malformed = harness();
  assert.throws(() => malformed.writeBytes(new Uint8Array([0xff])), ErrnoError);
  assert.equal(malformed.errors.length, 1); malformed.monitor.close();
});

test("owner closure rejects active and queued commands without a fatal callback", async () => {
  for (const negotiated of [false, true]) {
    const h = harness(); if (negotiated) h.ready();
    const stopped = assert.rejects(h.monitor.execute("stop"), /closed/);
    const queued = assert.rejects(h.monitor.execute("cont"), /closed/);
    h.monitor.close(); await Promise.all([stopped, queued]);
    assert.equal(h.operations.poll(), 16); assert.equal(h.read(), "");
    assert.throws(() => h.write("late"), ErrnoError);
    await assert.rejects(h.monitor.execute("query-status"), /closed/);
    assert.throws(() => h.monitor.install(h.FS), /cannot be installed again/);
    assert.equal(h.errors.length, 0);
  }
});

test("output buffers, line width and queued requests remain bounded", async () => {
  for (const chunks of [[new Uint8Array(65_537)], [encoder.encode("x".repeat(33_000)), encoder.encode("x".repeat(33_000))]]) {
    const h = harness();
    assert.throws(() => { for (const chunk of chunks) h.writeBytes(chunk); }, ErrnoError);
    assert.match(h.errors[0].message, /output exceeded/); h.monitor.close();
  }
  const wide = harness(); assert.throws(() => wide.write("x".repeat(4097) + "(qemu) "), ErrnoError);
  assert.match(wide.errors[0].message, /line exceeded/); wide.monitor.close();
  const h = harness(); h.ready();
  const pending = Array.from({ length: 32 }, () => assert.rejects(h.monitor.execute("stop"), /closed/));
  await assert.rejects(h.monitor.execute("cont"), /queue is full/);
  assert.equal(h.read(), "stop\n"); h.monitor.close(); await Promise.all(pending);
});

test("greeting and command deadlines permanently close and reject all queued work", async () => {
  for (const negotiated of [false, true]) {
    const h = harness({ readyTimeoutMs: 5, commandTimeoutMs: 5 }); if (negotiated) h.ready();
    const pattern = negotiated ? /did not acknowledge/ : /did not become ready/;
    const active = assert.rejects(h.monitor.execute("stop"), pattern);
    const queued = assert.rejects(h.monitor.execute("cont"), pattern);
    if (negotiated) assert.equal(h.read(), "stop\n");
    await Promise.all([active, queued]);
    assert.equal(h.errors.length, 1); assert.equal(h.read(), "");
    assert.throws(() => h.write(negotiated ? reply("stop") : greeting), ErrnoError);
    await assert.rejects(h.monitor.execute("query-status"), /closed/);
    h.monitor.close(); assert.equal(h.errors.length, 1);
  }
});
