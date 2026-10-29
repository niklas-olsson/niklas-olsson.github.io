// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_QEMU_RESOURCE_LIMITS, QEMU_RESOURCE_REQUIREMENTS, QemuResourceBudget } from "./runtime-resources.ts";

test("explicit admission counts reservations, refuses overflow, and releases each lease once", () => {
  const budget = new QemuResourceBudget();
  const first = budget.acquire(), second = budget.acquire();
  assert.deepEqual(budget.getUsage(), { limits: DEFAULT_QEMU_RESOURCE_LIMITS, activeRuntimes: 2, reservedWasmMiB: 4600 });
  assert.throws(() => budget.acquire(), /budget.*full.*2 active\/loading.*4600 MiB/);
  first.release(); first.release();
  assert.equal(budget.getUsage().activeRuntimes, 1);
  const replacement = budget.acquire();
  first.release();
  assert.equal(budget.getUsage().activeRuntimes, 2, "a stale release cannot free a replacement's reservation");
  second.release(); replacement.release();
  assert.equal(budget.getUsage().reservedWasmMiB, 0);
});

test("both the declared runtime count and the Wasm budget must admit a machine", () => {
  const limits = { id: "qualification-fixture", maxActiveRuntimes: 3, maxReservedWasmMiB: 4600 };
  const budget = new QemuResourceBudget(limits);
  limits.maxReservedWasmMiB = 6900;
  const a = budget.acquire(), b = budget.acquire();
  assert.throws(() => budget.acquire(), /budget.*full/);
  assert.equal(budget.getUsage().limits.maxReservedWasmMiB, 4600, "caller mutation cannot loosen a live policy");
  a.release(); b.release();
  const qualified = new QemuResourceBudget({ id: "three-runtime-fixture", maxActiveRuntimes: 3, maxReservedWasmMiB: 6900 });
  const leases = Array.from({ length: 3 }, () => qualified.acquire());
  assert.equal(qualified.getUsage().activeRuntimes, 3, "an explicit injected policy can cover a future qualified host");
  leases.forEach((lease) => lease.release());
});

test("invalid, fractional and unbounded resource policies fail before admission", () => {
  for (const maxActiveRuntimes of [0, -1, 1.5, NaN, Infinity, 17])
    assert.throws(() => new QemuResourceBudget({ ...DEFAULT_QEMU_RESOURCE_LIMITS, maxActiveRuntimes }), /active-runtime budget/);
  for (const maxReservedWasmMiB of [0, 2299, 2300.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    assert.throws(() => new QemuResourceBudget({ ...DEFAULT_QEMU_RESOURCE_LIMITS, maxReservedWasmMiB }), /Wasm budget/);
  for (const id of ["", "has spaces", "x".repeat(97)])
    assert.throws(() => new QemuResourceBudget({ ...DEFAULT_QEMU_RESOURCE_LIMITS, id }), /identifier/);
  assert.equal(QEMU_RESOURCE_REQUIREMENTS.guestMemoryMiB, 512);
  assert.equal(QEMU_RESOURCE_REQUIREMENTS.reservedWasmMiB, 2300);
});

test("mixed preset admission accounts actual Wasm bytes and retains paused reservations", () => {
  const budget = new QemuResourceBudget();
  const server = budget.acquire(3584);
  assert.equal(budget.getUsage().reservedWasmMiB, 3584);
  assert.throws(() => budget.acquire(2300), /budget.*full/);
  assert.throws(() => budget.acquire(0), /bounded Wasm/);
  server.release();
  const small = budget.acquire(2300), worker = budget.acquire(2300);
  assert.equal(budget.getUsage().reservedWasmMiB, 4600);
  small.release(); worker.release(); server.release();
  assert.equal(budget.getUsage().activeRuntimes, 0);
});
