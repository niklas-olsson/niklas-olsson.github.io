// SPDX-License-Identifier: Apache-2.0
// Node smoke-harness diagnosis only. No product method or deadline is changed.
import { createHash } from "node:crypto";

const errorRecord = error => ({ name: String(error?.name ?? "Error").slice(0, 128),
  message: String(error?.message ?? error).slice(0, 4096), code: error?.code ?? null });
const workerRecord = worker => ({ adapterId: worker.id, nodeThreadId: worker.thread?.threadId ?? null,
  stopped: worker.stopped === true, postedGuestInputMessages: worker.guestInputMessages ?? null });

/**
 * The caller imports/creates this object only under the explicit diagnostic flag.
 * The original startup method rejects before its boot catch terminates the worker.
 * Interpose at that rejection, capture once, then rethrow the identical failure.
 * These TypeScript-private properties are used only by the identified Node smoke
 * harness, not as an application API. A changed shape is a diagnostic error.
 */
export function createFailureStackCapture({ workers, bundleId, deadlineAt,
  emit = value => console.error(JSON.stringify(value)),
  capture = async options => (await import("./qemu-thread-stacks.mjs")).captureNodeWorkerStacks(options),
}) {
  if (!(workers instanceof Set) || typeof bundleId !== "string" || !bundleId
    || !Number.isFinite(deadlineAt) || typeof emit !== "function" || typeof capture !== "function")
    throw new Error("Failure-stack diagnosis needs an owned worker set, bundle ID and original monotonic smoke deadline.");
  const began = performance.now();
  let requested = false, pending = null, final = null;
  const write = record => emit({ type: "S1_FAILURE_STACK_CAPTURE", elapsedMs: Math.round(performance.now() - began),
    acceptanceEligible: false, ...record });
  emit({ type: "S1_FAILURE_STACK_MODE", enabled: true, acceptanceEligible: false,
    captureRequested: false, runtimeBundleId: bundleId, originalSmokeRemainingMs: Math.max(0, Math.floor(deadlineAt - began)),
    trigger: "Original startup rejection before boot teardown, or the original full-smoke failure boundary.",
    diagnosticMaxCaptureMs: 8000, originalBootMs: 240000, originalSetupMs: 60000,
    originalSmokeWatchdogChanged: false,
    limitations: [
      "Intrusive diagnostic invocation, never an unchanged-condition acceptance pass, even if no capture is requested.",
      "No inspector attaches, worker observation messages or poll interventions occur before an original failure boundary.",
      "A startup failure keeps its existing runtime, disk and network ownership until the original boot catch runs after this bounded capture.",
      "The unchanged overall smoke watchdog can interrupt capture. A killed run or missing result remains incomplete.",
    ] });

  async function captureFailure({ runtime, worker = runtime?.worker, error, reason, startup = null }) {
    if (requested) { if (pending) await pending; return final; }
    requested = true;
    // Mark once before any await. Normal boot cleanup cannot race this rejection
    // wrapper, but another process-wide error may still request the same capture.
    pending = (async () => {
      const snapshot = runtime?.getSnapshot?.();
      const owners = [...workers].filter(value => !value.stopped);
      const remainingMs = Math.max(0, Math.floor(deadlineAt - performance.now()));
      const common = { captureRequested: true, reason, originalFailure: errorRecord(error), runtimeBundleId: bundleId,
        runtime: snapshot ? { status: snapshot.status, controlReady: snapshot.controlReady,
          message: snapshot.message, runtimeBundle: snapshot.runtimeBundle } : null,
        originalSmokeRemainingMs: remainingMs, owners: owners.map(workerRecord),
        capturedGeneration: startup?.generation ?? runtime?.generation ?? null,
        currentGeneration: runtime?.generation ?? null,
        expectedOwner: worker ? workerRecord(worker) : null, startup,
        scope: {
          kind: "all inspector-visible workers in this single-QEMU-owner smoke process",
          ownerIdentityCheck: "Exact adapter object is still runtime.worker and the sole live owner in the supplied worker set.",
          inspectorIdsAreNodeThreadIds: false,
          limitation: "The Node inspector discovers nested pthreads independently. Its returned worker/session IDs are recorded as-is; no identity is inferred from threadId or titles. An unrelated inspector-visible worker would also be included and must be reported from discoveredWorkers.",
        } };
      write({ ...common, status: "requested" });
      // Never hold or inspect a replacement owner or a concurrent second guest.
      if (!worker || worker !== runtime?.worker || worker.stopped || !workers.has(worker)
        || (startup !== null && startup.generation !== runtime?.generation)
        || owners.length !== 1 || owners[0] !== worker) {
        final = { ...common, status: "not-captured-owner-unavailable", observation: null };
      } else if (remainingMs < 750) {
        final = { ...common, status: "not-captured-smoke-deadline", observation: null };
      } else {
        const timeoutMs = Math.min(8000, remainingMs - 250);
        try {
          const observation = await capture({ timeoutMs, maxWorkers: 8, maxFrames: 24 });
          final = { ...common, status: observation?.completed ? "captured" : "partial-or-unavailable",
            requestedCaptureMs: timeoutMs, observation };
        } catch (failure) {
          final = { ...common, status: "capture-threw", requestedCaptureMs: timeoutMs,
            diagnosticError: errorRecord(failure), observation: null };
        }
      }
      write({ ...final, smokeDeadlineExceeded: performance.now() >= deadlineAt });
      return final;
    })().catch(failure => {
      // A diagnostic/logging failure must not replace the actual guest failure.
      final = { captureRequested: true, status: "diagnostic-harness-error", error: errorRecord(failure), acceptanceEligible: false };
      try { write(final); } catch { /* The original failure remains authoritative. */ }
      return final;
    });
    return pending;
  }

  function instrumentStartup(runtime, label) {
    const original = runtime?.runStartupCommand;
    if (typeof original !== "function") throw new Error("The Node diagnostic cannot find the expected QemuRuntime startup method.");
    const descriptor = Object.getOwnPropertyDescriptor(runtime, "runStartupCommand");
    let ordinal = 0;
    const wrapped = async function (...args) {
      const invocation = ++ordinal, started = performance.now();
      try { return await Reflect.apply(original, this, args); }
      catch (error) {
        const [command, generation, worker] = args;
        await captureFailure({ runtime: this, worker, error, reason: "original-startup-command-rejection", startup: {
          label, invocation, generation, durationBeforeCaptureMs: Math.round(performance.now() - started),
          commandBytes: typeof command === "string" ? Buffer.byteLength(command) : null,
          commandSha256: typeof command === "string" ? createHash("sha256").update(command).digest("hex") : null,
        } });
        throw error;
      }
    };
    Object.defineProperty(runtime, "runStartupCommand", { configurable: true, writable: true, value: wrapped });
    return () => {
      if (runtime.runStartupCommand !== wrapped) return;
      if (descriptor) Object.defineProperty(runtime, "runStartupCommand", descriptor);
      else delete runtime.runStartupCommand;
    };
  }

  return { instrumentStartup, captureFailure,
    reportComplete() { emit({ type: "S1_FAILURE_STACK_MODE_COMPLETE", enabled: true, acceptanceEligible: false,
      captureRequested: requested, status: final?.status ?? "not-requested", ownedWorkersRemaining: workers.size,
      originalSmokeDeadlineExceeded: performance.now() >= deadlineAt }); },
  };
}
