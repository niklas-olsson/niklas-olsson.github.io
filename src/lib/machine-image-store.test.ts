// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import { deleteMachineImage, exportMachineImage, getMachineImage, importMachineImage, listMachineImages,
  readMachineImage, subscribeMachineImageChanges, withMachineImageLease } from "./machine-image-store.ts";
import { fixtureImage } from "./machine-image.test-fixtures.ts";
import { assertNoPendingResourceMutations } from "./resource-events.ts";

const options = () => ({ databaseName: `terrarium-image-fixture-${crypto.randomUUID()}` });
async function mutate(databaseName: string, store: "metadata" | "bundles", id: string, change: (value: unknown) => unknown) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite"); const objectStore = tx.objectStore(store); const read = objectStore.get(id);
      read.onsuccess = () => { const next = change(read.result); if (store === "metadata") objectStore.put(next); else objectStore.put(next, id); };
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

test("immutable atomic image import/read/export and dependency-aware deletion (fake IDB fixture, not browser storage)", async () => {
  const opts = options(); const image = await fixtureImage(); const events: string[] = [];
  const unsubscribe = subscribeMachineImageChanges((event) => events.push(event.action), opts);
  try {
    const pending = importMachineImage(image.blob, opts);
    assert.throws(assertNoPendingResourceMutations, /image/);
    const meta = await pending;
    assert.doesNotThrow(assertNoPendingResourceMutations);
    assert.equal(meta.id, image.id); assert.deepEqual(events, ["created"]);
    assert.equal((await listMachineImages(opts)).length, 1);
    assert.equal((await getMachineImage(meta.id, opts))?.manifest.guest.identity, image.manifest.guest.identity);
    assert.equal((await readMachineImage(meta.id, opts)).id, meta.id);
    assert.equal((await exportMachineImage(meta.id, opts)).size, image.blob.size);
    await assert.rejects(importMachineImage(image.blob, opts), /already saved/);
    await assert.rejects(deleteMachineImage(meta.id, { ...opts, assertUnreferenced: () => { throw new Error("Image belongs to configured machine."); } }), /configured machine/);
    await assert.rejects(deleteMachineImage(meta.id, { ...opts, ifSha256: "0".repeat(64), assertUnreferenced: () => {} }), /identity changed/);
    assert.deepEqual(events, ["created"]);
    await deleteMachineImage(meta.id, { ...opts, ifSha256: meta.id, assertUnreferenced: () => {} });
    assert.deepEqual(await listMachineImages(opts), []); assert.deepEqual(events, ["created", "deleted"]);
    assert.equal(await getMachineImage(meta.id, opts), null);
  } finally { unsubscribe(); }
});

test("failed validation and cancellation leave stored machine images and notifications unchanged", async () => {
  const opts = options(); const image = await fixtureImage(); const existing = await importMachineImage(image.blob, opts);
  const events: string[] = []; const unsubscribe = subscribeMachineImageChanges((event) => events.push(event.action), opts);
  try {
    const corrupt = new Blob([image.blob.slice(0, image.blob.size - 1), new Uint8Array([1])]);
    await assert.rejects(importMachineImage(corrupt, opts), /SHA-256/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(importMachineImage(image.blob, { ...opts, signal: controller.signal }), { name: "AbortError" });
    assert.deepEqual(events, []); assert.equal((await readMachineImage(existing.id, opts)).id, existing.id);
    assert.doesNotThrow(assertNoPendingResourceMutations);
  } finally { unsubscribe(); }
});

test("corrupted stored payload or identity is quarantined before boot", async () => {
  const opts = options(); const image = await fixtureImage(); const saved = await importMachineImage(image.blob, opts);
  await mutate(opts.databaseName, "bundles", saved.id, () => new Blob([image.blob.slice(0, image.blob.size - 1), new Uint8Array([1])]));
  await assert.rejects(readMachineImage(saved.id, opts), /SHA-256/);
  await mutate(opts.databaseName, "metadata", saved.id, (value) => ({ ...(value as object), name: "injected label" }));
  await assert.rejects(listMachineImages(opts), /quarantined/);
  await assert.rejects(getMachineImage(saved.id, opts), /quarantined/);
});

test("a shared assignment lease prevents deletion from checking dependencies before the new definition commits", async () => {
  const opts = options(); const image = await fixtureImage(); await importMachineImage(image.blob, opts);
  let release!: () => void; let acquired!: () => void; let definitionCommitted = false;
  const ready = new Promise<void>((resolve) => { acquired = resolve; });
  const held = withMachineImageLease(image.id, async () => {
    acquired(); await new Promise<void>((resolve) => { release = resolve; }); definitionCommitted = true;
  }, opts);
  await ready;
  let checked = false;
  const deleting = deleteMachineImage(image.id, { ...opts, assertUnreferenced: () => {
    checked = true; assert.equal(definitionCommitted, true); throw new Error("New definition references image.");
  } });
  await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(checked, false);
  release(); await held; await assert.rejects(deleting, /New definition references/);
  assert.equal((await readMachineImage(image.id, opts)).id, image.id);
});

test("a payload write failure rolls metadata back and emits no successful-save notification", async () => {
  const opts = options(); const image = await fixtureImage(); const events: string[] = [];
  const unsubscribe = subscribeMachineImageChanges((event) => events.push(event.action), opts);
  const original = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function (value, key) {
    if (this.name === "bundles") throw new DOMException("Injected storage quota failure", "QuotaExceededError");
    return original.call(this, value, key);
  };
  try {
    await assert.rejects(importMachineImage(image.blob, opts), /Injected storage quota failure/);
    assert.deepEqual(await listMachineImages(opts), []);
    assert.deepEqual(events, []);
    assert.doesNotThrow(assertNoPendingResourceMutations);
  } finally { IDBObjectStore.prototype.add = original; unsubscribe(); }
  assert.equal((await importMachineImage(image.blob, opts)).id, image.id);
});

test("missing cross-tab lock support fails closed before saved images or dependencies can change", async () => {
  const opts = options(); const image = await fixtureImage();
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
  try {
    await assert.rejects(importMachineImage(image.blob, opts), /Web Locks/);
    await assert.rejects(withMachineImageLease(image.id, async () => {}, opts), /Web Locks/);
    assert.deepEqual(await listMachineImages(opts), []);
  } finally {
    if (descriptor) Object.defineProperty(navigator, "locks", descriptor);
    else Reflect.deleteProperty(navigator, "locks");
  }
});
