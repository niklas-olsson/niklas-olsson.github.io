// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import type { V86 } from "v86";
import {
  VirtualNetwork,
  guestNetworkScript,
  publicWebUrl,
  validateRelayUrl,
} from "./network.ts";
import {
  AdapterBus,
  RelayDns,
  routeRelayHostnames,
  type AdapterFactories,
  type NetworkAdapter,
} from "./network-transport.ts";

class TestAdapter implements NetworkAdapter {
  static instances: TestAdapter[] = [];
  sent: Uint8Array[] = [];
  tcp_conn = {};
  vm_mac = new Uint8Array(6);
  destroyed = false;
  constructor() {
    TestAdapter.instances.push(this);
  }
  send(frame: Uint8Array) {
    this.sent.push(frame);
  }
  receive(_frame: Uint8Array) {}
  fetch = async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response("unwrapped");
  destroy() {
    this.destroyed = true;
  }
}
globalThis.TerrariumNetworkAdapters = {
  Fetch: TestAdapter,
  Wisp: TestAdapter,
} as unknown as AdapterFactories;
const backend = () => TestAdapter.instances.at(-1)!;

function endpoint() {
  const received: Uint8Array[] = [];
  const listeners = new Set<(frame: Uint8Array) => void>();
  const instance = {
    add_listener: (_event: string, listener: (frame: Uint8Array) => void) => {
      listeners.add(listener);
    },
    remove_listener: (
      _event: string,
      listener: (frame: Uint8Array) => void,
    ) => {
      listeners.delete(listener);
    },
    bus: {
      send: (_name: string, frame: Uint8Array) => {
        received.push(new Uint8Array(frame));
      },
    },
  };
  const adapter = {
    send: (frame: Uint8Array) => {
      for (const listener of listeners) listener(frame);
    },
  };
  return { instance: instance as unknown as V86, adapter, received };
}

function arp(target: string, sourceMac = [2, 0, 0, 0, 0, 1]): Uint8Array {
  const frame = new Uint8Array(42);
  frame.set([255, 255, 255, 255, 255, 255]);
  frame.set(sourceMac, 6);
  frame.set([8, 6, 0, 1, 8, 0, 6, 4, 0, 1], 12);
  frame.set(sourceMac, 22);
  frame.set([192, 168, 76, 10], 28);
  frame.set(target.split(".").map(Number), 38);
  return frame;
}

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test("ports reject duplicate addresses and scripts reject arbitrary shell input", () => {
  const network = new VirtualNetwork();
  const first = network.createPort("one", "192.168.76.10");
  assert.throws(() => network.createPort("two", first.ip));
  assert.throws(() => guestNetworkScript("192.168.76.10;reboot"));
  assert.match(first.guestSetupCommand(), /ifconfig eth0 192\.168\.76\.10/);
  assert.equal(first.getSnapshot().mode, "isolated");
  first.dispose();
});

test("LAN forwards real frames only between connected, ready ports", async () => {
  const network = new VirtualNetwork();
  const a = network.createPort("a", "192.168.76.10");
  const b = network.createPort("b", "192.168.76.11");
  const ea = endpoint();
  const eb = endpoint();
  a.attach(ea.instance);
  b.attach(eb.instance);
  a.setMode("local");
  b.setMode("local");
  a.setReady(true);
  ea.adapter.send(arp(b.ip));
  await tick();
  assert.equal(
    eb.received.length,
    0,
    "boot/restore readiness hold must block incoming frames",
  );
  b.setReady(true);
  const frame = arp(b.ip);
  ea.adapter.send(frame);
  frame[0] = 0;
  await tick();
  assert.equal(eb.received.length, 1);
  assert.equal(
    eb.received[0][0],
    255,
    "packet bytes must be copied before asynchronous delivery",
  );
  b.setMode("isolated");
  ea.adapter.send(arp(b.ip));
  await tick();
  assert.equal(eb.received.length, 1);
  a.dispose();
  b.dispose();
});

test("turning off a port drops frames queued before the toggle", async () => {
  const network = new VirtualNetwork();
  const a = network.createPort("a", "192.168.76.10");
  const b = network.createPort("b", "192.168.76.11");
  const ea = endpoint();
  const eb = endpoint();
  a.attach(ea.instance);
  b.attach(eb.instance);
  a.setReady(true);
  b.setReady(true);
  a.setMode("local");
  b.setMode("local");
  ea.adapter.send(arp(b.ip));
  b.setMode("isolated");
  b.setMode("local");
  await tick();
  assert.equal(eb.received.length, 0);
  a.dispose();
  b.dispose();
});

test("the host answers gateway ARP while LAN discovery stays on its subnet", async () => {
  const network = new VirtualNetwork();
  const a = network.createPort("a", "192.168.76.10");
  const b = network.createPort("b", "192.168.76.11");
  const ea = endpoint();
  const eb = endpoint();
  a.attach(ea.instance);
  b.attach(eb.instance);
  a.setReady(true);
  b.setReady(true);
  a.setMode("world");
  b.setMode("local");
  const route = backend();
  ea.adapter.send(arp("192.168.76.1"));
  ea.adapter.send(arp(b.ip));
  await tick();
  assert.equal(route.sent.length, 0);
  assert.equal(ea.received.length, 1);
  assert.equal(
    ea.received[0][21],
    2,
    "gateway must return an actual ARP reply",
  );
  assert.equal(eb.received.length, 1);
  a.dispose();
  b.dispose();
});

test("the web bridge blocks local destinations including normalized IPv4 literals", () => {
  for (const url of [
    "http://localhost/",
    "http://127.1/",
    "http://0x7f000001/",
    "http://10.0.0.1/",
    "http://169.254.169.254/",
    "http://192.168.1.1/",
    "http://host.local/",
    "http://[::1]/",
    "http://1234.external/",
    "file:///etc/passwd",
    "https://user:password@example.com/",
  ]) {
    assert.throws(() => publicWebUrl(url), url);
  }
  assert.throws(() =>
    publicWebUrl("https://my-app.example/path", "https://my-app.example"),
  );
  assert.throws(() =>
    publicWebUrl("https://my-app.example./path", "https://my-app.example"),
  );
  assert.equal(
    publicWebUrl("http://example.com/path").href,
    "https://example.com/path",
  );
});

test("browser requests omit credentials/referrer, enforce CORS, reject redirects, and preserve explicit headers", async () => {
  let seen: { input: RequestInfo | URL; options?: RequestInit } | undefined;
  const network = new VirtualNetwork({
    fetch: async (input, options) => {
      seen = { input, options };
      return new Response("reply");
    },
  });
  const port = network.createPort("a", "192.168.76.10");
  const ep = endpoint();
  port.attach(ep.instance);
  port.setReady(true);
  const before = TestAdapter.instances.length;
  assert.equal(seen, undefined);
  assert.equal(
    TestAdapter.instances.length,
    before,
    "isolated ports never create an external backend",
  );
  port.setMode("world");
  const response = await backend().fetch("http://example.com/path", {
    headers: { Cookie: "ambient=bad", Authorization: "Bearer explicit" },
  });
  assert.equal(await response.text(), "reply");
  assert.equal(String(seen!.input), "https://example.com/path");
  assert.equal(seen!.options!.credentials, "omit");
  assert.equal(seen!.options!.referrerPolicy, "no-referrer");
  assert.equal(seen!.options!.redirect, "error");
  assert.equal(seen!.options!.mode, "cors");
  assert.equal(new Headers(seen!.options!.headers).get("cookie"), null);
  assert.equal(
    new Headers(seen!.options!.headers).get("authorization"),
    "Bearer explicit",
  );
  assert.equal(port.getSnapshot().inflightRequests, 0);
  const oldBackend = backend();
  port.setMode("local");
  port.setMode("world");
  await assert.rejects(oldBackend.fetch("https://example.com"), /disabled/);
  port.dispose();
});

test("turning World off aborts in-flight requests and does not release later responses", async () => {
  let signal: AbortSignal | undefined;
  let complete: ((response: Response) => void) | undefined;
  const network = new VirtualNetwork({
    fetch: async (_input, options) => {
      signal = options?.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    },
  });
  const port = network.createPort("a", "192.168.76.10");
  const ep = endpoint();
  port.attach(ep.instance);
  port.setReady(true);
  port.setMode("world");
  const request = backend().fetch("https://example.com");
  port.setMode("local");
  assert.equal(signal!.aborted, true);
  complete!(new Response("must not arrive"));
  await assert.rejects(request, /disabled/);
  assert.equal(port.getSnapshot().inflightRequests, 0);
  port.dispose();
});

test("turning World off aborts a response body already being downloaded", async () => {
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let signal: AbortSignal | undefined;
  let cancelled = false;
  const network = new VirtualNetwork({
    fetch: async (_input, options) => {
      signal = options?.signal as AbortSignal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    },
  });
  const port = network.createPort("a", "192.168.76.10");
  const ep = endpoint();
  port.attach(ep.instance);
  port.setReady(true);
  port.setMode("world");
  const response = backend().fetch("https://example.com");
  await tick();
  bodyController!.enqueue(new TextEncoder().encode("partial body"));
  await tick();
  port.setMode("isolated");
  assert.equal(signal!.aborted, true);
  await assert.rejects(response, /disabled/);
  assert.equal(cancelled, true);
  assert.equal(port.getSnapshot().inflightRequests, 0);
  port.dispose();
});

test("oversized web bodies fail before a success response reaches the guest", async () => {
  const network = new VirtualNetwork({
    fetch: async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)),
  });
  const port = network.createPort("limit", "192.168.76.10");
  const ep = endpoint();
  port.attach(ep.instance);
  port.setReady(true);
  port.setMode("world");
  await assert.rejects(backend().fetch("https://example.com"), /8 MiB/);
  assert.equal(port.getSnapshot().inflightRequests, 0);
  port.dispose();
});

test("detached adapter callbacks cannot affect a later attached machine", async () => {
  const network = new VirtualNetwork();
  const port = network.createPort("a", "192.168.76.10");
  const old = endpoint();
  port.attach(old.instance);
  port.setReady(true);
  port.setMode("world");
  const oldBackend = backend();
  port.detach();
  const fresh = endpoint();
  port.attach(fresh.instance);
  port.setReady(true);
  old.adapter.send(arp("192.168.76.1"));
  oldBackend.receive(arp("192.168.76.10"));
  await assert.rejects(oldBackend.fetch("https://example.com"), /disabled/);
  assert.equal(fresh.received.length, 0);
  assert.equal(oldBackend.sent.length, 0);
  assert.equal(backend().sent.length, 0);
  port.dispose();
});

test("standalone TCP bus dispatches to the adapter listener with its context", () => {
  const bus = new AdapterBus();
  const context = { value: 0 };
  bus.register(
    "tcp-connection",
    function (this: typeof context, value) {
      this.value = Number(value);
    },
    context,
  );
  bus.pair.send("tcp-connection", 7);
  assert.equal(context.value, 7);
});

test("relay URLs require an explicit secure endpoint without embedded credentials", () => {
  for (const value of [
    "",
    "ws://relay.example/",
    "https://relay.example/",
    "wss://user:secret@relay.example/",
    "wss://relay.example/#key",
  ])
    assert.throws(() => validateRelayUrl(value));
  assert.equal(
    validateRelayUrl("wisps://relay.example/wisp/"),
    "wss://relay.example/wisp/",
  );
  assert.equal(
    validateRelayUrl("wss://localhost:9443/wisp"),
    "wss://localhost:9443/wisp",
  );
});

class TestSocket extends EventTarget {
  onmessage: ((event: MessageEvent) => void) | null = () => undefined;
  closed = false;
  close() {
    this.closed = true;
  }
  credit() {
    const frame = new Uint8Array(9);
    frame[0] = 3;
    new DataView(frame.buffer).setUint32(5, 64, true);
    this.onmessage?.({ data: frame.buffer } as MessageEvent);
  }
}

class TestWispAdapter extends TestAdapter {
  static sockets: TestSocket[] = [];
  wispws: WebSocket | null = null;
  constructor(url: string) {
    super();
    this.register_ws(url);
  }
  register_ws(_url: string) {
    const socket = new TestSocket();
    this.wispws = socket as unknown as WebSocket;
    TestWispAdapter.sockets.push(socket);
  }
  on_tcp_connection(_connection: unknown, _packet: unknown) {
    return true;
  }
  destroy() {
    super.destroy();
    this.wispws?.close();
    this.wispws = null;
  }
}

test("Wisp is lazy, waits for protocol credit, and cannot reconnect after World is disabled", () => {
  const network = new VirtualNetwork({
    factories: {
      Fetch: TestAdapter,
      Wisp: TestWispAdapter,
    } as unknown as AdapterFactories,
  });
  const port = network.createPort("relay", "192.168.76.10");
  const ep = endpoint();
  port.configureTransport({
    kind: "wisp",
    relayUrl: "wss://relay.example/wisp",
  });
  const before = TestWispAdapter.sockets.length;
  port.attach(ep.instance);
  port.setReady(true);
  assert.equal(TestWispAdapter.sockets.length, before);
  port.setMode("world");
  const adapter = backend() as TestWispAdapter;
  const socket = TestWispAdapter.sockets.at(-1)!;
  assert.equal(port.getSnapshot().connectionState, "connecting");
  socket.dispatchEvent(new Event("open"));
  assert.equal(port.getSnapshot().connectionState, "connecting");
  socket.credit();
  assert.equal(port.getSnapshot().connectionState, "connected");
  port.setMode("local");
  assert.equal(socket.closed, true);
  assert.equal(port.getSnapshot().connectionState, "off");
  adapter.register_ws("wisps://relay.example/wisp");
  assert.equal(
    TestWispAdapter.sockets.length,
    before + 1,
    "stale retry must not create another socket",
  );
  socket.credit();
  assert.equal(port.getSnapshot().connectionState, "off");
  port.dispose();
});

function dnsQuery(hostname: string): Uint8Array {
  const question = [
    ...hostname
      .split(".")
      .flatMap((label) => [label.length, ...new TextEncoder().encode(label)]),
    0,
    0,
    1,
    0,
    1,
  ];
  const frame = new Uint8Array(42 + 12 + question.length);
  frame.set([0x52, 0x54, 0, 1, 2, 3]);
  frame.set([2, 0, 0, 0, 0, 10], 6);
  frame.set([8, 0], 12);
  frame[14] = 0x45;
  frame[23] = 17;
  frame.set([192, 168, 76, 10], 26);
  frame.set([192, 168, 76, 1], 30);
  frame.set([0xc0, 0, 0, 53], 34);
  frame.set([0x12, 0x34, 1, 0, 0, 1], 42);
  frame.set(question, 54);
  return frame;
}

test("relay DNS answers locally and preserves the hostname for Wisp CONNECT", () => {
  const dns = new RelayDns();
  const reply = dns.reply(dnsQuery("fixture.example"))!;
  assert.ok(reply);
  assert.deepEqual([...reply.slice(0, 6)], [2, 0, 0, 0, 0, 10]);
  assert.deepEqual(
    [...reply.slice(26, 34)],
    [192, 168, 76, 1, 192, 168, 76, 10],
  );
  let checksum = 0;
  for (let i = 14; i < 34; i += 2) checksum += (reply[i] << 8) | reply[i + 1];
  while (checksum >>> 16) checksum = (checksum & 0xffff) + (checksum >>> 16);
  assert.equal(checksum, 0xffff);
  const address = [...reply.slice(-4)].join(".");
  assert.equal(dns.hostname(address), "fixture.example");
  let routed: unknown;
  const adapter = new TestAdapter() as NetworkAdapter;
  adapter.on_tcp_connection = (_connection, packet) => {
    routed = packet.ipv4.dest;
    return true;
  };
  routeRelayHostnames(adapter, dns);
  const original = { ipv4: { dest: address.split(".").map(Number) } };
  adapter.on_tcp_connection({}, original);
  assert.deepEqual(routed, ["fixture.example"]);
  assert.deepEqual(original.ipv4.dest, address.split(".").map(Number));
});
