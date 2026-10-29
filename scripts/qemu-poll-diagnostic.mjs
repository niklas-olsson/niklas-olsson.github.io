// SPDX-License-Identifier: Apache-2.0
// Node-harness causal intervention only. Never a production scheduling repair.
export const POLL_REQUEST = "terrarium-harness:poll-experiment";
export const POLL_RESPONSE = "terrarium-harness:poll-experiment-observation";
export const POLL_POLICY = Object.freeze({
  everyEmptyFd0Polls: 16, requestedWaitMs: 1, maxWaits: 1_000,
  maxDurationMs: 10_000, maxObservedPolls: 1_000_000, maxObservations: 64,
});

export function pollExperimentEnable(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options)))
    throw new Error("Poll experiment options must be a plain { enable: boolean } record.");
  const keys = Reflect.ownKeys(options), descriptor = Object.getOwnPropertyDescriptor(options, "enable");
  if (keys.length !== 1 || keys[0] !== "enable" || !descriptor || !("value" in descriptor)
    || typeof descriptor.value !== "boolean")
    throw new Error("Poll experiment accepts only an own boolean enable value.");
  return descriptor.value;
}

export function validatePollExperimentRequest(message, workerId, bundleId) {
  const keys = Reflect.ownKeys(message).sort();
  if (keys.length !== 5 || keys.join(",") !== "enable,id,runtimeBundleId,type,workerId"
    || message.type !== POLL_REQUEST || !Number.isSafeInteger(message.id) || message.id <= 0
    || message.workerId !== workerId || message.runtimeBundleId !== bundleId || typeof message.enable !== "boolean")
    throw new Error("Invalid or mismatched Node poll experiment request.");
  return message.enable;
}

const errorRecord = error => ({ name: String(error?.name ?? "Error").slice(0, 80),
  message: String(error?.message ?? error).slice(0, 512),
  errno: Number.isSafeInteger(error?.errno) ? error.errno : null });
const ownFd0 = stream => {
  try { return Object.getOwnPropertyDescriptor(stream, "fd")?.value === 0; }
  catch { return false; }
};

/** Dependencies are injectable only for fixtures, never through a worker message. */
export function createQemuPollDiagnostic({ workerId, bundleId }, {
  now = Date.now, monotonic = () => performance.now(),
  wait = Atomics.wait, schedule = setTimeout, unschedule = clearTimeout,
} = {}) {
  if (!Number.isSafeInteger(workerId) || workerId <= 0 || typeof bundleId !== "string" || !bundleId || bundleId.length > 200)
    throw new Error("A poll experiment needs its exact owning worker and runtime identity.");
  let installed = false, disposed = false, module = null, pty = null;
  let operations = null, originalPoll = null, wrapper = null, timer = null;
  let began = null, waitWord = null;
  const state = {
    schema: "terrarium.node-poll-experiment/v1", workerId, runtimeBundleId: bundleId,
    createdAt: now(), initializedAt: null, enabled: false, everEnabled: false,
    enabledAt: null, disabledAt: null, disableReason: null, restoredOriginal: null,
    observations: 0, observedPollCalls: 0, eligibleEmptyFd0Polls: 0,
    originalErrors: 0, lastOriginalError: null,
    waits: 0, requestedWaitTotalMs: 0, observedWaitTotalMs: 0, observedWaitMaxMs: 0,
    firstWaitAt: null, lastWaitAt: null, lastWaitResult: null,
    diagnosticError: null,
  };

  function disable(reason) {
    if (timer !== null) { unschedule(timer); timer = null; }
    if (!state.enabled) return;
    state.enabled = false; state.disabledAt = now(); state.disableReason = reason;
    state.restoredOriginal = operations?.poll === wrapper;
    if (state.restoredOriginal) operations.poll = originalPoll;
    // A separately replaced function is not ours to overwrite.
    waitWord = null;
  }

  function sampleProductionPoll() {
    if (!module || !operations || !originalPoll || disposed)
      throw new Error("The real QEMU TTY has not initialized or has already been disposed.");
    const stream = module.FS.getStream(0);
    const expected = state.enabled ? wrapper : originalPoll;
    if (!ownFd0(stream) || stream.stream_ops !== operations || operations.poll !== expected)
      throw new Error("The real fd0 poll owner no longer matches the captured engine operation.");
    let result = null, error = null, readable = null;
    // Invoke the captured production operation once, with its normal receiver
    // and arguments. Do not run the delay wrapper merely to take a sample.
    try { result = Reflect.apply(originalPoll, operations, [stream, -1]); }
    catch (failure) { error = errorRecord(failure); }
    try { readable = !!pty.readable; } catch { /* unavailable remains null */ }
    return { source: "captured-production-fd0-poll", fd: 0, timeoutArgument: -1,
      mask: Number.isSafeInteger(result) ? result : null, error,
      ptyReadable: readable, streamUsesDelayWrapper: state.enabled,
      sampledAt: now(),
      limitation: "One actual TTY poll is a readiness sample, not a guest/CPU progress observation or the whole poll syscall's requested timeout." };
  }

  function enable() {
    if (state.enabled) return; // Repeated enable cannot restart a budget.
    if (state.everEnabled) throw new Error("This worker has already used its one bounded poll intervention.");
    waitWord = new Int32Array(new SharedArrayBuffer(4));
    state.enabled = true; state.everEnabled = true; state.enabledAt = now(); began = monotonic();
    const capturedPoll = originalPoll;
    wrapper = function (...args) {
      const active = state.enabled;
      const fd0 = active && ownFd0(args[0]);
      if (active) state.observedPollCalls++;
      let result;
      try { result = Reflect.apply(capturedPoll, this, args); }
      catch (error) {
        if (active) {
          state.originalErrors++; state.lastOriginalError = errorRecord(error);
          if (state.observedPollCalls >= POLL_POLICY.maxObservedPolls) disable("poll-count-limit");
        }
        throw error; // Keep the exact thrown object, including errno6/1006.
      }
      if (!active || !state.enabled) return result;
      // The installed live engine returns 4 for writable, empty stdin. Do not
      // delay ready input, other descriptors, unknown masks, HUP or errors.
      if (fd0 && result === 4) {
        state.eligibleEmptyFd0Polls++;
        if (state.eligibleEmptyFd0Polls % POLL_POLICY.everyEmptyFd0Polls === 0) {
          const started = monotonic();
          if (started - began >= POLL_POLICY.maxDurationMs) disable("duration-limit");
          else {
            state.waits++; state.requestedWaitTotalMs += POLL_POLICY.requestedWaitMs;
            state.firstWaitAt ??= now(); state.lastWaitAt = now();
            try { state.lastWaitResult = wait(waitWord, 0, 0, POLL_POLICY.requestedWaitMs); }
            catch (error) { state.diagnosticError = errorRecord(error); disable("wait-failed"); }
            const elapsed = Math.max(0, monotonic() - started);
            state.observedWaitTotalMs += elapsed;
            state.observedWaitMaxMs = Math.max(state.observedWaitMaxMs, elapsed);
            if (state.waits >= POLL_POLICY.maxWaits) disable("wait-count-limit");
          }
        }
      }
      if (state.observedPollCalls >= POLL_POLICY.maxObservedPolls) disable("poll-count-limit");
      return result; // The intervention changes timing only, never the mask.
    };
    operations.poll = wrapper;
    try { timer = schedule(() => disable("duration-limit"), POLL_POLICY.maxDurationMs); }
    catch (error) { disable("timer-schedule-failed"); throw error; }
  }

  return {
    install(options) {
      if (installed || disposed) throw new Error("A poll diagnostic must be installed once per worker.");
      installed = true; pty = options.pty;
      const initialize = options.onRuntimeInitialized;
      options.onRuntimeInitialized = function (...args) {
        const result = Reflect.apply(initialize, this, args);
        module = this; operations = this.TTY.stream_ops; originalPoll = operations.poll;
        if (typeof originalPoll !== "function") throw new Error("The engine did not supply its production TTY poll operation.");
        state.initializedAt = now();
        // Keep the exact production poll reference until an explicit request.
        return result;
      };
      return options;
    },
    observe(options) {
      const requested = pollExperimentEnable(options);
      if (state.observations >= POLL_POLICY.maxObservations) throw new Error("Poll experiment observation limit reached.");
      if (!requested) disable("disabled-by-request");
      const readiness = sampleProductionPoll();
      if (requested) {
        if (readiness.error || readiness.mask === null)
          throw new Error("A failed production poll sample cannot enable the timing experiment.");
        enable();
      }
      state.observations++;
      return structuredClone({ ...state, sampledAt: now(), policy: POLL_POLICY, readiness,
        source: "node-harness-empty-fd0-poll-delay", causalIntervention: state.everEnabled,
        limitations: [
          "A diagnostic timing intervention is not a production repair or an unchanged-condition acceptance pass.",
          "No TTY poll wrapper is installed before explicit enable; initialization retains the original operation.",
          "The host-only four-byte SharedArrayBuffer is unrelated to guest memory. No guest input is sent.",
          "Atomics.wait requests 1 ms; observed elapsed time can exceed that timeout because of host scheduling.",
          "Only every 16th empty fd0 mask4 return is delayed. This is not a correct all-FD poll implementation.",
          "Readiness samples call the original operation once and can themselves perturb timing; their timestamps are retained.",
        ],
      });
    },
    dispose() {
      disable("worker-destroy"); disposed = true;
      module = null; pty = null; operations = null; originalPoll = null; wrapper = null; waitWord = null;
    },
  };
}
