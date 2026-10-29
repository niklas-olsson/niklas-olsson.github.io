// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import * as workerThreads from "node:worker_threads";
import "fake-indexeddb/auto";
import { createExt2Image, createExt2Pages } from "./volume-format.ts";
import { cloneVolume, createVolume, deleteVolume, exportVolume, exportVolumeTo, getVolume, hashVolume, listVolumes, openVolume, recoverVolumeCopies, snapshotVolume, VOLUME_DB_VERSION } from "./volume-store.ts";
import { VOLUME_CACHE_BYTES, VOLUME_PAGE_BYTES, VOLUME_TRANSFER_BYTES, VOLUME_WRITE_QUEUE_BYTES, type VolumeMeta } from "./volume-types.ts";

const MIB = 1024 * 1024, DB = "terrarium-volumes-v1", UUID = "12345678-1234-1234-1234-123456789abc";
const holders = new Map<string, { readers: number; writer: boolean }>();
const testLocks = { async request(name: string, options: { mode?: string }, callback: (lock: object | null) => Promise<unknown>) {
  const state = holders.get(name) ?? { readers: 0, writer: false }, shared = options.mode === "shared";
  if (state.writer || (!shared && state.readers)) return callback(null);
  holders.set(name, state); if (shared) state.readers++; else state.writer = true;
  try { return await callback({ name }); } finally { if (shared) state.readers--; else state.writer = false; }
} };
Object.defineProperty(navigator, "locks", { configurable: true, value: workerThreads.locks ?? testLocks });

async function dbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function mutate(work: (tx: IDBTransaction) => void): Promise<void> {
  const db = await dbOpen();
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([...db.objectStoreNames], "readwrite"); work(tx);
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
  }); } finally { db.close(); }
}
async function count(store: string): Promise<number> {
  const db = await dbOpen();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction(store), request = tx.objectStore(store).count();
    tx.oncomplete = () => resolve(request.result); tx.onabort = tx.onerror = () => reject(tx.error);
  }); } finally { db.close(); }
}

test("v1 volume records migrate atomically to schema2 without rewriting bytes or metadata", async () => {
  const metadata: VolumeMeta = { id: UUID, name: "v0.7 fixture", bytes: 4 * MIB, kind: "volume", filesystem: "ext2", createdAt: 1, updatedAt: 1, revision: 0, sha256: null };
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("metadata", { keyPath: "id" });
      request.result.createObjectStore("pages", { keyPath: ["id", "index"] });
      request.transaction!.objectStore("metadata").add(metadata);
      for (const page of createExt2Pages(4, UUID)) request.transaction!.objectStore("pages").add({ ...page, id: UUID });
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  db.close();
  assert.deepEqual(await getVolume(UUID), metadata);
  const upgraded = await dbOpen(); assert.equal(upgraded.version, VOLUME_DB_VERSION); assert.equal(upgraded.objectStoreNames.contains("staging"), true); upgraded.close();
  assert.equal((await exportVolume(UUID)).sha256, createHash("sha256").update(new Uint8Array(createExt2Image(4, UUID))).digest("hex"));
  assert.equal(await count("staging"), 0);
  await deleteVolume(UUID);
});

test("sparse creation preserves small layouts and emits only65 bounded pages for8GiB", () => {
  for (const size of [4, 16]) {
    const actual = new Uint8Array(size * MIB);
    for (const page of createExt2Pages(size, UUID)) actual.set(page.data, page.index * VOLUME_PAGE_BYTES);
    assert.deepEqual(actual, new Uint8Array(createExt2Image(size, UUID)));
  }
  const pages = [...createExt2Pages(8192, UUID)];
  assert.equal(pages.length, 65);
  assert.equal(pages.reduce((bytes, page) => bytes + page.data.byteLength, 0), 65 * VOLUME_PAGE_BYTES);
  assert.equal(new DataView(pages[0].data.buffer).getUint32(1028, true), 2_097_152);
  assert.equal(new DataView(pages.at(-1)!.data.buffer).getUint16(0x38, true), 0xef53);
  assert.equal(new DataView(pages.at(-1)!.data.buffer).getUint16(0x5a, true), 63);
  assert.throws(() => [...createExt2Pages(8193, UUID)], /8192/);
  assert.throws(() => createExt2Image(8192, UUID), /128/);
});

test("8GiB sparse disks preserve partial/high-offset writes, independent copies, RO and cancelled streaming leases", async () => {
  const metadata = await createVolume({ name: "large sparse fixture", sizeMiB: 8192 });
  let clone: VolumeMeta | null = null;
  try {
    const session = await openVolume(metadata.id);
    assert.equal(session.getStorageStats().cacheBytes, 0);
    const offset = 4 * 1024 * MIB + VOLUME_PAGE_BYTES - 3, input = new Uint8Array([1,2,3,4,5,6,7]);
    assert.deepEqual(await session.read(metadata.bytes - 16, 16), new Uint8Array(16));
    await session.write(offset, input);
    await session.write(metadata.bytes - 3, new Uint8Array([31,32,33]));
    assert.deepEqual(await session.read(offset - 1, 9), new Uint8Array([0,1,2,3,4,5,6,7,0]));
    assert.ok(session.getStorageStats().cacheBytes < MIB);
    await assert.rejects(session.read(0, VOLUME_TRANSFER_BYTES + 1), /request budget/);
    await session.close();
    clone = await cloneVolume(metadata.id);
    assert.equal(clone.bytes, 8 * 1024 * MIB);
    assert.equal(await count("staging"), 0);
    const copied = await openVolume(clone.id);
    assert.deepEqual(await copied.read(offset, 7), input);
    assert.deepEqual(await copied.read(metadata.bytes - 3, 3), new Uint8Array([31,32,33]));
    await copied.write(offset, new Uint8Array([99])); await copied.close();
    const original = await openVolume(metadata.id, { readOnly: true });
    await assert.rejects(original.write(offset, new Uint8Array([8])), /write protection/);
    assert.deepEqual(await original.read(offset, 7), input); await original.close();
    await assert.rejects(exportVolume(metadata.id), /streaming file sink/);
    const controller = new AbortController(); let chunks = 0;
    await assert.rejects(exportVolumeTo(metadata.id, { async write(chunk) {
      assert.equal(chunk.byteLength, MIB); chunks++;
      await assert.rejects(openVolume(metadata.id), /attached|use/);
      if (chunks === 2) controller.abort();
    } }, { signal: controller.signal }), { name: "AbortError" });
    assert.equal(chunks, 2);
    const reopened = await openVolume(metadata.id); await reopened.close();
  } finally { if (clone) await deleteVolume(clone.id); await deleteVolume(metadata.id); }
});

test("the64MiB LRU actually evicts and reloads committed pages without eager capacity allocation", async () => {
  const metadata = await createVolume({ name: "eviction fixture", sizeMiB: 8192 });
  const session = await openVolume(metadata.id), base = 512 * MIB;
  try {
    await session.write(base, new Uint8Array([197]));
    for (let i = 0; i < 65; i++) await session.read(base + i * MIB, MIB);
    const stats = session.getStorageStats();
    assert.equal(stats.cacheBytes, VOLUME_CACHE_BYTES); assert.equal(stats.peakCacheBytes, VOLUME_CACHE_BYTES);
    assert.ok(stats.cacheEvictions >= 16); assert.ok(stats.cacheMisses >= 1040);
    assert.throws(() => session.cachedRead(base, 1), /not cached/);
    assert.deepEqual(await session.read(base, 1), new Uint8Array([197]));
    assert.equal(session.getStorageStats().cacheBytes, VOLUME_CACHE_BYTES);
  } finally { await session.close(); await deleteVolume(metadata.id); }
});

test("stream export/hash keep raw SHA256, bounded chunks, backpressure and sink-failure release", async () => {
  const metadata = await createVolume({ name: "stream fixture", sizeMiB: 4 });
  try {
    const expected = await exportVolume(metadata.id), hash = createHash("sha256");
    let bytes = 0, busy = false, maximum = 0;
    const result = await exportVolumeTo(metadata.id, { async write(chunk) {
      assert.equal(busy, false); busy = true; maximum = Math.max(maximum, chunk.length);
      await Promise.resolve(); hash.update(chunk); bytes += chunk.length; chunk.fill(111); busy = false;
    } }, { chunkBytes: 65537 });
    assert.equal(maximum, 65537); assert.equal(bytes, metadata.bytes); assert.equal(result.bytesWritten, metadata.bytes);
    assert.equal(result.sha256, expected.sha256); assert.equal(hash.digest("hex"), expected.sha256);
    assert.equal((await hashVolume(metadata.id)).sha256, expected.sha256);
    await assert.rejects(exportVolumeTo(metadata.id, { write() { throw new Error("sink closed"); } }), /sink closed/);
    const reopened = await openVolume(metadata.id); await reopened.close();
  } finally { await deleteVolume(metadata.id); }
});

test("write payload and operation admission budgets reject excess work before copying and recover normally", async () => {
  const metadata = await createVolume({ name: "queue fixture", sizeMiB: 4 }), session = await openVolume(metadata.id);
  try {
    const payload = new Uint8Array(MIB).fill(37), pending: Promise<void>[] = [];
    for (let i = 0; i < 8; i++) pending.push(session.write(MIB, payload));
    await assert.rejects(session.write(MIB, payload), /8 MiB payload budget/);
    payload.fill(99); await Promise.all(pending);
    assert.deepEqual(await session.read(MIB, 1), new Uint8Array([37]));
    assert.equal(session.getStorageStats().peakQueuedWriteBytes, VOLUME_WRITE_QUEUE_BYTES);
    assert.equal(session.getStorageStats().queuedWriteBytes, 0); assert.equal(session.getState().error, null);
    const reads = Array.from({ length: 128 }, () => session.read(0, 0));
    await assert.rejects(session.read(0, 0), /128-request budget/);
    await Promise.all(reads); assert.equal(session.getStorageStats().pendingOperations, 0);
    const closing = session.close(); assert.equal(session.close(), closing); await closing;
  } finally { await session.close(); await deleteVolume(metadata.id); }
});

test("observer-submitted writes cannot overtake the write whose pending state they observed", async () => {
  const metadata = await createVolume({ name: "observer ordering", sizeMiB: 4 }), session = await openVolume(metadata.id);
  let subsequent: Promise<void> | null = null, submitted = false;
  const unsubscribe = session.subscribe((state) => {
    if (state.pendingWrites === 1 && !submitted) { submitted = true; subsequent = session.write(MIB, new Uint8Array([2])); }
  });
  await session.write(MIB, new Uint8Array([1])); await subsequent;
  assert.deepEqual(await session.read(MIB, 1), new Uint8Array([2]));
  unsubscribe(); await session.close(); await deleteVolume(metadata.id);
});

test("a quota exception after the first page aborts every page and latches the session failure", async () => {
  const metadata = await createVolume({ name: "quota fixture", sizeMiB: 4 }), session = await openVolume(metadata.id);
  const offset = 3 * VOLUME_PAGE_BYTES - 5;
  await session.read(offset, 10);
  const put = IDBObjectStore.prototype.put; let writes = 0;
  IDBObjectStore.prototype.put = function(value, key) {
    if (this.name === "pages" && ++writes === 2) throw new DOMException("injected quota", "QuotaExceededError");
    return key === undefined ? put.call(this, value) : put.call(this, value, key);
  };
  try {
    await assert.rejects(session.write(offset, new Uint8Array(10).fill(73)), /quota/);
    assert.deepEqual(session.cachedRead(offset, 10), new Uint8Array(10));
    await assert.rejects(session.flush(), /quota/); await assert.rejects(session.close(), /quota/);
  } finally { IDBObjectStore.prototype.put = put; }
  assert.equal((await getVolume(metadata.id)).revision, 0);
  assert.deepEqual(new Uint8Array((await exportVolume(metadata.id)).buffer, offset, 10), new Uint8Array(10));
  await deleteVolume(metadata.id);
});

test("a native transaction abort does not escape its request handler or publish stale cache data", async () => {
  const metadata = await createVolume({ name: "native abort fixture", sizeMiB: 4 }), session = await openVolume(metadata.id);
  const offset = 3 * VOLUME_PAGE_BYTES - 5; await session.read(offset, 10);
  const put = IDBObjectStore.prototype.put; let writes = 0;
  IDBObjectStore.prototype.put = function(value, key) {
    if (this.name === "pages" && ++writes === 2) { this.transaction.abort(); throw new DOMException("native abort fixture", "AbortError"); }
    return key === undefined ? put.call(this, value) : put.call(this, value, key);
  };
  try {
    await assert.rejects(session.write(offset, new Uint8Array(10).fill(73)), /native abort fixture/);
    assert.deepEqual(session.cachedRead(offset, 10), new Uint8Array(10));
    await assert.rejects(session.close(), /native abort fixture/);
  } finally { IDBObjectStore.prototype.put = put; }
  assert.equal((await getVolume(metadata.id)).revision, 0); await deleteVolume(metadata.id);
});

test("staged copying cleans earlier batches on quota or cancellation and never publishes a partial destination", async () => {
  const metadata = await createVolume({ name: "copy rollback fixture", sizeMiB: 4 });
  const session = await openVolume(metadata.id); await session.write(MIB, new Uint8Array(MIB).fill(87)); await session.close();
  const originals = await count("pages"), add = IDBObjectStore.prototype.add;
  for (const cancelled of [false, true]) {
    const controller = new AbortController(); let copied = 0;
    IDBObjectStore.prototype.add = function(value, key) {
      if (this.name === "pages" && ++copied === 17) {
        if (cancelled) controller.abort();
        else throw new DOMException("copy quota", "QuotaExceededError");
      }
      return key === undefined ? add.call(this, value) : add.call(this, value, key);
    };
    try { await assert.rejects(cloneVolume(metadata.id, { signal: controller.signal }), cancelled ? { name: "AbortError" } : /copy quota/); }
    finally { IDBObjectStore.prototype.add = add; }
    assert.equal(copied, 17); assert.equal(await count("staging"), 0); assert.equal(await count("pages"), originals);
    assert.deepEqual((await listVolumes()).map((entry) => entry.id), [metadata.id]);
  }
  await deleteVolume(metadata.id);
});

test("interrupted-copy recovery removes only unpublished pages in bounded batches and skips active locks", async () => {
  const metadata = await createVolume({ name: "recovery source", sizeMiB: 4 });
  const abandoned = "abandoned-copy", active = "active-copy";
  const stage = (id: string) => ({ version: 1, id, token: crypto.randomUUID(), sourceId: metadata.id, sourceRevision: 0, bytes: metadata.bytes, createdAt: Date.now(), nextIndex: 19 });
  await mutate((tx) => {
    for (const id of [abandoned, active]) {
      tx.objectStore("staging").add(stage(id));
      for (let index = 0; index < 19; index++) tx.objectStore("pages").add({ id, index, data: new Uint8Array(VOLUME_PAGE_BYTES).fill(17) });
    }
  });
  let release!: () => void, granted!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { granted = resolve; });
  const lock = navigator.locks.request(`terrarium-volume:${active}`, { mode: "exclusive" }, async () => { granted(); await hold; });
  await ready;
  try { assert.deepEqual(await recoverVolumeCopies(), { recovered: 1, skippedActive: 1, removedPages: 19 }); }
  finally { release(); await lock; }
  assert.equal(await count("staging"), 1);
  assert.deepEqual(await recoverVolumeCopies(), { recovered: 1, skippedActive: 0, removedPages: 19 });
  assert.equal(await count("staging"), 0); assert.deepEqual(await getVolume(metadata.id), metadata);
  await deleteVolume(metadata.id);
});

test("corrupt inventory, invalid sparse pages and snapshot tampering fail explicitly without rewriting originals", async () => {
  const metadata = await createVolume({ name: "corruption fixture", sizeMiB: 4 });
  await mutate((tx) => tx.objectStore("metadata").put({ id: "corrupt-metadata", bytes: "invalid" }));
  await assert.rejects(listVolumes(), /metadata is corrupt/); assert.equal(await count("metadata"), 2);
  await deleteVolume("corrupt-metadata");
  await mutate((tx) => tx.objectStore("pages").put({ id: metadata.id, index: metadata.bytes / VOLUME_PAGE_BYTES, data: new Uint8Array(VOLUME_PAGE_BYTES) }));
  await assert.rejects(openVolume(metadata.id), /invalid disk page/);
  await assert.rejects(cloneVolume(metadata.id), /invalid disk page/);
  await assert.rejects(exportVolume(metadata.id), /invalid disk page/);
  assert.equal(await count("staging"), 0); assert.deepEqual(await getVolume(metadata.id), metadata);
  await mutate((tx) => tx.objectStore("pages").delete([metadata.id, metadata.bytes / VOLUME_PAGE_BYTES]));
  const snapshot = await snapshotVolume(metadata.id);
  await mutate((tx) => tx.objectStore("pages").put({ id: snapshot.id, index: 3, data: new Uint8Array(VOLUME_PAGE_BYTES).fill(17) }));
  await assert.rejects(openVolume(snapshot.id), /SHA-256 verification/);
  assert.equal((await getVolume(snapshot.id)).sha256, snapshot.sha256);
  await deleteVolume(snapshot.id); await deleteVolume(metadata.id);
});
