// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import type { V86 } from "v86";
import { PersistentVirtioBlock } from "./volume-device.ts";
import type { VolumeSession } from "./volume-store.ts";

type Constructor = NonNullable<typeof globalThis.TerrariumVirtIO>;
type Options = ConstructorParameters<Constructor>[1];
type Queue = InstanceType<Constructor>["queues"][number];
type Chain = ReturnType<Queue["pop_request"]>;

function fixture(type: number, readOnly: boolean, overrides: Record<string, unknown> = {}) {
  const memory = new Uint8Array(65536).fill(0xcc);
  const header = new Uint8Array(type === 1 ? 528 : 16);
  new DataView(header.buffer).setUint32(0, type, true);
  const writable = type === 0 ? 513 : 1;
  let readOffset = 0, writeOffset = 0, writes = 0, replies = 0;
  const failures: Error[] = [];
  const chain: Chain = {
    length_readable: header.length, length_writable: writable, length_written: 0,
    read_buffers: [{ addr_low: 5000, addr_high: 0, len: header.length }],
    write_buffers: [{ addr_low: 8000, addr_high: 0, len: writable }],
    get_next_blob(target) { target.set(header.subarray(readOffset, readOffset + target.length)); readOffset += target.length; return target.length; },
    set_next_blob(data) { memory.set(data, 8000 + writeOffset); writeOffset += data.length; this.length_written += data.length; return data.length; },
  };
  const requests = [chain];
  const queue: Queue = {
    enabled: true, size: 8, desc_addr: 0x100, avail_addr: 0x1000, used_addr: 0x2000,
    count_requests: () => requests.length, has_request: () => requests.length > 0,
    pop_request: () => requests.shift()!, push_reply: () => { replies++; }, flush_replies() {}, notify_me_after() {},
  };
  let options!: Options;
  let transport!: InstanceType<Constructor>;
  class FakeTransport {
    queues = [queue];
    constructor(_cpu: ConstructorParameters<Constructor>[0], value: Options) { options = value; transport = this; }
    needs_reset() {}
    reset() {}
  }
  const original = globalThis.TerrariumVirtIO;
  globalThis.TerrariumVirtIO = FakeTransport;
  const session = {
    readOnly, getMetadata: () => ({ bytes: 4 * 1024 * 1024, id: "test-disk" }),
    read: async (_offset: number, length: number) => new Uint8Array(length).fill(42),
    write: async () => { writes++; }, flush: async () => {}, ...overrides,
  } as unknown as VolumeSession;
  const cpu = { mem8: memory, write8: (offset: number, value: number) => { memory[offset] = value; } };
  const device = new PersistentVirtioBlock({ v86: { cpu } } as unknown as V86, session, 0, (error) => failures.push(error));
  return {
    memory, options, transport, device, failures,
    get writes() { return writes; }, get replies() { return replies; },
    notify: () => options.notification.handlers[0](0),
    close: () => { device.dispose(); globalThis.TerrariumVirtIO = original; },
  };
}

test("a guest bypassing its own RO flag receives I/O error without host mutation", async () => {
  const testCase = fixture(1, true);
  try {
    assert.ok(testCase.options.common.features.includes(5));
    testCase.notify(); await testCase.device.drain();
    assert.equal(testCase.memory[8000], 1);
    assert.equal(testCase.writes, 0);
    assert.equal(testCase.replies, 1);
    assert.equal(testCase.failures.length, 0);
  } finally { testCase.close(); }
});

test("storage failure returns I/O error and never a successful completion", async () => {
  const testCase = fixture(1, false, { write: async () => { throw new Error("quota exhausted"); } });
  try {
    testCase.notify(); await testCase.device.drain();
    assert.equal(testCase.memory[8000], 1);
    assert.equal(testCase.replies, 1);
    assert.match(testCase.failures[0].message, /quota/);
  } finally { testCase.close(); }
});

test("a driver reset cancels stale DMA even when it reuses the same queue addresses", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const testCase = fixture(0, false, { read: async () => { await pending; return new Uint8Array(512).fill(42); } });
  try {
    testCase.notify(); await Promise.resolve();
    testCase.transport.reset(); release();
    await testCase.device.drain();
    assert.equal(testCase.replies, 0);
    assert.equal(testCase.memory[8000], 0xcc);
    assert.equal(testCase.memory[8512], 0xcc);
  } finally { testCase.close(); }
});
