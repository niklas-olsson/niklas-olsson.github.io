// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { CloudOperations } from "./cloud-operations.ts";
import { CloudSimulation } from "./cloud-simulation.ts";
import { CloudError, type CloudEvent } from "./cloud-types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a stable operation awaits its actual callback and deduplicates equivalent retries", async () => {
  const operations = new CloudOperations(); const gate = deferred<{ id: string; value: number }>();
  const events: CloudEvent[] = []; const unsubscribe = operations.subscribe((event) => events.push(event));
  let calls = 0;
  const input = { name: "agent", labels: { b: 2, a: 1 } };
  const original = operations.submit("instances.create", "instance", null, input, ["inventory"], async (request) => {
    calls++; assert.equal(request.name, "agent"); return gate.promise;
  }, { idempotencyKey: "first-worker" });
  input.name = "mutated after submission";
  assert.equal(original.get().status, "queued");
  const duplicate = operations.submit("instances.create", "instance", null, { labels: { a: 1, b: 2 }, name: "agent" }, ["inventory"], async () => { throw new Error("Retry must not run"); }, { idempotencyKey: "first-worker" });
  assert.strictEqual(duplicate, original);
  await tick(); assert.equal(original.get().status, "running"); assert.equal(calls, 1);
  assert.throws(() => operations.submit("instances.create", "instance", null, { name: "changed" }, [], async () => ({}), { idempotencyKey: "first-worker" }), (error) => error instanceof CloudError && error.code === "idempotency_conflict");
  const result = { id: "vm-1", value: 42 }; gate.resolve(result);
  const value = await original.wait(); result.value = 7; value.value = 99;
  assert.deepEqual(await original.wait(), { id: "vm-1", value: 42 });
  assert.equal(original.get().resourceId, "vm-1");
  assert.deepEqual(events.map((event) => event.type), ["operation.queued", "operation.running", "operation.succeeded"]);
  assert.strictEqual(operations.submit("instances.create", "instance", null, { name: "agent", labels: { a: 1, b: 2 } }, [], async () => ({}), { idempotencyKey: "first-worker" }), original);
  unsubscribe();
});

test("resource locks serialize conflicting operations while independent resources progress", async () => {
  const operations = new CloudOperations(); const firstGate = deferred<{ id: string }>(); const order: string[] = [];
  const first = operations.submit("instances.start", "instance", "a", {}, ["instance:a"], async () => { order.push("start-a"); return firstGate.promise; });
  const second = operations.submit("instances.stop", "instance", "a", {}, ["instance:a"], async () => { order.push("stop-a"); return { id: "a" }; });
  const independent = operations.submit("instances.start", "instance", "b", {}, ["instance:b"], async () => { order.push("start-b"); return { id: "b" }; });
  await independent.wait(); assert.deepEqual(order, ["start-a", "start-b"]); assert.equal(second.get().status, "queued");
  firstGate.resolve({ id: "a" }); await first.wait(); await second.wait();
  assert.deepEqual(order, ["start-a", "start-b", "stop-a"]);
});

test("provider failures are retained and do not prevent a later operation on the resource", async () => {
  const operations = new CloudOperations(); operations.subscribe(() => { throw new Error("Observer failure"); });
  const failed = operations.submit("instances.start", "instance", "vm", {}, ["vm"], async () => { throw new Error("Kernel could not boot"); });
  const next = operations.submit("instances.stop", "instance", "vm", {}, ["vm"], async () => ({ id: "vm", status: "idle" }));
  await assert.rejects(failed.wait(), (error) => error instanceof CloudError && error.code === "provider_error" && error.operationId === failed.id);
  assert.equal(failed.get().status, "failed"); assert.equal(failed.get().error?.message, "Kernel could not boot");
  assert.equal((await next.wait()).status, "idle");
});

test("retention bounds histories and makes the idempotency window explicit", async () => {
  const operations = new CloudOperations(); let calls = 0;
  const first = operations.submit("instances.update", "instance", "vm", {}, ["vm"], async () => ({ id: "vm", revision: ++calls }), { idempotencyKey: "oldest" });
  await first.wait();
  for (let index = 0; index < 200; index++) await operations.submit("instances.update", "instance", "vm", { index }, ["vm"], async () => ({ id: "vm", revision: ++calls })).wait();
  assert.equal(operations.list().length, 200); assert.equal(operations.events().length, 500);
  assert.throws(() => operations.get(first.id), /not retained/);
  assert.equal((await first.wait()).revision, 1, "a caller-held handle still has its settled result");
  const acceptedAfterEviction = operations.submit("instances.update", "instance", "vm", {}, ["vm"], async () => ({ id: "vm", revision: ++calls }), { idempotencyKey: "oldest" });
  assert.notEqual(acceptedAfterEviction.id, first.id); await acceptedAfterEviction.wait();
});

test("circular and non-JSON requests fail before dispatch", () => {
  const operations = new CloudOperations(); const circular: { nested?: unknown } = {}; circular.nested = circular;
  for (const input of [circular, { date: new Date() }, { value: NaN }, { value: new Uint8Array(2) }]) {
    assert.throws(() => operations.submit("instances.create", "instance", null, input, [], async () => ({})), (error) => error instanceof CloudError && error.code === "invalid_argument");
  }
});

test("simulated policies enforce explicit deny before the real provider and scope idempotency by identity", async () => {
  const simulation = new CloudSimulation(); const operations = new CloudOperations(simulation.before); let calls = 0;
  simulation.identities.set({ id: "worker", allow: ["instances.*"], deny: ["instances.delete"] });
  const start = operations.submit("instances.start", "instance", "vm", {}, ["vm"], async () => ({ id: "vm", calls: ++calls }), { identity: "worker", idempotencyKey: "worker-start" });
  await start.wait(); assert.equal(calls, 1);
  assert.throws(() => operations.submit("instances.start", "instance", "vm", {}, ["vm"], async () => ({}), { identity: "local", idempotencyKey: "worker-start" }), (error) => error instanceof CloudError && error.code === "idempotency_conflict");
  for (const [action, identity] of [["instances.delete", "worker"], ["volumes.create", "worker"], ["instances.start", "unknown"]]) {
    const denied = operations.submit(action, "instance", "vm", {}, ["vm"], async () => { calls++; return {}; }, { identity });
    await assert.rejects(denied.wait(), (error) => error instanceof CloudError && error.code === "access_denied");
    assert.equal(denied.get().identity, identity);
  }
  assert.equal(calls, 1);
  assert.throws(() => simulation.identities.set({ id: "local", allow: [], deny: ["*"] }), /unrestricted owner/);
});

test("an injected failure is consumed once and a retry returns that failed operation", async () => {
  const simulation = new CloudSimulation(); const operations = new CloudOperations(simulation.before); let calls = 0;
  simulation.faults.next({ action: "instances.start", fail: true, message: "Simulated unavailable service" });
  const work = async () => ({ id: "vm", calls: ++calls });
  const failed = operations.submit("instances.start", "instance", "vm", {}, ["vm"], work, { idempotencyKey: "attempt-one" });
  await assert.rejects(failed.wait(), (error) => error instanceof CloudError && error.code === "injected_failure");
  assert.equal(calls, 0); assert.equal(simulation.faults.list().length, 0);
  assert.strictEqual(operations.submit("instances.start", "instance", "vm", {}, ["vm"], work, { idempotencyKey: "attempt-one" }), failed);
  await operations.submit("instances.start", "instance", "vm", {}, ["vm"], work, { idempotencyKey: "attempt-two" }).wait();
  assert.equal(calls, 1);
});

test("policy revocation during injected latency prevents the provider call", async (context) => {
  // Hold the actual injected timer until revocation has happened. A loaded CI
  // host may not schedule setImmediate before a real 30 ms timer expires.
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const simulation = new CloudSimulation(); const operations = new CloudOperations(simulation.before); let calls = 0;
  simulation.identities.set({ id: "worker", allow: ["instances.start"], deny: [] });
  simulation.faults.next({ action: "instances.start", delayMs: 30 });
  const delayed = operations.submit("instances.start", "instance", "vm", {}, ["vm"], async () => ({ calls: ++calls }), { identity: "worker" });
  await tick(); assert.equal(delayed.get().status, "running"); assert.equal(calls, 0);
  simulation.identities.delete("worker");
  context.mock.timers.tick(30);
  await assert.rejects(delayed.wait(), (error) => error instanceof CloudError && error.code === "access_denied");
  assert.equal(calls, 0);
});
