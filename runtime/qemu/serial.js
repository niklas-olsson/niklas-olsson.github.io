// SPDX-License-Identifier: Apache-2.0

const MAX_INPUT_BYTES = 65_536;
const MAX_SEND_BYTES = 32_768;
const MAX_OUTPUT_CHUNK_BYTES = 65_536;

/** Three host-owned UART pipes. No guest text is interpreted as emulator control. */
export function createSerialPipes({ onOutput }) {
  const encoder = new TextEncoder();
  let closed = false, installed = false;
  const ports = new Map([1, 2, 3].map((port) => [port, {
    input: new Uint8Array(), output: "", timer: null, decoder: new TextDecoder(),
  }]));
  const flush = (port, state) => {
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    if (state.output) { const text = state.output; state.output = ""; onOutput(port, text); }
  };
  return {
    install(FS) {
      if (closed || installed) throw new Error("Serial pipes cannot be installed again.");
      installed = true;
      FS.mkdirTree("/serial");
      for (const [port, state] of ports) {
        const device = FS.makedev(82, port);
        FS.registerDevice(device, {
          open(stream) { stream.seekable = false; },
          close() {},
          read(_stream, buffer, offset, length) {
            if (!length || closed) return 0;
            if (!state.input.length) throw new FS.ErrnoError(6);
            const count = Math.min(length, state.input.length);
            buffer.set(state.input.subarray(0, count), offset);
            state.input = state.input.slice(count);
            return count;
          },
          write(_stream, buffer, offset, length) {
            if (closed) throw new FS.ErrnoError(29);
            // QEMU writes from shared Wasm memory. Browser TextDecoder requires
            // ordinary bytes; copy only a bounded slice and retain UTF-8 state.
            for (let at = offset; at < offset + length; at += MAX_OUTPUT_CHUNK_BYTES) {
              const bytes = new Uint8Array(buffer.subarray(at, Math.min(at + MAX_OUTPUT_CHUNK_BYTES, offset + length)));
              state.output += state.decoder.decode(bytes, { stream: true });
              if (state.output.length >= 16_384) flush(port, state);
              else if (state.timer === null) state.timer = setTimeout(() => flush(port, state), 16);
            }
            return length;
          },
          poll() { return closed ? 16 : (state.input.length ? 1 : 0) | 4; },
          llseek() { throw new FS.ErrnoError(70); },
        });
        FS.mkdev(`/serial/ttyS${port}.in`, 0o600, device);
        FS.mkdev(`/serial/ttyS${port}.out`, 0o600, device);
      }
    },
    input(port, text) {
      if (!ports.has(port) || typeof text !== "string") throw new Error("Invalid interactive UART input.");
      if (closed) return;
      const state = ports.get(port), bytes = encoder.encode(text);
      if (bytes.length > MAX_SEND_BYTES || state.input.length + bytes.length > MAX_INPUT_BYTES)
        throw new Error("The x86_64 terminal input queue is full.");
      const joined = new Uint8Array(state.input.length + bytes.length);
      joined.set(state.input); joined.set(bytes, state.input.length); state.input = joined;
    },
    clear() {
      for (const [port, state] of ports) { state.input = new Uint8Array(); flush(port, state); }
    },
    close() {
      if (closed) return;
      closed = true;
      for (const [port, state] of ports) {
        state.input = new Uint8Array();
        state.output += state.decoder.decode();
        flush(port, state);
      }
    },
  };
}
