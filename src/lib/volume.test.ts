// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import * as workerThreads from "node:worker_threads";
import "fake-indexeddb/auto";
import { createExt2Image } from "./volume-format.ts";
import { createVolume, openVolume, getVolume, exportVolume, snapshotVolume, cloneVolume, deleteVolume, listVolumes, registerVolumeDeletionGuard, subscribeVolumeChanges } from "./volume-store.ts";
import { validateVolumeAttachments, VOLUME_PAGE_BYTES } from "./volume-types.ts";

// Node 24 supplies the real Web Locks implementation. On older supported Node
// versions this narrow fallback models lock contention, not browser storage.
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

test("empty ext2 images are deterministic, bounded and contain a valid root layout", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  const image = createExt2Image(4, id), view = new DataView(image);
  assert.deepEqual(new Uint8Array(image), new Uint8Array(createExt2Image(4, id)));
  assert.equal(view.getUint16(1024 + 0x38, true), 0xef53);
  assert.equal(view.getUint32(1024 + 4, true), 1024);
  assert.equal(view.getUint16(4 * 4096 + 128, true), 0x41ed);
  assert.throws(() => createExt2Image(129, id), /128/);
  assert.throws(() => createExt2Image(4, "invalid"), /UUID/);
  assert.deepEqual(validateVolumeAttachments([{ id: "disk", slot: 1 }]), [{ id: "disk", slot: 1, readOnly: false }]);
  assert.throws(() => validateVolumeAttachments([{ id: "a", slot: 0 }, { id: "b", slot: 0 }]), /already/);
});

test("committed multi-page writes survive closing and reopening the IndexedDB image", async () => {
  const meta = await createVolume({ name: "durability", sizeMiB: 4 });
  const session = await openVolume(meta.id);
  const offset = VOLUME_PAGE_BYTES * 2 - 10;
  const payload = Uint8Array.from({ length: 40 }, (_, i) => i + 1);
  await session.write(offset, payload);
  await session.write(offset + 1, new Uint8Array([222]));
  payload[1] = 222;
  assert.deepEqual(await session.read(offset, 40), payload);
  await session.close();
  const reopened = await openVolume(meta.id);
  assert.deepEqual(await reopened.read(offset, 40), payload);
  assert.equal(reopened.getMetadata().revision, 2);
  const exposed = reopened.cachedRead(offset, 40); exposed.fill(0);
  assert.deepEqual(await reopened.read(offset, 40), payload);
  await reopened.close();
  assert.equal((await listVolumes()).some((volume) => volume.id === meta.id), true);
  await deleteVolume(meta.id);
});

test("attachment locks exclude a second writer, mutation, export and live snapshots", async () => {
  const meta = await createVolume({ name: "locked", sizeMiB: 4 });
  const session = await openVolume(meta.id);
  await assert.rejects(openVolume(meta.id), /attached|use/);
  await assert.rejects(snapshotVolume(meta.id, { name: "unsafe" }), /attached|use/);
  await assert.rejects(cloneVolume(meta.id, { name: "unsafe" }), /attached|use/);
  await assert.rejects(exportVolume(meta.id), /attached|use/);
  await assert.rejects(deleteVolume(meta.id), /attached|use/);
  await session.close();
  await deleteVolume(meta.id);
});

test("immutable snapshots and independent clones preserve original bytes and hashes", async () => {
  const meta = await createVolume({ name: "source", sizeMiB: 4 });
  const original = await openVolume(meta.id);
  const offset = VOLUME_PAGE_BYTES * 2;
  await original.write(offset, new Uint8Array([10, 20, 30])); await original.close();
  const preserved = await snapshotVolume(meta.id, { name: "preserved" });
  const exported = await exportVolume(preserved.id);
  assert.equal(exported.sha256, preserved.sha256);
  const clone = await cloneVolume(preserved.id, { name: "analysis copy" });
  const writable = await openVolume(clone.id);
  await writable.write(offset, new Uint8Array([99])); await writable.close();
  const readonly = await openVolume(preserved.id, { readOnly: false });
  assert.equal(readonly.readOnly, true);
  await assert.rejects(readonly.write(offset, new Uint8Array([77])), /write protection/);
  assert.deepEqual(await readonly.read(offset, 3), new Uint8Array([10, 20, 30]));
  await readonly.close();
  assert.equal((await exportVolume(preserved.id)).sha256, preserved.sha256);
  for (const id of [meta.id, preserved.id, clone.id]) await deleteVolume(id);
});

test("revision conflicts abort atomically and never expose an uncommitted write", async () => {
  const meta = await createVolume({ name: "conflict", sizeMiB: 4 });
  const session = await openVolume(meta.id);
  const offset = VOLUME_PAGE_BYTES * 3;
  await session.read(offset, 1); // Preserve a known committed cache page for the negative write check.
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("terrarium-volumes-v1");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("metadata", "readwrite");
    tx.objectStore("metadata").put({ ...meta, revision: 100 });
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
  db.close();
  await assert.rejects(session.write(offset, new Uint8Array([123])), /stale write/);
  assert.equal(session.cachedRead(offset, 1)[0], 0);
  await assert.rejects(session.flush(), /stale write/);
  await assert.rejects(session.close(), /stale write/);
  assert.equal((await getVolume(meta.id)).revision, 100);
  assert.equal(new Uint8Array((await exportVolume(meta.id)).buffer)[offset], 0);
  await deleteVolume(meta.id);
});

test("conditional deletion preserves changed disks and releases dependency leases on success and failure", async () => {
  const events: string[] = [];
  const unsubscribe = subscribeVolumeChanges((change) => events.push(`${change.action}:${change.id}`));
  const meta = await createVolume({ name: "reviewed disk", sizeMiB: 4 });
  let held = false;
  let releases = 0;
  const removeGuard = registerVolumeDeletionGuard((id) => {
    assert.equal(id, meta.id);
    assert.equal(held, false);
    held = true;
    return () => { held = false; releases++; };
  });
  try {
    const session = await openVolume(meta.id);
    await session.write(VOLUME_PAGE_BYTES * 2, new Uint8Array([42]));
    await assert.rejects(deleteVolume(meta.id), /attached|use/);
    assert.equal(held, false);
    await session.close();
    await assert.rejects(deleteVolume(meta.id, { ifRevision: meta.revision }), /changed since deletion/);
    assert.equal(held, false);
    assert.equal((await getVolume(meta.id)).revision, 1);
    assert.deepEqual(events, [`created:${meta.id}`]);
    const deny = registerVolumeDeletionGuard(() => { throw new Error("A stopped machine still references this volume."); });
    try { await assert.rejects(deleteVolume(meta.id), /still references/); }
    finally { deny(); }
    assert.equal(held, false);
    await deleteVolume(meta.id, { ifRevision: 1 });
    assert.equal(held, false);
    assert.equal(releases, 4);
    assert.deepEqual(events, [`created:${meta.id}`, `deleted:${meta.id}`]);
    await assert.rejects(getVolume(meta.id), /not found/);
    await deleteVolume(meta.id); // An idempotent no-op does not emit a false change.
    assert.equal(events.length, 2);
  } finally { removeGuard(); unsubscribe(); await deleteVolume(meta.id); }
});

test("all read-only attachments block deletion and snapshot digests condition the eventual delete", async () => {
  const meta = await createVolume({ name: "evidence origin", sizeMiB: 4 });
  const snapshot = await snapshotVolume(meta.id, { name: "preserved disk" });
  const left = await openVolume(snapshot.id), right = await openVolume(snapshot.id);
  try {
    await assert.rejects(deleteVolume(snapshot.id, { ifSha256: snapshot.sha256! }), /attached|use/);
    await left.close();
    await assert.rejects(deleteVolume(snapshot.id), /attached|use/);
    await right.close();
    await assert.rejects(deleteVolume(snapshot.id, { ifSha256: "0".repeat(64) }), /changed since deletion/);
    assert.equal((await exportVolume(snapshot.id)).sha256, snapshot.sha256);
    await deleteVolume(snapshot.id, { ifSha256: snapshot.sha256! });
    await assert.rejects(getVolume(snapshot.id), /not found/);
  } finally { await left.close(); await right.close(); await deleteVolume(snapshot.id); await deleteVolume(meta.id); }
});
