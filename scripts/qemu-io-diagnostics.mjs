// SPDX-License-Identifier: Apache-2.0
// Opt-in Node harness observations. No guest contents or replacement I/O behavior.
export const IO_REQUEST = "terrarium-harness:observe-io";
export const IO_RESPONSE = "terrarium-harness:io-observation";

export function createQemuIoObserver({ workerId, bundleId }) {
  const calls = () => ({ calls: 0, bytes: 0, errors: 0, eagain6Errors: 0, specialWait1006Errors: 0,
    lastAt: null, lastBytes: null, lastRequestedBytes: null, lastErrorAt: null, lastErrno: null });
  const state = {
    schema: "terrarium.node-io-observation/v1", workerId, runtimeBundleId: bundleId,
    createdAt: Date.now(), initializedAt: null, countersSaturated: false,
    receivedInput: Array.from({ length: 4 }, (_, port) => ({ port, messages: 0, bytes: 0, lastAt: null })),
    ptyRead: calls(), ptyWrite: calls(),
    ttyRead: { ...calls(), positiveLengthZeroReads: 0 }, ttyPoll: { ...calls(), lastMask: null },
    fd0Read: { ...calls(), positiveLengthZeroReads: 0 }, fd0Poll: { ...calls(), lastMask: null },
  };
  let pty = null, module = null, observedRead = null, observedPoll = null;
  let installed = false;
  const add = (target, key, amount = 1) => {
    if (!Number.isSafeInteger(amount) || amount < 0) return;
    if (target[key] > Number.MAX_SAFE_INTEGER - amount) {
      target[key] = Number.MAX_SAFE_INTEGER; state.countersSaturated = true;
    } else target[key] += amount;
  };
  const bytesOf = value => ArrayBuffer.isView(value) ? value.byteLength
    : value instanceof ArrayBuffer ? value.byteLength : Array.isArray(value) ? value.length : null;
  const failed = (record, error) => {
    add(record, "errors");
    const errno = Number.isSafeInteger(error?.errno) ? error.errno : null;
    record.lastErrno = errno; record.lastErrorAt = Date.now();
    if (errno === 6) add(record, "eagain6Errors");
    if (errno === 1006) add(record, "specialWait1006Errors");
  };
  const isFd0 = (stream) => {
    // Pinned Emscripten FS.createStream assigns an own numeric fd data field.
    // Do not infer stdin from a missing fd or invoke an observational getter.
    try { return Object.getOwnPropertyDescriptor(stream, "fd")?.value === 0; }
    catch { return false; }
  };
  function observeCall(original, record, resultBytes, argumentBytes, { fd0Record, poll = false } = {}) {
    return function (...args) {
      const records = fd0Record && isFd0(args[0]) ? [record, fd0Record] : [record];
      const at = Date.now();
      const requested = argumentBytes?.(args);
      for (const entry of records) {
        add(entry, "calls"); entry.lastAt = at; entry.lastBytes = null;
        entry.lastRequestedBytes = Number.isSafeInteger(requested) && requested >= 0 ? requested : null;
      }
      try {
        const result = Reflect.apply(original, this, args);
        const count = resultBytes ? resultBytes(result) : argumentBytes?.(args);
        for (const entry of records) {
          entry.lastBytes = Number.isSafeInteger(count) && count >= 0 ? count : null;
          if (entry.lastBytes !== null) add(entry, "bytes", entry.lastBytes);
          if (entry.positiveLengthZeroReads !== undefined && entry.lastRequestedBytes > 0 && result === 0)
            add(entry, "positiveLengthZeroReads");
          if (poll) entry.lastMask = Number.isSafeInteger(result) ? result : null;
        }
        return result;
      } catch (error) { for (const entry of records) failed(entry, error); throw error; }
    };
  }
  return {
    received(message) {
      const port = message?.port ?? 0;
      if (message?.type !== "input" || typeof message.text !== "string"
        || !Number.isInteger(port) || port < 0 || port > 3) return;
      const record = state.receivedInput[port];
      add(record, "messages"); add(record, "bytes", Buffer.byteLength(message.text, "utf8")); record.lastAt = Date.now();
    },
    install(options) {
      if (installed) throw new Error("The Node-only I/O observer must be installed once per worker.");
      installed = true;
      pty = options.pty;
      pty.read = observeCall(pty.read, state.ptyRead, bytesOf, args => args[0]);
      pty.write = observeCall(pty.write, state.ptyWrite, null, args => bytesOf(args[0]));
      const initialize = options.onRuntimeInitialized;
      options.onRuntimeInitialized = function (...args) {
        const result = Reflect.apply(initialize, this, args);
        module = this; state.initializedAt = Date.now();
        const operations = this.TTY.stream_ops;
        observedRead = observeCall(operations.read, state.ttyRead, value => value, args => args[3], { fd0Record: state.fd0Read });
        operations.read = observedRead;
        observedPoll = observeCall(operations.poll, state.ttyPoll, null, null, { fd0Record: state.fd0Poll, poll: true });
        operations.poll = observedPoll;
        return result;
      };
      return options;
    },
    snapshot() {
      let readable = null, stdin = null;
      try { if (pty) readable = !!pty.readable; } catch { /* Observation cannot alter I/O failure behavior. */ }
      try {
        const stream = module?.FS.getStream(0);
        stdin = {
          present: !!stream, flags: Number.isSafeInteger(stream?.flags) ? stream.flags : null,
          usesObservedRead: !!stream && stream.stream_ops?.read === observedRead,
          usesObservedPoll: !!stream && stream.stream_ops?.poll === observedPoll,
        };
      } catch { /* An unavailable stream observation stays null. */ }
      return structuredClone({ ...state, sampledAt: Date.now(), ptyReadable: readable, stdin,
        receivedMinusConsumedInputBytes: state.receivedInput[0].bytes - state.ptyRead.bytes,
        limitations: ["Input receipt is not proof of engine admission or guest execution.",
          "TTY read/poll counters aggregate streams; fd0 counters require an own numeric fd=0 data field. Unknown descriptor identities remain aggregate-only.",
          "Positive-length zero reads exclude zero-length calls; they report a read result, not direct observation of QEMU watch removal.",
          "Received-minus-consumed is an accounting delta, not a direct engine queue-length reading.",
          "A responsive observation proves the owning JavaScript worker answered, not that the QEMU C/pthread loop advanced."],
      });
    },
  };
}
