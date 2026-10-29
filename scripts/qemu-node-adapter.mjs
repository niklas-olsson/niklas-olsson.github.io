// SPDX-License-Identifier: Apache-2.0
// Real Node worker threads with the WebWorker surface used by QemuRuntime.
import assert from "node:assert/strict";
import { Worker as NodeWorker } from "node:worker_threads";
import { LEGACY_QEMU_BUNDLE_ID } from "../public/runtime/qemu/catalog.js";
import { getQemuBundle } from "../public/runtime/qemu/bundles.js";
import { IO_REQUEST, IO_RESPONSE } from "./qemu-io-diagnostics.mjs";
import { POLL_REQUEST, POLL_RESPONSE, pollExperimentEnable } from "./qemu-poll-diagnostic.mjs";

export function createNodeQemuWorkers({ temporary, manifest, bundleId = LEGACY_QEMU_BUNDLE_ID, workerUrl = "https://terrarium.invalid/runtime/qemu/worker.js" }) {
  getQemuBundle(bundleId);
  const workers = new Set();
  const terminatingWorkers = new Set();
  const ioDiagnostics = process.env.TERRARIUM_QEMU_DIAGNOSTICS === "1";
  const pollExperiment = process.env.TERRARIUM_QEMU_POLL_EXPERIMENT === "1";
  let workerNumber = 0;
  class RealWorker {
    onmessage = null;
    onerror = null;
    stopped = false;
    termination = null;
    guestInputMessages = 0;
    resumeRequests = 0;
    nextObservationId = 1;
    observations = new Map();
    nextPollExperimentId = 1;
    pollObservations = new Map();
    constructor(url, options) {
      assert.equal(String(url), workerUrl);
      assert.equal(options.type, "module");
      this.id = ++workerNumber;
      this.thread = new NodeWorker(new URL("./qemu-node-worker.mjs", import.meta.url), {
        name: `terrarium-qemu-${this.id}`,
        workerData: { id: this.id, temporary, manifest, bundleId, ioDiagnostics, pollExperiment },
      });
      workers.add(this);
      this.thread.on("message", (message) => {
        if (message?.type === IO_RESPONSE) {
          const pending = this.observations.get(message.id);
          // Late, duplicate, and unknown observation IDs never reach the app.
          if (!pending) return;
          this.observations.delete(message.id); clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(String(message.error)));
          else if (message.observation?.schema !== "terrarium.node-io-observation/v1"
            || message.observation.workerId !== this.id || message.observation.runtimeBundleId !== bundleId)
            pending.reject(new Error("The Node I/O observation identity did not match its owning worker."));
          else pending.resolve({ ...message.observation, adapter: {
            postedGuestInputMessages: this.guestInputMessages, resumeRequests: this.resumeRequests,
          } });
          return;
        }
        if (pollExperiment && message?.type === POLL_RESPONSE) {
          const pending = this.pollObservations.get(message.id);
          if (!pending) return;
          this.pollObservations.delete(message.id); clearTimeout(pending.timer);
          if (message.workerId !== this.id || message.runtimeBundleId !== bundleId)
            pending.reject(new Error("The Node poll experiment response identity did not match its owning worker."));
          else if (message.error) pending.reject(new Error(String(message.error)));
          else if (message.observation?.schema !== "terrarium.node-poll-experiment/v1"
            || message.observation.workerId !== this.id || message.observation.runtimeBundleId !== bundleId)
            pending.reject(new Error("The Node poll experiment observation identity did not match its owning worker."));
          else pending.resolve({ ...message.observation, adapter: {
            postedGuestInputMessages: this.guestInputMessages, resumeRequests: this.resumeRequests,
            ioDiagnosticsAlsoEnabled: ioDiagnostics,
          } });
          return;
        }
        if (typeof message?.type === "string" && message.type.startsWith("terrarium-harness:")) return;
        if (message.type === "diagnostic") console.error("QEMU diagnostic:", message.message);
        if (!this.stopped) this.onmessage?.({ data: message });
      });
      this.thread.on("error", (error) => {
        this.rejectObservations(error);
        if (!this.stopped) this.onerror?.({ message: error.message, preventDefault() {} });
      });
      this.thread.on("exit", (code) => {
        this.rejectObservations(new Error(`The QEMU worker exited before replying to the I/O observation (${code}).`));
        if (!this.stopped) {
          const message = `QEMU worker ${this.id} exited unexpectedly (${code}).`;
          console.error(message);
          this.onerror?.({ message, preventDefault() {} });
        }
      });
    }
    rejectObservations(error) {
      for (const pending of this.observations.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.observations.clear();
      for (const pending of this.pollObservations.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pollObservations.clear();
    }
    observePollExperiment(options) {
      if (!pollExperiment) return Promise.reject(new Error("Set TERRARIUM_QEMU_POLL_EXPERIMENT=1 before creating the Node worker adapter."));
      if (this.stopped) return Promise.reject(new Error("A terminated worker cannot provide a poll experiment observation."));
      let enable;
      try { enable = pollExperimentEnable(options); } catch (error) { return Promise.reject(error); }
      if (this.pollObservations.size) return Promise.reject(new Error("Wait for the current Node poll experiment observation."));
      const id = this.nextPollExperimentId++;
      if (!Number.isSafeInteger(id)) return Promise.reject(new Error("Node poll experiment sequence exhausted."));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pollObservations.delete(id);
          reject(new Error("The owning Node JavaScript worker did not reply to the poll experiment within 2 seconds."));
        }, 2_000);
        this.pollObservations.set(id, { resolve, reject, timer });
        try { this.thread.postMessage({ type: POLL_REQUEST, id, workerId: this.id, runtimeBundleId: bundleId, enable }); }
        catch (error) { clearTimeout(timer); this.pollObservations.delete(id); reject(error); }
      });
    }
    observeIo() {
      if (!ioDiagnostics) return Promise.reject(new Error("Set TERRARIUM_QEMU_DIAGNOSTICS=1 before creating the Node worker adapter."));
      if (this.stopped) return Promise.reject(new Error("A terminated worker cannot provide an I/O observation."));
      if (this.observations.size) return Promise.reject(new Error("Wait for the current Node I/O observation."));
      const id = this.nextObservationId++;
      if (!Number.isSafeInteger(id)) return Promise.reject(new Error("Node I/O observation sequence exhausted."));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.observations.delete(id);
          reject(new Error("The owning Node JavaScript worker did not reply to the I/O observation within 2 seconds."));
        }, 2_000);
        this.observations.set(id, { resolve, reject, timer });
        try { this.thread.postMessage({ type: IO_REQUEST, id }); }
        catch (error) { clearTimeout(timer); this.observations.delete(id); reject(error); }
      });
    }
    postMessage(message, transfer = []) {
      assert.equal(this.stopped, false, "A terminated QEMU worker cannot receive messages.");
      if (message.type === "input") this.guestInputMessages++;
      if (message.type === "resume") this.resumeRequests++;
      this.thread.postMessage(message, transfer);
    }
    terminate() {
      if (this.termination) return this.termination;
      this.stopped = true;
      this.rejectObservations(new Error("The owning QEMU worker was terminated before its I/O observation completed."));
      let requested;
      try { requested = this.thread.terminate(); }
      catch (error) { requested = Promise.reject(error); }
      const completed = Promise.resolve(requested).then(() => {
        workers.delete(this);
      }).finally(() => terminatingWorkers.delete(completed));
      this.termination = completed;
      terminatingWorkers.add(completed);
      // Callers may use the browser-style void contract. Retain the rejected
      // result for joinTeardown/awaiting owners without an unhandled rejection.
      void completed.catch(() => undefined);
      return completed;
    }
  }
  async function joinTeardown() {
    // A rejected completed termination is still owned and must not disappear
    // from a later join merely because its first promise already settled.
    const results = await Promise.allSettled([...new Set([...terminatingWorkers, ...[...workers].map(worker => worker.termination).filter(Boolean)])]);
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
  }
  return { Worker: RealWorker, workers, joinTeardown };
}
