// SPDX-License-Identifier: Apache-2.0
import { LEGACY_QEMU_BUNDLE_ID, getQemuBundle } from "./qemu-assets.ts";

/** Accounting for the pinned small x86_64 runtime, not a host RSS estimate. */
export const QEMU_RESOURCE_REQUIREMENTS = Object.freeze({
  profileId: "alpine-x86_64",
  ...getQemuBundle(LEGACY_QEMU_BUNDLE_ID).resources,
});

export interface QemuResourceLimits {
  /** An identified qualification policy, not a claim about detected hardware. */
  id: string;
  maxActiveRuntimes: number;
  maxReservedWasmMiB: number;
}

export interface QemuResourceUsage {
  readonly limits: Readonly<QemuResourceLimits>;
  readonly activeRuntimes: number;
  readonly reservedWasmMiB: number;
}

export interface QemuResourceLease {
  /** Idempotent. Call only after the owned worker and storage lifecycle end. */
  release(): void;
}

export const DEFAULT_QEMU_RESOURCE_LIMITS: Readonly<QemuResourceLimits> = Object.freeze({
  id: "small-x86_64-two-active-v1",
  maxActiveRuntimes: 2,
  maxReservedWasmMiB: 4600,
});

/**
 * Explicit admission for active/loading x86_64 machines. Idle definitions and
 * legacy backends consume no lease. Wasm accounting excludes JS buffers, disks,
 * checkpoint copies, browser memory and delayed host garbage collection.
 * A boot keeps its lease through pending input reads as well as actual native
 * execution and disk teardown. Custom image components have separate hard size
 * limits; this counter does not relabel their bytes as Wasm or total host RAM.
 *
 * One shared instance serves ordinary page runtimes. An integration host may
 * inject a separately declared policy; doing so does not qualify that capacity.
 */
export class QemuResourceBudget {
  readonly limits: Readonly<QemuResourceLimits>;
  private readonly leases = new Map<symbol, number>();

  constructor(limits: QemuResourceLimits = DEFAULT_QEMU_RESOURCE_LIMITS) {
    if (typeof limits.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(limits.id))
      throw new Error("The x86_64 resource policy needs a bounded, stable identifier.");
    if (!Number.isSafeInteger(limits.maxActiveRuntimes) || limits.maxActiveRuntimes < 1 || limits.maxActiveRuntimes > 16)
      throw new Error("Choose an explicit x86_64 active-runtime budget from 1 to 16.");
    if (!Number.isSafeInteger(limits.maxReservedWasmMiB)
      || limits.maxReservedWasmMiB < QEMU_RESOURCE_REQUIREMENTS.reservedWasmMiB
      || limits.maxReservedWasmMiB > 16 * 4096)
      throw new Error("The x86_64 Wasm budget must cover at least one bounded runtime reservation.");
    this.limits = Object.freeze({ ...limits });
  }

  getUsage(): QemuResourceUsage {
    return Object.freeze({
      limits: this.limits,
      activeRuntimes: this.leases.size,
      reservedWasmMiB: [...this.leases.values()].reduce((sum, reserved) => sum + reserved, 0),
    });
  }

  acquire(reservedWasmMiB: number = QEMU_RESOURCE_REQUIREMENTS.reservedWasmMiB): QemuResourceLease {
    if (!Number.isSafeInteger(reservedWasmMiB) || reservedWasmMiB < QEMU_RESOURCE_REQUIREMENTS.reservedWasmMiB || reservedWasmMiB > 4096)
      throw new Error("The runtime must declare a bounded Wasm reservation from the registered build.");
    const next = this.leases.size + 1;
    const used = this.getUsage().reservedWasmMiB;
    if (next > this.limits.maxActiveRuntimes
      || used + reservedWasmMiB > this.limits.maxReservedWasmMiB)
      throw new Error(
        `The x86_64 resource budget (${this.limits.id}) is full: ${this.leases.size} active/loading machines, `
        + `${used} MiB of accounted Wasm reservation; the requested runtime needs ${reservedWasmMiB} MiB. `
        + "Stop an x86_64 machine and wait for disk teardown before booting or restoring another. "
        + "Paused machines retain their reservation; additional host memory is required.",
      );
    const token = Symbol("x86_64 resource lease");
    this.leases.set(token, reservedWasmMiB);
    return Object.freeze({ release: () => { this.leases.delete(token); } });
  }
}

/** Shared by UI, public API and direct runtimes in this JavaScript realm. */
export const defaultQemuResourceBudget = new QemuResourceBudget();
