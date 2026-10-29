// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSerialPipes } from "../../public/runtime/qemu/serial.js";
import type { MonitorDeviceOperations } from "../../public/runtime/qemu/monitor.js";
import { installPersistentDisks, installEvidenceDisk, type DiskNode, type DiskRequest } from "../../public/runtime/qemu/block.js";
import { createCheckpointDisk, validateCheckpointDisk } from "../../public/runtime/qemu/checkpoint.js";

class ErrnoError extends Error {
  readonly errno: number;
  constructor(errno: number) { super(`errno ${errno}`); this.errno = errno; }
}

test("interactive UART queues remain independent and preserve split Unicode output", () => {
  const devices = new Map<number, MonitorDeviceOperations>(), events: [number, string][] = [];
  const serial = createSerialPipes({ onOutput: (port, text) => events.push([port, text]) });
  serial.install({ ErrnoError, makedev: (_major, minor) => minor,
    registerDevice: (id, operations) => { devices.set(id, operations); }, mkdirTree() {}, mkdev() {},
  });
  serial.input(1, "first\n"); serial.input(2, "second\n");
  const read = (port: number): string => { const bytes = new Uint8Array(32); const length = devices.get(port)!.read({}, bytes, 0, bytes.length); return new TextDecoder().decode(bytes.subarray(0, length)); };
  assert.equal(read(2), "second\n"); assert.equal(read(1), "first\n");
  assert.throws(() => read(3), (error: unknown) => error instanceof ErrnoError && error.errno === 6);
  const unicode = new TextEncoder().encode("雪🙂");
  for (const byte of unicode) devices.get(3)!.write({}, new Uint8Array([byte]), 0, 1);
  serial.clear(); assert.deepEqual(events, [[3, "雪🙂"]]);
  assert.throws(() => serial.input(0, "control"), /Invalid/);
  assert.throws(() => serial.input(1, "雪".repeat(11_000)), /queue/);
  serial.input(1, "x".repeat(32_768)); serial.input(1, "x".repeat(32_768));
  assert.throws(() => serial.input(1, "x"), /queue/);
  serial.close(); assert.equal(devices.get(1)!.poll(), 16);
  assert.throws(() => devices.get(1)!.write({}, new Uint8Array([1]), 0, 1), ErrnoError);
});

function diskHarness(readOnly = false, rejectSequence = 0, logicalBytes = 4 * 1024 * 1024) {
  const mailbox = new SharedArrayBuffer(16 + 65_536), committed = new Map<number, number>();
  const payload = new Uint8Array(mailbox, 16);
  const header = new Int32Array(mailbox, 0, 4), requests: DiskRequest[] = [], errors: Error[] = [];
  const node = { usedBytes: 0, contents: new Uint8Array(), node_ops: { setattr(_target: unknown, attributes: { size?: number }) { assert.equal(attributes.size, undefined); } }, stream_ops: {}, mount: { type: {} } } as unknown as DiskNode;
  const disk = installPersistentDisks({ ErrnoError, mkdirTree() {}, writeFile() {}, lookupPath: () => ({ node }) },
    [{ slot: 0, bytes: logicalBytes, readOnly, transport: "paged-v1", mailbox }], (request) => {
      requests.push(request);
      assert.equal(node.contents.byteLength, 0, "the worker must not own a logical-sized disk cache");
      if (request.sequence !== rejectSequence) for (let i = 0; i < request.length; i++) {
        if (request.operation === "write") committed.set(request.offset + i, payload[i]);
        else if (request.operation === "read") payload[i] = committed.get(request.offset + i) ?? 0;
      }
      Atomics.store(header, 0, request.sequence === rejectSequence ? -1 : 1); Atomics.notify(header, 0);
    }, (error) => errors.push(error));
  return { disk, node, requests, errors, committed };
}

test("QEMU reads and writes are bounded and all bytes come from the host committed store", () => {
  const h = diskHarness();
  const bytes = new Uint8Array(65_540).fill(7);
  assert.equal(h.node.stream_ops.write({}, bytes, 0, bytes.length, 512), bytes.length);
  assert.deepEqual(h.requests.map(({ sequence, offset, length }) => ({ sequence, offset, length })), [
    { sequence: 1, offset: 512, length: 65_536 }, { sequence: 2, offset: 66_048, length: 4 },
  ]);
  const actual = new Uint8Array(bytes.length);
  assert.equal(h.node.stream_ops.read({}, actual, 0, actual.length, 512), bytes.length); assert.deepEqual(actual, bytes);
  h.disk.flush(); assert.equal(h.requests.at(-1)!.operation, "flush");
  assert.throws(() => h.node.stream_ops.write({}, bytes, 0, 512, 4 * 1024 * 1024), ErrnoError);
  assert.throws(() => h.node.node_ops.setattr(h.node, { size: 8 * 1024 * 1024 }), ErrnoError);
  h.disk.close(); assert.throws(() => h.node.stream_ops.read({}, actual, 0, 1, 0), ErrnoError);
});

test("read-only disks reject direct writes and a failed commit never becomes readable success", () => {
  const ro = diskHarness(true);
  assert.throws(() => ro.node.stream_ops.write({}, new Uint8Array([9]), 0, 1, 0), (error: unknown) => error instanceof ErrnoError && error.errno === 69);
  assert.equal(ro.requests.length, 0); ro.disk.close();
  const failed = diskHarness(false, 1);
  assert.throws(() => failed.node.stream_ops.write({}, new Uint8Array([9]), 0, 1, 0), ErrnoError);
  assert.equal(failed.committed.get(0) ?? 0, 0); assert.equal(failed.errors.length, 1);
  assert.equal(failed.node.contents.byteLength, 0);
  assert.throws(() => failed.node.stream_ops.read({}, new Uint8Array(1), 0, 1, 0), ErrnoError);
  failed.disk.close();
});

test("invalid block source and destination ranges fail before a mailbox request or cache mutation", () => {
  const h = diskHarness(), source = new Uint8Array([7, 8]);
  for (const [offset, length] of [[0, 3], [-1, 1], [1, 2], [0.5, 1], [0, NaN], [Number.MAX_SAFE_INTEGER, 1]]) {
    assert.throws(() => h.node.stream_ops.write({}, source, offset, length, 0), ErrnoError);
    assert.throws(() => h.node.stream_ops.read({}, source, offset, length, 0), ErrnoError);
  }
  for (const [offset, length] of [[-1, 1], [0, -1], [NaN, 1], [0, Infinity], [0.5, 512]])
    assert.throws(() => h.node.stream_ops.allocate({}, offset, length), ErrnoError);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(source, new Uint8Array([7, 8]));
  assert.equal(h.node.contents.byteLength, 0); assert.equal(h.committed.size, 0);
  // The actual pinned Emscripten syscall path uses signed HEAP8 views.
  h.node.stream_ops.write({}, new Int8Array([-1, -128]), 0, 2, 0);
  const readback = new Int8Array(2);
  assert.equal(h.node.stream_ops.read({}, readback, 0, 2, 0), 2);
  assert.deepEqual(readback, new Int8Array([-1, -128]));
  h.disk.close();
});

test("8 GiB logical disk offsets stay exact without allocating or resizing MEMFS contents", () => {
  const bytes = 8 * 1024 * 1024 * 1024, h = diskHarness(false, 0, bytes);
  assert.equal(h.node.usedBytes, bytes);
  assert.equal(h.node.contents.byteLength, 0);
  h.node.node_ops.setattr(h.node, { size: bytes });
  const tail = new Uint8Array([17, 201]);
  h.node.stream_ops.write({}, tail, 0, 2, bytes - 2);
  const result = new Uint8Array(2);
  assert.equal(h.node.stream_ops.read({}, result, 0, 2, bytes - 2), 2);
  assert.deepEqual(result, tail);
  assert.deepEqual(h.requests.map(({ operation, offset }) => [operation, offset]), [["write", bytes - 2], ["read", bytes - 2]]);
  assert.equal(h.node.stream_ops.read({}, result, 0, 2, bytes), 0);
  assert.equal(h.node.contents.byteLength, 0);
  h.disk.close();
});

test("private state disks reject external backing, unknown features and invalid metadata extents", () => {
  const initial = createCheckpointDisk();
  assert.equal(validateCheckpointDisk(initial, false), initial);
  assert.throws(() => validateCheckpointDisk(initial), /exactly one/);
  for (const mutate of [
    (view: DataView) => view.setBigUint64(8, 104n),
    (view: DataView) => view.setBigUint64(72, 4n),
    (view: DataView) => view.setBigUint64(40, 0xffff0000n),
    (view: DataView) => view.setUint32(100, 112),
  ]) {
    const changed = initial.slice(); mutate(new DataView(changed.buffer));
    assert.throws(() => validateCheckpointDisk(changed, false), /features|extent/);
  }
});

test("evidence files reject writes, truncation, allocation and writable mappings at the host", () => {
  const image = new ArrayBuffer(4 * 1024 * 1024); new Uint8Array(image)[1024] = 77;
  const node = { usedBytes: 0, contents: new Uint8Array(), node_ops: { setattr() {} }, stream_ops: {}, mount: { type: {} } } as unknown as DiskNode;
  installEvidenceDisk({ ErrnoError, mkdirTree() {},
    writeFile(_path, bytes) { node.contents = bytes; node.usedBytes = bytes.length; },
    lookupPath: () => ({ node }),
  }, image);
  for (const attempt of [
    () => node.stream_ops.write({}, new Uint8Array([9]), 0, 1, 1024),
    () => node.stream_ops.allocate({}, 0, image.byteLength),
    () => node.stream_ops.mmap(), () => node.stream_ops.msync(),
    () => node.node_ops.setattr(node, { size: 0 }),
  ]) assert.throws(attempt, (error: unknown) => error instanceof ErrnoError && error.errno === 69);
  assert.equal(node.contents[1024], 77); assert.equal(node.usedBytes, image.byteLength);
});
