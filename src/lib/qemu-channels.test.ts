// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { createInternalSockets, EthernetStream } from "../../public/runtime/qemu/channels.js";

const tick = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));
const frame = (length = 60, seed = 1): Uint8Array => Uint8Array.from({ length }, (_, index) => (index + seed) & 255);
const join = (...chunks: Uint8Array[]): Uint8Array => {
  const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) { joined.set(chunk, at); at += chunk.length; }
  return joined;
};

test("Ethernet framing handles every split in the header and payload", () => {
  const original = frame();
  const encoded = EthernetStream.frame(original);
  assert.equal(new DataView(encoded.buffer).getUint32(0), original.length);
  for (let split = 1; split < encoded.length; split++) {
    const delivered: Uint8Array[] = [];
    const stream = new EthernetStream((data) => delivered.push(data));
    stream.push(encoded.subarray(0, split));
    assert.equal(delivered.length, 0);
    stream.push(encoded.subarray(split));
    assert.deepEqual(delivered, [original]);
    assert.equal(stream.pending.length, 0);
  }
});

test("Ethernet framing handles combined frames, maximum length and independent byte copies", () => {
  const originals = [frame(14, 1), frame(1514, 2), frame(65_536, 3)];
  const encoded = join(...originals.map(EthernetStream.frame));
  const delivered: Uint8Array[] = [];
  const stream = new EthernetStream((data) => delivered.push(data));
  for (let at = 0; at < encoded.length; at += 997) stream.push(encoded.subarray(at, at + 997));
  assert.deepEqual(delivered, originals);
  encoded.fill(0);
  assert.deepEqual(delivered, originals);
});

test("Ethernet frames and accumulation enforce their bounds and clear removes partial data", () => {
  for (const length of [0, 13, 65_537]) assert.throws(() => EthernetStream.frame(frame(length)), /Invalid Ethernet/);
  for (const length of [0, 13, 65_537, 0xffff_ffff]) {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, length);
    assert.throws(() => new EthernetStream(() => assert.fail("invalid frame delivered")).push(header), /invalid Ethernet/);
  }
  assert.throws(() => new EthernetStream(() => {}).push(new Uint8Array(262_145)), /buffer limit/);
  const delivered: Uint8Array[] = [];
  const stream = new EthernetStream((data) => delivered.push(data));
  stream.push(EthernetStream.frame(frame(65_536)).subarray(0, 65_539));
  assert.throws(() => stream.push(new Uint8Array(262_144)), /buffer limit/);
  stream.clear();
  assert.equal(stream.pending.length, 0);
  stream.push(EthernetStream.frame(frame(14)));
  assert.deepEqual(delivered, [frame(14)]);
});

test("internal sockets cannot connect to external destinations or the removed monitor port", async () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: class { constructor() { assert.fail("A real WebSocket must never be constructed"); } } });
  const channel = createInternalSockets({ onFrame: () => {}, onError: () => {} });
  try {
    for (const url of [
      "wss://example.com:8888/", "ws://192.168.1.1:8888/", "https://localhost:8888/", "ws://localhost:4444/",
      "ws://127.0.0.1:80/", "ws://user:secret@localhost:8888/", "ws://localhost:8888/#outside",
    ]) assert.throws(() => new channel.Socket(url), /only its internal Ethernet/);
    const socket = new channel.Socket("ws://localhost:8888");
    assert.equal(socket.readyState, socket.CONNECTING);
    assert.throws(() => socket.send(EthernetStream.frame(frame())), /closed/);
    await tick();
    assert.equal(socket.readyState, socket.OPEN);
    assert.throws(() => new channel.Socket("ws://127.0.0.1:8888"), /already has/);
    channel.close();
  } finally {
    channel.close();
    if (before) Object.defineProperty(globalThis, "WebSocket", before);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  }
});

test("carrier gates both Ethernet directions and invalidates queued host deliveries", async () => {
  const transmitted: Uint8Array[] = [];
  const received: Uint8Array[] = [];
  const nodeReceived: Uint8Array[] = [];
  const channel = createInternalSockets({ onFrame: (data) => transmitted.push(data), onError: (error) => assert.fail(error.message) });
  const socket = new channel.Socket("ws://127.0.0.1:8888/");
  socket.addEventListener("message", (event) => received.push(new Uint8Array(event.data)));
  socket.on("message", (bytes, binary) => { assert.equal(binary, true); nodeReceived.push(bytes); });
  await tick();
  const packet = frame();
  socket.send(EthernetStream.frame(packet));
  channel.receive(packet);
  await tick();
  assert.equal(transmitted.length, 0);
  assert.equal(received.length, 0);
  channel.setCarrier(true);
  const encoded = EthernetStream.frame(packet);
  socket.send(encoded.subarray(0, 2));
  socket.send(encoded.subarray(2));
  assert.deepEqual(transmitted, [packet]);
  channel.receive(packet);
  channel.setCarrier(false);
  channel.setCarrier(true);
  await tick();
  assert.equal(received.length, 0, "a carrier epoch change drops queued delivery");
  channel.receive(packet);
  await tick();
  assert.deepEqual(received, [encoded]);
  assert.deepEqual(nodeReceived, [encoded]);
  channel.close();
});

test("unexpected closure and invalid framing fail closed once, while owner close is quiet", async () => {
  const failures: Error[] = [];
  const received: unknown[] = [];
  const channel = createInternalSockets({ onFrame: () => {}, onError: (error) => failures.push(error) });
  const socket = new channel.Socket("ws://localhost:8888/");
  socket.onmessage = (event) => received.push(event.data);
  await tick();
  channel.setCarrier(true);
  channel.receive(frame());
  socket.close();
  socket.close();
  await tick();
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /disconnected/);
  assert.equal(socket.readyState, socket.CLOSED);
  assert.equal(received.length, 0);
  assert.throws(() => channel.receive(frame()), /closed/);
  assert.throws(() => socket.send(EthernetStream.frame(frame())), /closed/);
  channel.close();
  assert.equal(failures.length, 1);

  const malformed = createInternalSockets({ onFrame: () => assert.fail("bad data delivered"), onError: (error) => failures.push(error) });
  const badSocket = new malformed.Socket("ws://localhost:8888/");
  await tick();
  badSocket.send(new Uint8Array(4));
  assert.equal(badSocket.readyState, badSocket.CLOSED);
  assert.equal(failures.length, 2);
  malformed.close();
  assert.equal(failures.length, 2);

  const quiet = createInternalSockets({ onFrame: () => {}, onError: () => assert.fail("owner close reported an error") });
  const quietSocket = new quiet.Socket("ws://localhost:8888/");
  let opened = false;
  quietSocket.onopen = () => { opened = true; };
  quiet.close();
  await tick();
  assert.equal(opened, false);
  assert.equal(quietSocket.readyState, quietSocket.CLOSED);
});
