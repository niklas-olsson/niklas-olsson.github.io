// SPDX-License-Identifier: Apache-2.0
// QEMU's Ethernet socket terminates here. It never opens a browser socket.

const MAX_FRAME = 65_536;
const encoder = new TextEncoder();

export class EthernetStream {
  constructor(receive) { this.receive = receive; this.pending = new Uint8Array(); }
  push(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length > 262_144 || this.pending.length + bytes.length > 327_680)
      throw new Error("QEMU Ethernet stream exceeded its buffer limit.");
    const joined = new Uint8Array(this.pending.length + bytes.length);
    joined.set(this.pending); joined.set(bytes, this.pending.length);
    let at = 0;
    while (joined.length - at >= 4) {
      const size = new DataView(joined.buffer, joined.byteOffset + at, 4).getUint32(0);
      if (size < 14 || size > MAX_FRAME) throw new Error("QEMU supplied an invalid Ethernet frame length.");
      if (joined.length - at - 4 < size) break;
      this.receive(joined.slice(at + 4, at + 4 + size)); at += 4 + size;
    }
    this.pending = joined.slice(at);
  }
  clear() { this.pending = new Uint8Array(); }
  static frame(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length < 14 || bytes.length > MAX_FRAME) throw new Error("Invalid Ethernet frame length.");
    const result = new Uint8Array(bytes.length + 4);
    new DataView(result.buffer).setUint32(0, bytes.length); result.set(bytes, 4);
    return result;
  }
}

export function createInternalSockets({ onFrame, onError }) {
  let carrier = false;
  let carrierGeneration = 0;
  let network = null;
  let closed = false;
  const stream = new EthernetStream((frame) => { if (carrier && !closed) onFrame(frame); });
  const terminate = (error) => {
    if (closed) return;
    closed = true; carrier = false; carrierGeneration++; stream.clear();
    try {
      if (network && network.readyState !== 3) {
        network.readyState = 3;
        network.emit("close", { code: error ? 1006 : 1000, wasClean: !error });
      }
    } finally { if (error) onError(error); }
  };
  class InternalSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3;
    readyState = 0; binaryType = "arraybuffer"; bufferedAmount = 0;
    listeners = new Map();
    constructor(url) {
      const parsed = new URL(url);
      if (closed || !["ws:", "wss:"].includes(parsed.protocol) || !["127.0.0.1", "localhost"].includes(parsed.hostname) || parsed.port !== "8888" || parsed.username || parsed.password || parsed.hash)
        throw new Error("The QEMU adapter permits only its internal Ethernet channel.");
      if (network) throw new Error("QEMU already has an Ethernet channel.");
      this.url = parsed.href; network = this;
      queueMicrotask(() => { if (!closed && this.readyState === 0) { this.readyState = 1; this.emit("open", {}); } });
    }
    on(type, fn) { const list = this.listeners.get(type) || []; list.push({ fn, node: true }); this.listeners.set(type, list); return this; }
    addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push({ fn, node: false }); this.listeners.set(type, list); }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item.fn !== fn)); }
    emit(type, event) {
      this["on" + type]?.(event);
      for (const item of this.listeners.get(type) || []) {
        if (item.node && type === "message") item.fn(new Uint8Array(event.data), true);
        else item.fn(event);
      }
    }
    send(data) {
      if (closed || this.readyState !== 1) throw new Error("The QEMU Ethernet channel is closed.");
      const bytes = typeof data === "string" ? encoder.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
      try { stream.push(bytes); }
      catch (error) { terminate(error instanceof Error ? error : new Error(String(error))); }
    }
    deliver(bytes) {
      if (closed || this.readyState !== 1 || !carrier) return;
      const copy = new Uint8Array(bytes);
      const generation = carrierGeneration;
      // Emscripten callbacks run outside the current send call. Carrier changes
      // invalidate already queued host deliveries before the guest receives them.
      queueMicrotask(() => { if (!closed && this.readyState === 1 && carrier && generation === carrierGeneration) this.emit("message", { data: copy.buffer }); });
    }
    close() { terminate(new Error("The QEMU Ethernet channel disconnected.")); }
  }
  return {
    Socket: InternalSocket,
    setCarrier(value) { const enabled = !!value && !closed; if (enabled !== carrier) carrierGeneration++; carrier = enabled; },
    receive(frame) {
      if (closed) throw new Error("The QEMU Ethernet channel is closed.");
      if (carrier && network) network.deliver(EthernetStream.frame(frame));
    },
    close() { terminate(); },
  };
}
