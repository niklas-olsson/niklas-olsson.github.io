// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { acquireResourceReloadGuard, assertNoPendingResourceMutations, beginResourceMutation, publishResourceChange, subscribeResourceChanges, withResourceMutation, type ResourceChange } from "./resource-events.ts";

test("resource notifications tolerate observers and unsubscribe suppresses subsequent callbacks", () => {
  const values: ResourceChange[] = [];
  const throwing = subscribeResourceChanges("volume", () => { throw new Error("view failed"); });
  let detachLater = () => {};
  const first = subscribeResourceChanges("volume", () => detachLater());
  detachLater = subscribeResourceChanges("volume", () => assert.fail("Detached listener must not receive the same dispatch."));
  const receiving = subscribeResourceChanges("volume", (value) => values.push(value));
  try {
    publishResourceChange({ resource: "snapshot", action: "created", id: "other" });
    publishResourceChange({ resource: "volume", action: "created", id: "disk" });
    assert.deepEqual(values, [{ resource: "volume", action: "created", id: "disk" }]);
    assert.equal(Object.isFrozen(values[0]), true);
    receiving();
    publishResourceChange({ resource: "volume", action: "deleted", id: "disk" });
    assert.equal(values.length, 1);
  } finally { throwing(); first(); detachLater(); receiving(); }
});

test("a separate channel invalidates lists while malformed messages cannot select resources", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
  const peer = new BroadcastChannel("terrarium.resource-changes.v1");
  const values: ResourceChange[] = [];
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const delivered = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Cross-context resource notification was not delivered.")), 2_000);
      unsubscribe = subscribeResourceChanges("evidence", (change) => { values.push(change); resolve(); });
    });
    peer.postMessage({ resource: "evidence", action: "wipe", id: "invalid" });
    peer.postMessage({ resource: "evidence", action: "deleted", id: "../invalid" });
    peer.postMessage({ resource: "evidence", action: "deleted", id: "capture" });
    await delivered;
    assert.deepEqual(values, [{ resource: "evidence", action: "deleted", id: "capture" }]);
  } finally {
    clearTimeout(timer); unsubscribe(); peer.close();
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("object database scopes isolate custom stores while preserving Unicode object keys", () => {
  const values: ResourceChange[] = [];
  const subscriptions = [
    subscribeResourceChanges("object", () => assert.fail("Unscoped listener must not receive a custom database event.")),
    subscribeResourceChanges("object", () => assert.fail("Another database must remain separate."), "database-b"),
    subscribeResourceChanges("object", (change) => values.push(change), "database-a"),
  ];
  try {
    publishResourceChange({ resource: "object", action: "updated", id: "bucket/café/report.txt", scope: "database-a" });
    assert.deepEqual(values, [{ resource: "object", action: "updated", id: "bucket/café/report.txt", scope: "database-a" }]);
  } finally { subscriptions.forEach((unsubscribe) => unsubscribe()); }
});

test("safe reload refuses pending work and fences new saves until released", async () => {
  const finish = beginResourceMutation("snapshot");
  assert.throws(assertNoPendingResourceMutations, /saved resource changes/);
  assert.throws(acquireResourceReloadGuard, /saved resource changes/);
  finish(); finish();
  const release = acquireResourceReloadGuard();
  try {
    await assert.rejects(withResourceMutation("evidence", async () => assert.fail("A fenced write must not start.")), /safe reload/);
    assert.throws(acquireResourceReloadGuard, /already/);
  } finally { release(); release(); }
  await assert.rejects(withResourceMutation("volume", async () => { throw new Error("storage failed"); }), /storage failed/);
  assert.doesNotThrow(assertNoPendingResourceMutations);
  assert.equal(await withResourceMutation("volume", async () => 7), 7);
  assert.doesNotThrow(assertNoPendingResourceMutations);
});
