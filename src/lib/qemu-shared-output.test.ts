// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSerialPipes } from "../../public/runtime/qemu/serial.js";
import { createPipeMonitor, type MonitorDeviceOperations } from "../../public/runtime/qemu/monitor.js";
import { startQemu } from "../../public/runtime/qemu/engine.js";

const encoder = new TextEncoder();
class ErrnoError extends Error { constructor(errno: number) { super(String(errno)); } }

/** Node accepts shared views here; reproduce the browser's stricter boundary. */
async function withBrowserDecoder(action: (sizes: number[]) => Promise<void>) {
  const original = globalThis.TextDecoder, sizes: number[] = [];
  class BrowserDecoder extends original {
    override decode(input?: AllowSharedBufferSource, options?: TextDecodeOptions): string {
      if (input) {
        const buffer = ArrayBuffer.isView(input) ? input.buffer : input;
        if (buffer instanceof SharedArrayBuffer)
          throw new TypeError("The provided ArrayBufferView value must not be shared.");
        assert.ok(input.byteLength <= 65_536, "each decoder copy must remain bounded");
        sizes.push(input.byteLength);
      }
      return super.decode(input, options);
    }
  }
  globalThis.TextDecoder = BrowserDecoder;
  try { await action(sizes); } finally { globalThis.TextDecoder = original; }
}

function sharedBytes(text: string, padding = 7) {
  const bytes = encoder.encode(text), shared = new Uint8Array(new SharedArrayBuffer(bytes.length + padding * 2));
  shared.fill(0x21); shared.set(bytes, padding);
  return { shared, padding, length: bytes.length };
}

test("interactive UART output copies shared bytes with exact offsets and streaming UTF-8 across bounded chunks", async () => {
  await withBrowserDecoder(async (sizes) => {
    const text = "☘" + "x".repeat(65_534) + "雪z", input = sharedBytes(text);
    const operations = new Map<number, MonitorDeviceOperations>();
    const output: string[] = [];
    const serial = createSerialPipes({ onOutput(port, data) { assert.equal(port, 1); output.push(data); } });
    serial.install({
      ErrnoError, makedev: (major, minor) => major * 256 + minor,
      registerDevice: (id, value) => { operations.set(id, value); }, mkdirTree() {}, mkdev() {},
    });
    try {
      assert.throws(() => new TextDecoder().decode(input.shared), /must not be shared/, "the fixture must reproduce the browser restriction");
      const port = operations.get(82 * 256 + 1)!;
      assert.equal(port.write({}, input.shared, input.padding, 2), 2);
      assert.equal(port.write({}, input.shared, input.padding + 2, input.length - 2), input.length - 2);
      serial.clear();
      assert.equal(output.join(""), text);
      assert.ok(sizes.includes(65_536));
      assert.ok(sizes.length >= 3);
    } finally { serial.close(); }
  });
});

test("private monitor greeting and responses decode shared Wasm views without copying unrelated memory", async () => {
  await withBrowserDecoder(async (sizes) => {
    let device!: MonitorDeviceOperations;
    const failures: Error[] = [];
    const monitor = createPipeMonitor({ onError: (error) => failures.push(error) });
    monitor.install({
      ErrnoError, makedev: (major, minor) => major * 256 + minor,
      registerDevice: (_id, value) => { device = value; }, mkdirTree() {}, mkdev() {},
    });
    const write = (text: string) => {
      const input = sharedBytes(text);
      assert.equal(device.write({}, input.shared, input.padding, input.length), input.length);
    };
    try {
      write("QEMU 8.2.0 monitor - type 'help' for more information\r\n(qemu) ");
      const pending = monitor.execute("query-status");
      const command = new Uint8Array(new SharedArrayBuffer(64));
      const count = device.read({}, command, 3, 61);
      assert.equal(new TextDecoder().decode(new Uint8Array(command.subarray(3, 3 + count))), "info status\n");
      write("info status\r\nVM status: paused\r\n(qemu) ");
      assert.deepEqual(await pending, { status: "paused", running: false });
      assert.deepEqual(failures, []);
      assert.ok(sizes.length >= 3);
    } finally { monitor.close(); }
  });
});

test("the control console accepts shared views using bounded ordinary copies and one streaming decoder", async () => {
  await withBrowserDecoder(async (sizes) => {
    const socket = globalThis.WebSocket;
    const text = "☘" + "x".repeat(65_534) + "雪z", input = sharedBytes(text);
    const events: Record<string, unknown>[] = [];
    let engine: Awaited<ReturnType<typeof startQemu>> | undefined;
    try {
      engine = await startQemu({ assets: { module: new ArrayBuffer(0) }, manifest: {} }, {
        emit: (event) => events.push(event), pthreadUrl: "https://example.invalid/pthread.js",
        async loadModule() {
          return { url: "https://example.invalid/module.js", async factory(options) {
            const pty = options.pty as { write: (bytes: Uint8Array) => void };
            pty.write(input.shared.subarray(input.padding, input.padding + 2));
            pty.write(input.shared.subarray(input.padding + 2, input.padding + input.length));
            return { PThread: { terminateAllThreads() {} } };
          } };
        },
      });
      await engine.destroy();
      assert.equal(events.filter((event) => event.type === "output").map((event) => event.data).join(""), text);
      assert.ok(sizes.includes(65_536));
      assert.ok(sizes.length >= 3);
    } finally { await engine?.destroy(); globalThis.WebSocket = socket; }
  });
});
