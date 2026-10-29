// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import * as workerThreads from "node:worker_threads";
import "fake-indexeddb/auto";
import { createVolume, deleteVolume, exportVolume, openVolume } from "./volume-store.ts";
import type { VolumeMeta } from "./volume-types.ts";
import {
  QemuVolumeManager, QEMU_DISK_HEADER_BYTES, QEMU_DISK_PENDING,
  QEMU_DISK_COMMITTED, QEMU_DISK_FAILED, QEMU_DISK_READONLY, QEMU_DISK_CANCELLED,
  type QemuDiskDescriptor, type QemuDiskRequest,
} from "./qemu-volumes.ts";

const holders = new Map<string, { readers: number; writer: boolean }>();
const testLocks = {
  async request(name: string, options: { mode: string }, callback: (lock: object | null) => Promise<unknown>) {
    const state = holders.get(name) ?? { readers: 0, writer: false };
    const shared = options.mode === "shared";
    if (state.writer || (!shared && state.readers)) return callback(null);
    holders.set(name, state); if (shared) state.readers++; else state.writer = true;
    try { return await callback({ name }); }
    finally { if (shared) state.readers--; else state.writer = false; }
  },
};
Object.defineProperty(navigator, "locks", { configurable: true, value: workerThreads.locks ?? testLocks });

function prepare(disk: QemuDiskDescriptor, sequence: number, data: Uint8Array, offset = 131072): QemuDiskRequest {
  const header = new Int32Array(disk.mailbox, 0, 4);
  new Uint8Array(disk.mailbox, QEMU_DISK_HEADER_BYTES, data.length).set(data);
  Atomics.store(header, 1, sequence);
  Atomics.store(header, 0, QEMU_DISK_PENDING);
  return { type: "disk-request", operation: "write", slot: disk.slot, sequence, offset, length: data.length };
}
function status(disk: QemuDiskDescriptor): number { return Atomics.load(new Int32Array(disk.mailbox, 0, 4), 0); }
function fakeStore(readOnly = false) {
  let release: (() => void) | null = null;
  let pendingGate: Promise<void> | null = null;
  let failure: Error | null = null;
  const bytes = new Uint8Array(4 * 1024 * 1024);
  const metadata: VolumeMeta = { id: "test-disk", name: "Test disk", bytes: bytes.length, kind: readOnly ? "snapshot" : "volume", filesystem: "ext2", createdAt: 1, updatedAt: 1, revision: 0, sha256: readOnly ? "1".repeat(64) : null };
  const result = {
    bytes, writes: 0, reads: 0, closes: 0,
    delay() { pendingGate = new Promise<void>((resolve) => { release = resolve; }); },
    commit() { release?.(); pendingGate = null; },
    fail(error: Error) { failure = error; },
    store: {
      async get() { return { ...metadata }; },
      async open() { return {
        readOnly,
        getMetadata: () => ({ ...metadata }),
        getState: () => ({ pendingWrites: 0, lastPersistedAt: 1, error: null }),
        subscribe: () => () => undefined,
        async read(offset: number, length: number) {
          result.reads++;
          if (pendingGate) await pendingGate;
          if (failure) throw failure;
          return bytes.slice(offset, offset + length);
        },
        async write(offset: number, data: Uint8Array) {
          result.writes++;
          if (pendingGate) await pendingGate;
          if (failure) throw failure;
          bytes.set(data, offset); metadata.revision++;
        },
        async flush() { if (failure) throw failure; },
        async close() { result.closes++; },
      }; },
    },
  };
  return result;
}

test("QEMU disk acknowledgments follow actual IndexedDB commits and survive a new attachment", async () => {
  const meta = await createVolume({ name: "QEMU disk", sizeMiB: 4 });
  const manager = new QemuVolumeManager([{ id: meta.id, slot: 1 }]);
  try {
    const [disk] = await manager.open();
    assert.equal(disk.slot, 1);
    assert.equal(disk.transport, "paged-v1");
    assert.equal("image" in disk, false);
    await assert.rejects(openVolume(meta.id), /attached|use/);
    const request = prepare(disk, 1, new Uint8Array([10, 20, 30]));
    const write = manager.handleRequest(request);
    assert.equal(status(disk), QEMU_DISK_PENDING);
    await write;
    assert.equal(status(disk), QEMU_DISK_COMMITTED);
    manager.markMounted();
    assert.equal(manager.getStates()[0].status, "mounted");
    await manager.close();
    const exported = await exportVolume(meta.id);
    assert.deepEqual(new Uint8Array(exported.buffer, 131072, 3), new Uint8Array([10, 20, 30]));
    const [reopened] = await manager.open();
    const readRequest = { ...prepare(reopened, 1, new Uint8Array(3)), operation: "read" as const };
    await manager.handleRequest(readRequest);
    assert.equal(status(reopened), QEMU_DISK_COMMITTED);
    assert.deepEqual(new Uint8Array(reopened.mailbox, QEMU_DISK_HEADER_BYTES, 3), new Uint8Array([10, 20, 30]));
    assert.notEqual(reopened.mailbox, disk.mailbox);
    await manager.close();
  } finally { await manager.close().catch(() => undefined); await deleteVolume(meta.id); }
});

test("a delayed QEMU write owns its payload and cannot acknowledge before storage completes", async () => {
  const storage = fakeStore(); storage.delay();
  const manager = new QemuVolumeManager([{ id: "test-disk", slot: 0 }], { store: storage.store });
  const [disk] = await manager.open();
  const request = prepare(disk, 1, new Uint8Array([11, 12, 13]));
  const write = manager.handleRequest(request);
  new Uint8Array(disk.mailbox, QEMU_DISK_HEADER_BYTES, 3).fill(99);
  await Promise.resolve();
  assert.equal(storage.writes, 1);
  assert.equal(status(disk), QEMU_DISK_PENDING);
  assert.deepEqual(storage.bytes.slice(131072, 131075), new Uint8Array(3));
  storage.commit(); await write;
  assert.equal(status(disk), QEMU_DISK_COMMITTED);
  assert.deepEqual(storage.bytes.slice(131072, 131075), new Uint8Array([11, 12, 13]));
  await manager.close();
});

test("closing QEMU disks wakes a blocked worker but retains storage ownership until commit settles", async () => {
  const storage = fakeStore(); storage.delay();
  const manager = new QemuVolumeManager([{ id: "test-disk", slot: 0 }], { store: storage.store });
  const [disk] = await manager.open();
  const write = manager.handleRequest(prepare(disk, 1, new Uint8Array([42])));
  await Promise.resolve();
  const closing = manager.close();
  assert.equal(manager.close(), closing);
  assert.equal(status(disk), QEMU_DISK_CANCELLED);
  assert.equal(storage.closes, 0);
  await assert.rejects(manager.open(), /previous disk lifecycle/);
  storage.commit(); await write; await closing;
  assert.equal(status(disk), QEMU_DISK_CANCELLED);
  assert.equal(storage.closes, 1);
  assert.equal(storage.bytes[131072], 42);
});

test("a QEMU host storage failure cannot acknowledge or expose a successful block write", async () => {
  const storage = fakeStore(); storage.fail(new Error("Quota transaction failed"));
  const errors: string[] = [];
  const manager = new QemuVolumeManager([{ id: "test-disk", slot: 0 }], { store: storage.store, onError: (error) => errors.push(error.message) });
  const [disk] = await manager.open();
  await assert.rejects(manager.handleRequest(prepare(disk, 1, new Uint8Array([42]))), /Quota/);
  assert.equal(status(disk), QEMU_DISK_FAILED);
  assert.equal(storage.bytes[131072], 0);
  assert.equal(manager.getStates()[0].status, "error");
  assert.deepEqual(errors, ["Quota transaction failed"]);
  await assert.rejects(manager.flush(), /Quota/);
  await manager.close();
});

test("QEMU host write protection rejects worker attempts independently of the guest device flag", async () => {
  const storage = fakeStore(true);
  const manager = new QemuVolumeManager([{ id: "test-disk", slot: 0, readOnly: false }], { store: storage.store });
  const [disk] = await manager.open();
  assert.equal(disk.readOnly, true);
  await assert.rejects(manager.handleRequest(prepare(disk, 1, new Uint8Array([42]))), /write protection/);
  assert.equal(status(disk), QEMU_DISK_READONLY);
  assert.equal(storage.writes, 0);
  assert.equal(storage.bytes[131072], 0);
  await manager.close();
});

test("QEMU disk requests reject replay, out-of-range writes and concurrent mailbox reuse", async () => {
  for (const mutation of [
    (request: QemuDiskRequest) => ({ ...request, sequence: 2 }),
    (request: QemuDiskRequest) => ({ ...request, offset: -1 }),
    (request: QemuDiskRequest) => ({ ...request, length: 65537 }),
    (request: QemuDiskRequest) => ({ ...request, operation: "flush", length: 1 }),
  ]) {
    const storage = fakeStore();
    const manager = new QemuVolumeManager([{ id: "test-disk", slot: 0 }], { store: storage.store });
    const [disk] = await manager.open();
    await assert.rejects(manager.handleRequest(mutation(prepare(disk, 1, new Uint8Array([42])))), /invalid|bounded/);
    assert.equal(status(disk), QEMU_DISK_FAILED);
    assert.equal(storage.writes, 0);
    await manager.close();
  }
  const storage = fakeStore(); storage.delay();
  const manager = new QemuVolumeManager([{ id: "test-disk", slot: 0 }], { store: storage.store });
  const [disk] = await manager.open();
  const request = prepare(disk, 1, new Uint8Array([42]));
  const first = manager.handleRequest(request);
  await assert.rejects(manager.handleRequest(request), /Overlapping/);
  storage.commit(); await assert.rejects(first, /Overlapping/);
  assert.equal(status(disk), QEMU_DISK_FAILED);
  await manager.close();
});

test("closing during an asynchronous disk open releases the eventual lock without booting it", async () => {
  const storage = fakeStore();
  let resolveOpen!: () => void;
  const gate = new Promise<void>((resolve) => { resolveOpen = resolve; });
  const manager = new QemuVolumeManager([{ id: "test-disk", slot: 0 }], { store: { get: storage.store.get, open: async () => { await gate; return storage.store.open(); } } });
  const opening = manager.open();
  const closing = manager.close();
  resolveOpen();
  await assert.rejects(opening, /cancelled/);
  await closing;
  assert.equal(storage.closes, 1);
  assert.equal(manager.getStates()[0].status, "closed");
});

test("host reads acknowledge only settled bytes and a closed generation cannot publish a late payload", async () => {
  const storage = fakeStore(); storage.delay(); storage.bytes.set([10,20,30], 131072);
  const manager = new QemuVolumeManager([{ id: "test-disk", slot: 0 }], { store: storage.store });
  const [disk] = await manager.open(), request = { ...prepare(disk, 1, new Uint8Array([99,99,99])), operation: "read" as const };
  const reading = manager.handleRequest(request); await Promise.resolve();
  assert.equal(storage.reads, 1); assert.equal(status(disk), QEMU_DISK_PENDING);
  assert.deepEqual(new Uint8Array(disk.mailbox, QEMU_DISK_HEADER_BYTES, 3), new Uint8Array([99,99,99]));
  const closing = manager.close(); assert.equal(status(disk), QEMU_DISK_CANCELLED); assert.equal(storage.closes, 0);
  storage.commit(); await reading; await closing;
  assert.equal(status(disk), QEMU_DISK_CANCELLED); assert.equal(storage.closes, 1);
  assert.deepEqual(new Uint8Array(disk.mailbox, QEMU_DISK_HEADER_BYTES, 3), new Uint8Array([99,99,99]));
});

test("validated request fields are owned before await and changed read headers fail without publishing bytes", async () => {
  const storage = fakeStore(true); storage.bytes.set([5,6,7], 131072);
  const manager = new QemuVolumeManager([{ id: "test-disk", slot: 0 }], { store: storage.store });
  const [disk] = await manager.open();
  const request: QemuDiskRequest = { ...prepare(disk, 1, new Uint8Array(3)), operation: "read" };
  const reading = manager.handleRequest(request);
  request.operation = "write"; request.offset = storage.bytes.length + 1; request.length = 65537;
  await reading;
  assert.equal(status(disk), QEMU_DISK_COMMITTED); assert.equal(storage.writes, 0);
  assert.deepEqual(new Uint8Array(disk.mailbox, QEMU_DISK_HEADER_BYTES, 3), new Uint8Array([5,6,7]));
  storage.delay();
  const later = manager.handleRequest({ ...prepare(disk, 2, new Uint8Array([42,42,42])), operation: "read" });
  await Promise.resolve(); Atomics.store(new Int32Array(disk.mailbox, 0, 4), 1, 3); storage.commit();
  await assert.rejects(later, /changed a pending disk request/);
  assert.equal(status(disk), QEMU_DISK_FAILED);
  assert.deepEqual(new Uint8Array(disk.mailbox, QEMU_DISK_HEADER_BYTES, 3), new Uint8Array([42,42,42]));
  await manager.close();
});
