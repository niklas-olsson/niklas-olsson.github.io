// SPDX-License-Identifier: Apache-2.0
// One TinyEMU instance per dedicated worker. Guest downloads are verified by
// the host; emulated block I/O can only read this worker's in-memory asset map.
"use strict";

const nativeSetTimeout = self.setTimeout.bind(self);
const nativeClearTimeout = self.clearTimeout.bind(self);
const scheduled = new Map();
let nextTimer = 1;
let paused = false;
let started = false;
let initialized = false;
let carrier = false;
let input = [];
let inputOffset = 0;
let inputTimer = null;
let output = "";
let outputTimer = null;
const decoder = new TextDecoder();
const assetOrigin = "https://terrarium.invalid/";
const assets = new Map();

function armTimer(id, timer) {
  timer.due = performance.now() + timer.remaining;
  timer.native = nativeSetTimeout(() => {
    scheduled.delete(id);
    timer.callback(...timer.args);
  }, timer.remaining);
}

// TinyEMU's run loop uses emscripten_async_call, which is a setTimeout here.
// Holding every pending callback pauses CPU execution and device callbacks.
// The worker message loop remains live, so resume/destroy never need a guest.
self.setTimeout = (callback, delay = 0, ...args) => {
  if (typeof callback !== "function")
    throw new Error("String timers are disabled.");
  const id = nextTimer++;
  const timer = {
    callback,
    args,
    remaining: Math.max(0, Number(delay) || 0),
    due: 0,
    native: null,
  };
  scheduled.set(id, timer);
  if (!paused) armTimer(id, timer);
  return id;
};
self.clearTimeout = (id) => {
  const timer = scheduled.get(id);
  if (timer?.native !== null) nativeClearTimeout(timer?.native);
  scheduled.delete(id);
};

function setPaused(value) {
  if (paused === value) return;
  paused = value;
  for (const [id, timer] of scheduled) {
    if (value) {
      nativeClearTimeout(timer.native);
      timer.remaining = Math.max(0, timer.due - performance.now());
      timer.native = null;
    } else {
      armTimer(id, timer);
    }
  }
}

function flushOutput() {
  if (outputTimer !== null) nativeClearTimeout(outputTimer);
  outputTimer = null;
  if (!output) return;
  self.postMessage({ type: "output", data: output });
  output = "";
}

self.term = {
  getSize: () => [100, 30],
  write(bytes) {
    output += decoder.decode(
      Uint8Array.from(bytes, (character) => character.charCodeAt(0)),
      { stream: true },
    );
    if (output.length >= 16_384) flushOutput();
    else if (outputTimer === null)
      outputTimer = nativeSetTimeout(flushOutput, 16);
  },
};
self.update_downloading = () => undefined;
self.net_state = {
  recv_packet(bytes) {
    if (!carrier || bytes.byteLength < 14 || bytes.byteLength > 65_536) return;
    const frame = bytes.slice();
    self.postMessage({ type: "network", frame: frame.buffer }, [frame.buffer]);
  },
};

class MemoryXHR {
  responseType = "arraybuffer";
  status = 0;
  readyState = 0;
  aborted = false;
  timer = null;
  url = "";
  open(method, url) {
    if (method !== "GET")
      throw new Error("The guest asset loader only permits GET.");
    const parsed = new URL(url, assetOrigin);
    if (parsed.origin !== new URL(assetOrigin).origin)
      throw new Error("External guest filesystem requests are disabled.");
    parsed.search = "";
    parsed.hash = "";
    this.url = parsed.href;
  }
  setRequestHeader() {}
  send() {
    this.timer = self.setTimeout(() => {
      if (this.aborted) return;
      const bytes = assets.get(this.url);
      this.status = bytes ? 200 : 404;
      this.readyState = 4;
      if (bytes)
        this.response = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        );
      // The original Emscripten HTTP shim handles unsuccessful status in onload.
      this.onload?.({});
    }, 0);
  }
  abort() {
    this.aborted = true;
    self.clearTimeout(this.timer);
  }
}
self.XMLHttpRequest = MemoryXHR;

function pumpInput() {
  inputTimer = null;
  if (!initialized || paused) return;
  // TinyEMU has a 1,024-byte console FIFO and reads at most 128 bytes per
  // CPU slice. Feed it gradually so long Unicode/init scripts cannot overflow.
  for (let sent = 0; sent < 64 && inputOffset < input.length; sent++) {
    self.Module._console_queue_char(input[inputOffset++]);
  }
  if (inputOffset < input.length) inputTimer = self.setTimeout(pumpInput, 10);
  else {
    input = [];
    inputOffset = 0;
  }
}

function setCarrier(enabled) {
  carrier = !!enabled;
  if (initialized) self.Module._net_set_carrier(carrier ? 1 : 0);
}

async function boot(message) {
  if (started) throw new Error("This worker already owns a machine.");
  started = true;
  const profileId = message.profileId ?? "riscv64";
  const archiveRoot = profileId !== "riscv64";
  if (!["riscv64", "alpine-riscv64", "debian-riscv64"].includes(profileId))
    throw new Error("Unknown TinyEMU guest profile.");
  const memoryMiB = message.memoryMiB ?? 128;
  if (memoryMiB !== 128) throw new Error("Unsupported TinyEMU memory profile.");
  const config = {
    version: 1,
    machine: "riscv64",
    memory_size: memoryMiB,
    bios: "bbl64.bin",
    kernel: "kernel-riscv64.bin",
    ...(archiveRoot
      ? {
          cmdline:
            "console=hvc0 root=root rootfstype=9p rootflags=trans=virtio rw init=/terrarium-init",
          fs0: { file: assetOrigin + "fs" },
        }
      : {
          cmdline: "console=hvc0 root=/dev/vda rw",
          drive0: { file: "disk/blk.txt" },
        }),
    ...(message.network ? { eth0: { driver: "user" } } : {}),
  };
  const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
  assets.set(assetOrigin + "machine.cfg", encode(config));
  assets.set(assetOrigin + "bbl64.bin", new Uint8Array(message.bios));
  assets.set(
    assetOrigin + "kernel-riscv64.bin",
    new Uint8Array(message.kernel),
  );
  if (archiveRoot) {
    importScripts("filesystem.js");
    const filesystem = await self.TerrariumRootfs.fromGzip(
      message.rootfs,
      profileId,
      message.supportRootfs,
    );
    for (const [name, bytes] of filesystem)
      assets.set(assetOrigin + name, bytes);
  } else {
    const disk = new Uint8Array(message.disk);
    if (disk.length !== 4_194_304)
      throw new Error("Unexpected TinyEMU root disk size.");
    assets.set(
      assetOrigin + "disk/blk.txt",
      encode({ block_size: 256, n_block: 16 }),
    );
    for (let block = 0; block < 16; block++) {
      assets.set(
        assetOrigin + `disk/blk${String(block).padStart(9, "0")}.bin`,
        disk.subarray(block * 262_144, (block + 1) * 262_144),
      );
    }
  }
  self.Module = {
    wasmBinary: new Uint8Array(message.wasm),
    print: (text) => self.term.write(String(text) + "\r\n"),
    printErr: (text) => self.term.write(String(text) + "\r\n"),
    onAbort: (reason) =>
      self.postMessage({
        type: "error",
        message: `TinyEMU aborted: ${String(reason).slice(0, 500)}`,
      }),
    preRun: () => {
      self.Module.ccall(
        "vm_start",
        null,
        ["string", "number", "string", "string", "number", "number", "number"],
        [
          assetOrigin + "machine.cfg",
          memoryMiB,
          "",
          null,
          0,
          0,
          message.network ? 1 : 0,
        ],
      );
      initialized = true;
      pumpInput();
      // The virtual NIC is initialized asynchronously after config loading.
      self.setTimeout(() => setCarrier(carrier), 100);
    },
  };
  importScripts("riscvemu64-wasm.js");
}

self.addEventListener("message", async ({ data: message }) => {
  try {
    if (message.type === "boot") await boot(message);
    else if (message.type === "input" && initialized) {
      const bytes = new TextEncoder().encode(message.text);
      if (input.length - inputOffset + bytes.length > 32_768)
        throw new Error("The console input queue is full.");
      // A recovery interrupt cancels input that has not reached the guest yet.
      if (bytes[0] === 3) {
        input = [];
        inputOffset = 0;
      }
      input = input.slice(inputOffset);
      inputOffset = 0;
      for (const byte of bytes) input.push(byte);
      if (inputTimer === null && !paused) pumpInput();
    } else if (message.type === "pause" || message.type === "resume") {
      setPaused(message.type === "pause");
      if (!paused && input.length && inputTimer === null) pumpInput();
      flushOutput();
      self.postMessage({ type: "ack", id: message.id });
    } else if (message.type === "carrier") {
      setCarrier(message.enabled);
    } else if (
      message.type === "network" &&
      initialized &&
      carrier &&
      !paused
    ) {
      const bytes = new Uint8Array(message.frame);
      if (bytes.byteLength < 14 || bytes.byteLength > 65_536) return;
      const pointer = self.Module._malloc(bytes.byteLength);
      if (!pointer)
        throw new Error("TinyEMU could not allocate a network frame.");
      try {
        self.Module.HEAPU8.set(bytes, pointer);
        self.Module._net_write_packet(pointer, bytes.byteLength);
      } finally {
        self.Module._free(pointer);
      }
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

self.addEventListener("error", (event) => {
  self.postMessage({
    type: "error",
    message: event.message || "The RISC-V worker stopped unexpectedly.",
  });
});
