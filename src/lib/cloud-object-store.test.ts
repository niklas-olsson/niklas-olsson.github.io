// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { CloudObjectStore } from "./cloud-object-store.ts";
import { CloudError } from "./cloud-types.ts";
import { acquireResourceReloadGuard, assertNoPendingResourceMutations } from "./resource-events.ts";

const decode = (body: Uint8Array) => new TextDecoder().decode(body);
const isCode = (code: string) => (error: unknown) => error instanceof CloudError && error.code === code;

test("object data and SHA metadata survive a closed and reopened IndexedDB connection", async () => {
  const factory = new IDBFactory(); const store = new CloudObjectStore({ indexedDB: factory });
  await store.buckets.create({ name: "agent-artifacts" });
  const metadata = await store.objects.put("agent-artifacts", "results/hello.txt", "hello", { metadata: { task: "first" } });
  assert.equal(metadata.sha256, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assert.equal(metadata.bytes, 5); assert.equal(metadata.revision, 1);
  await store.close();
  const reopened = new CloudObjectStore({ indexedDB: factory });
  const object = await reopened.objects.get("agent-artifacts", "results/hello.txt");
  assert.equal(decode(object.body), "hello"); assert.deepEqual(object.metadata, { task: "first" });
  assert.deepEqual((await reopened.objects.list("agent-artifacts", { prefix: "results/" })).map((entry) => entry.key), ["results/hello.txt"]);
  assert.deepEqual(await reopened.objects.list("agent-artifacts", { prefix: "other/" }), []);
  await assert.rejects(reopened.buckets.delete("agent-artifacts"), isCode("conflict"));
  assert.equal((await reopened.objects.delete("agent-artifacts", "results/hello.txt")).deleted, true);
  assert.equal((await reopened.objects.delete("agent-artifacts", "results/hello.txt")).deleted, false);
  assert.equal((await reopened.buckets.delete("agent-artifacts")).deleted, true);
  assert.deepEqual(await reopened.buckets.list(), []); await reopened.close();
});

test("put owns an exact byte copy, including typed-array subranges and Node Buffer inputs", async () => {
  const store = new CloudObjectStore({ indexedDB: new IDBFactory() }); await store.buckets.create({ name: "bytes" });
  const source = new Uint8Array([99, 1, 2, 3, 99]); const input = source.subarray(1, 4);
  const pending = store.objects.put("bytes", "array", input); source.fill(0); await pending;
  assert.deepEqual([...(await store.objects.get("bytes", "array")).body], [1, 2, 3]);
  const buffer = Buffer.from("durable"); const bufferPending = store.objects.put("bytes", "buffer", buffer); buffer.fill(0); await bufferPending;
  const result = await store.objects.get("bytes", "buffer"); assert.equal(decode(result.body), "durable"); result.body.fill(0);
  assert.equal(decode((await store.objects.get("bytes", "buffer")).body), "durable"); await store.close();
});

test("concurrent conditional writes are atomic and exactly one revision wins", async () => {
  const store = new CloudObjectStore({ indexedDB: new IDBFactory() }); await store.buckets.create({ name: "atomic" });
  const first = await store.objects.put("atomic", "state", "initial", { ifNoneMatch: true });
  const writes = await Promise.allSettled([
    store.objects.put("atomic", "state", "left", { ifRevision: first.revision }),
    store.objects.put("atomic", "state", "right", { ifRevision: first.revision }),
  ]);
  assert.equal(writes.filter((entry) => entry.status === "fulfilled").length, 1);
  const rejected = writes.find((entry) => entry.status === "rejected"); assert(rejected && rejected.reason instanceof CloudError); assert.equal(rejected.reason.code, "conflict");
  const current = await store.objects.get("atomic", "state"); assert.equal(current.revision, 2); assert(["left", "right"].includes(decode(current.body)));
  await assert.rejects(store.objects.put("atomic", "state", "stale", { ifMatch: first.sha256 }), isCode("conflict"));
  await assert.rejects(store.objects.delete("atomic", "state", { ifRevision: 1 }), isCode("conflict"));
  assert.equal((await store.objects.head("atomic", "state")).sha256, current.sha256);
  const updated = await store.objects.put("atomic", "state", "new", { ifMatch: current.sha256, ifRevision: current.revision }); assert.equal(updated.revision, 3);
  await store.close();
});

test("create-only races cannot overwrite existing bytes or metadata", async () => {
  const factory = new IDBFactory(); const left = new CloudObjectStore({ indexedDB: factory }); const right = new CloudObjectStore({ indexedDB: factory });
  await left.buckets.create({ name: "race" });
  const race = await Promise.allSettled([left.objects.put("race", "one", "a", { ifNoneMatch: true }), right.objects.put("race", "one", "b", { ifNoneMatch: true })]);
  assert.equal(race.filter((entry) => entry.status === "fulfilled").length, 1);
  const current = await right.objects.get("race", "one"); assert.equal(current.revision, 1);
  await assert.rejects(right.objects.put("race", "one", "replacement", { ifNoneMatch: true, metadata: { false: "metadata" } }), isCode("conflict"));
  const after = await left.objects.get("race", "one"); assert.equal(after.sha256, current.sha256); assert.deepEqual(after.metadata, {});
  await left.close(); await right.close();
});

test("SHA verification rejects altered stored bytes instead of returning corrupted content", async () => {
  const factory = new IDBFactory(); const name = "corruption-test"; const store = new CloudObjectStore({ indexedDB: factory, databaseName: name });
  await store.buckets.create({ name: "evidence" }); await store.objects.put("evidence", "sample", "good");
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const opening = factory.open(name); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
  await new Promise<void>((resolve, reject) => { const tx = db.transaction("object-data", "readwrite"); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.objectStore("object-data").put({ bucket: "evidence", key: "sample", body: new TextEncoder().encode("evil").buffer }); });
  db.close(); await assert.rejects(store.objects.get("evidence", "sample"), (error) => isCode("provider_error")(error) && (error as Error).message.includes("SHA-256")); await store.close();
});

test("validation, missing buckets, and unavailable storage fail explicitly", async () => {
  const store = new CloudObjectStore({ indexedDB: new IDBFactory() });
  await assert.rejects(store.buckets.create({ name: "Bad/Name" }), isCode("invalid_argument"));
  await assert.rejects(store.objects.put("missing", "data", "value"), isCode("not_found"));
  await store.buckets.create({ name: "valid" });
  await assert.rejects(store.objects.put("valid", "data", "value", { ifRevision: 0 }), isCode("invalid_argument"));
  await assert.rejects(store.objects.put("valid", "data", "value", { contentType: "text/plain\nInjected" }), isCode("invalid_argument"));
  await assert.rejects(store.objects.get("valid", "absent"), isCode("not_found"));
  await store.close();
  const unavailable = new CloudObjectStore({ indexedDB: { open: () => { throw new DOMException("Storage disabled", "SecurityError"); } } as unknown as IDBFactory });
  await assert.rejects(unavailable.buckets.list(), isCode("storage_unavailable"));
});

test("generation-bound deletes cannot remove a recreated object or empty bucket", async () => {
  const store = new CloudObjectStore({ indexedDB: new IDBFactory() });
  const bucket = await store.buckets.create({ name: "reused" });
  const original = await store.objects.put(bucket.name, "key", "same bytes");
  await store.objects.delete(bucket.name, "key");
  const recreated = await store.objects.put(bucket.name, "key", "same bytes");
  assert.equal(recreated.revision, original.revision); assert.equal(recreated.sha256, original.sha256); assert.notEqual(recreated.generation, original.generation);
  await assert.rejects(store.objects.delete(bucket.name, "key", { ifRevision: original.revision, ifGeneration: original.generation }), isCode("conflict"));
  assert.equal((await store.objects.head(bucket.name, "key")).generation, recreated.generation);
  await store.objects.delete(bucket.name, "key", { ifGeneration: recreated.generation });
  await store.buckets.delete(bucket.name, { ifGeneration: bucket.generation });
  const newBucket = await store.buckets.create({ name: bucket.name }); assert.notEqual(newBucket.generation, bucket.generation);
  await assert.rejects(store.buckets.delete(bucket.name, { ifGeneration: bucket.generation }), isCode("conflict"));
  assert.equal((await store.buckets.get(bucket.name)).generation, newBucket.generation); await store.close();
});

test("post-commit notifications reach other handles in the same database and skip failed writes", async () => {
  const factory = new IDBFactory(); const name = crypto.randomUUID();
  const writer = new CloudObjectStore({ indexedDB: factory, databaseName: name });
  const observer = new CloudObjectStore({ indexedDB: factory, databaseName: name });
  const separate = new CloudObjectStore({ indexedDB: factory, databaseName: name + "-other" });
  const changes: string[] = []; let unrelated = 0;
  const unsubscribe = observer.subscribe((event) => changes.push(`${event.resourceType}:${event.action}:${event.scope ?? ""}:${event.resourceId}`));
  const removeOther = separate.subscribe(() => unrelated++);
  await writer.buckets.create({ name: "artifacts" });
  const first = await writer.objects.put("artifacts", "résultats/a.txt", "first");
  assert.deepEqual(changes, ["bucket:created::artifacts", "object:updated:artifacts:résultats/a.txt"]);
  await assert.rejects(writer.objects.delete("artifacts", "résultats/a.txt", { ifRevision: 2 }), isCode("conflict")); assert.equal(changes.length, 2);
  await writer.objects.delete("artifacts", "résultats/a.txt", { ifRevision: first.revision, ifGeneration: first.generation });
  assert.equal(changes.length, 3); assert.equal(unrelated, 0); assert.deepEqual(await observer.objects.list("artifacts"), []);
  unsubscribe(); removeOther(); await writer.close(); await observer.close(); await separate.close();
});

test("ownership lost while hashing prevents the later object transaction", async () => {
  let writable = true; const store = new CloudObjectStore({ indexedDB: new IDBFactory(), beforeMutation: () => { if (!writable) throw new CloudError("conflict", "Read-only workspace"); } });
  await store.buckets.create({ name: "owned" });
  const write = store.objects.put("owned", "pending", "value"); writable = false;
  await assert.rejects(write, /Read-only workspace/); assert.deepEqual(await store.objects.list("owned"), []); await store.close();
});

test("the shared controlled-reload fence covers bucket and object mutations from hash through commit", async () => {
  const store = new CloudObjectStore({ indexedDB: new IDBFactory() }); await store.buckets.create({ name: "fenced" });
  const pending = store.objects.put("fenced", "data", "saved"); assert.throws(assertNoPendingResourceMutations, /resource changes/); await pending;
  assert.doesNotThrow(assertNoPendingResourceMutations);
  const release = acquireResourceReloadGuard();
  try {
    await assert.rejects(store.objects.put("fenced", "new", "blocked"), /reload/i);
    await assert.rejects(store.buckets.delete("fenced"), /reload/i);
    assert.equal((await store.objects.list("fenced")).length, 1);
  } finally { release(); }
  await store.objects.put("fenced", "new", "accepted after release"); await store.close();
});
