// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import type { V86 } from "v86";
import { VirtualNetwork } from "./network.ts";
import {
  ALLOW_ALL_POLICY,
  internetChecksum,
  inspectPacket,
  validateNetworkPolicy,
} from "./network-policy.ts";
import { PacketCapture } from "./network-capture.ts";
import {
  validateVpcList,
  resolveAttachment,
  type VpcConfig,
} from "./vpc-config.ts";
import type { AdapterFactories, NetworkAdapter } from "./network-transport.ts";

const vpcs: VpcConfig[] = [
  {
    id: "a",
    name: "A",
    cidr: "10.40.0.0/16",
    subnets: [
      { id: "one", name: "One", cidr: "10.40.1.0/24" },
      { id: "two", name: "Two", cidr: "10.40.2.0/24" },
    ],
  },
  {
    id: "b",
    name: "B overlaps A",
    cidr: "10.40.0.0/16",
    subnets: [
      { id: "one", name: "One", cidr: "10.40.1.0/24" },
      { id: "two", name: "Two", cidr: "10.40.2.0/24" },
    ],
  },
  {
    id: "c",
    name: "C",
    cidr: "10.41.0.0/16",
    subnets: [{ id: "one", name: "One", cidr: "10.41.1.0/24" }],
  },
];
const routerMac = [0x52, 0x54, 0, 1, 2, 3];
const aMac = [2, 0, 0, 0, 0, 10];
const bMac = [2, 0, 0, 0, 0, 11];

class Adapter implements NetworkAdapter {
  static instances: Adapter[] = [];
  sent: Uint8Array[] = [];
  tcp_conn = {};
  vm_mac = new Uint8Array(6);
  destroyed = false;
  constructor() {
    Adapter.instances.push(this);
  }
  send(frame: Uint8Array) {
    this.sent.push(frame.slice());
  }
  receive(_frame: Uint8Array) {}
  fetch = async (_url: RequestInfo | URL, _options?: RequestInit) =>
    new Response("unwrapped");
  destroy() {
    this.destroyed = true;
  }
}
const factories = {
  Fetch: Adapter,
  Wisp: Adapter,
} as unknown as AdapterFactories;
function endpoint() {
  const received: Uint8Array[] = [];
  const listeners = new Set<(frame: Uint8Array) => void>();
  return {
    received,
    instance: {
      add_listener: (_event: string, listener: (frame: Uint8Array) => void) =>
        listeners.add(listener),
      remove_listener: (
        _event: string,
        listener: (frame: Uint8Array) => void,
      ) => listeners.delete(listener),
      bus: {
        send: (_event: string, frame: Uint8Array) =>
          received.push(frame.slice()),
      },
    } as unknown as V86,
    send: (frame: Uint8Array) => {
      for (const listener of listeners) listener(frame);
    },
  };
}
function arp(
  source: string,
  target: string,
  sourceMac = aMac,
  operation = 1,
  destination = [255, 255, 255, 255, 255, 255],
) {
  const frame = new Uint8Array(42);
  frame.set(destination);
  frame.set(sourceMac, 6);
  frame.set([8, 6, 0, 1, 8, 0, 6, 4, 0, operation], 12);
  frame.set(sourceMac, 22);
  frame.set(source.split(".").map(Number), 28);
  frame.set(target.split(".").map(Number), 38);
  if (operation === 2) frame.set(destination, 32);
  return frame;
}
function ip(
  source: string,
  destination: string,
  protocol = 1,
  destinationPort = 0,
  sourceMac = aMac,
  targetMac = bMac,
) {
  const payload = protocol === 6 ? 20 : 8;
  const frame = new Uint8Array(14 + 20 + payload);
  const view = new DataView(frame.buffer);
  frame.set(targetMac);
  frame.set(sourceMac, 6);
  frame.set([8, 0], 12);
  frame[14] = 0x45;
  view.setUint16(16, 20 + payload);
  frame[22] = 64;
  frame[23] = protocol;
  frame.set(source.split(".").map(Number), 26);
  frame.set(destination.split(".").map(Number), 30);
  if (protocol === 1) {
    frame[34] = 8;
    view.setUint16(36, internetChecksum(frame.subarray(34)));
  } else {
    view.setUint16(34, 45678);
    view.setUint16(36, destinationPort);
    if (protocol === 6) frame[46] = 0x50;
    else view.setUint16(38, 8);
  }
  view.setUint16(24, internetChecksum(frame.subarray(14, 34)));
  return frame;
}
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));
function attach(
  network: VirtualNetwork,
  id: string,
  address: string,
  vpcId = "a",
  subnetId = "one",
  quarantined = false,
) {
  const port = network.createPort(id, address, {
    vpcId,
    subnetId,
    quarantined,
  });
  const ep = endpoint();
  port.attach(ep.instance);
  port.setReady(true);
  if (!quarantined) port.setMode("local");
  return { port, ep };
}

test("VPC configuration supports isolated overlapping ranges and validates every /24 attachment", () => {
  assert.equal(validateVpcList(vpcs).length, 3);
  assert.throws(() => validateVpcList([{ ...vpcs[0], cidr: "8.0.0.0/8" }]));
  assert.throws(() =>
    validateVpcList([
      {
        ...vpcs[0],
        subnets: [{ id: "bad", name: "Bad", cidr: "10.40.1.0/25" }],
      },
    ]),
  );
  assert.throws(() =>
    resolveAttachment(vpcs, { vpcId: "a", subnetId: "one", ip: "10.40.2.10" }),
  );
  assert.throws(() =>
    resolveAttachment(vpcs, { vpcId: "a", subnetId: "one", ip: "10.40.1.1" }),
  );
  assert.equal(
    resolveAttachment(vpcs, { vpcId: "a", subnetId: "two", ip: "10.40.2.10" })
      .gateway,
    "10.40.2.1",
  );
});

test("broadcast, multicast, ARP and identical MAC/IP addresses never cross VPC boundaries", async () => {
  const network = new VirtualNetwork({ vpcs, factories });
  const a = attach(network, "a", "10.40.1.10");
  const peer = attach(network, "peer", "10.40.1.11");
  const foreign = attach(network, "foreign", "10.40.1.11", "b");
  const anotherSubnet = attach(network, "subnet", "10.40.2.11", "a", "two");
  a.ep.send(arp(a.port.ip, peer.port.ip));
  a.ep.send(ip(a.port.ip, "239.1.1.1", 17, 9000, aMac, [1, 0, 94, 1, 1, 1]));
  a.ep.send(ip(a.port.ip, peer.port.ip));
  await tick();
  assert.equal(peer.ep.received.length, 3);
  assert.equal(foreign.ep.received.length, 0);
  assert.equal(anotherSubnet.ep.received.length, 0);
  a.ep.send(arp(peer.port.ip, peer.port.ip));
  a.ep.send(ip(peer.port.ip, peer.port.ip));
  await tick();
  assert.equal(peer.ep.received.length, 3);
  assert.equal(a.port.getSnapshot().dropReasons.source_ip_mismatch, 2);
  for (const machine of [a, peer, foreign, anotherSubnet])
    machine.port.dispose();
});

test("cross-subnet traffic uses gateway ARP, resolved target MAC, TTL decrement and valid checksum", async () => {
  const network = new VirtualNetwork({ vpcs, factories });
  const a = attach(network, "a", "10.40.1.10");
  const b = attach(network, "b", "10.40.2.11", "a", "two");
  const foreign = attach(network, "foreign", b.port.ip, "b", "two");
  a.ep.send(arp(a.port.ip, a.port.gateway));
  await tick();
  assert.equal(a.ep.received[0][21], 2);
  assert.deepEqual([...a.ep.received[0].slice(22, 28)], routerMac);
  a.ep.send(ip(a.port.ip, b.port.ip, 1, 0, aMac, routerMac));
  await tick();
  assert.equal(b.ep.received.length, 1);
  assert.equal(inspectPacket(b.ep.received[0]).protocol, "arp");
  assert.equal(inspectPacket(b.ep.received[0]).source, b.port.gateway);
  b.ep.send(arp(b.port.ip, b.port.gateway, bMac, 2, routerMac));
  await tick();
  assert.equal(b.ep.received.length, 2);
  const delivered = b.ep.received[1];
  assert.deepEqual([...delivered.slice(0, 6)], bMac);
  assert.deepEqual([...delivered.slice(6, 12)], routerMac);
  assert.equal(delivered[22], 63);
  assert.equal(inspectPacket(delivered).error, undefined);
  assert.equal(inspectPacket(delivered).destination, b.port.ip);
  assert.equal(foreign.ep.received.length, 0);
  for (const machine of [a, b, foreign]) machine.port.dispose();
});

test("World cannot turn a different VPC address into an outside route", async () => {
  const network = new VirtualNetwork({ vpcs, factories });
  const a = attach(network, "a", "10.40.1.10");
  const foreign = attach(network, "foreign", "10.41.1.11", "c");
  a.port.setMode("world");
  const adapter = Adapter.instances.at(-1)!;
  a.ep.send(ip(a.port.ip, foreign.port.ip, 6, 80, aMac, routerMac));
  await tick();
  assert.equal(adapter.sent.length, 0);
  assert.equal(foreign.ep.received.length, 0);
  assert.equal(a.port.getSnapshot().lastDrop?.reason, "cross_vpc_route");
  a.port.dispose();
  foreign.port.dispose();
});

test("stateless allowlists enforce protocol, CIDR and destination ports; fragments cannot bypass them", async () => {
  const network = new VirtualNetwork({ vpcs, factories });
  const a = attach(network, "a", "10.40.1.10");
  const b = attach(network, "b", "10.40.1.11");
  b.port.setPolicy({
    ingress: [{ protocol: "tcp", cidr: "10.40.1.0/24", port: 22 }],
    egress: ALLOW_ALL_POLICY.egress,
  });
  a.ep.send(ip(a.port.ip, b.port.ip, 6, 80));
  a.ep.send(ip(a.port.ip, b.port.ip, 17, 22));
  a.ep.send(ip(a.port.ip, b.port.ip, 6, 22));
  await tick();
  assert.equal(b.ep.received.length, 1);
  assert.equal(b.port.getSnapshot().dropReasons.ingress_policy, 2);
  a.port.setPolicy({
    ingress: ALLOW_ALL_POLICY.ingress,
    egress: [{ protocol: "tcp", cidr: "10.40.1.0/24", port: 80 }],
  });
  a.ep.send(ip(a.port.ip, b.port.ip, 6, 22));
  await tick();
  assert.equal(b.ep.received.length, 1);
  assert.equal(a.port.getSnapshot().lastDrop?.reason, "egress_policy");
  const fragment = ip(a.port.ip, b.port.ip, 6, 80);
  fragment[20] = 0x20;
  fragment[24] = 0;
  fragment[25] = 0;
  new DataView(fragment.buffer).setUint16(
    24,
    internetChecksum(fragment.subarray(14, 34)),
  );
  a.ep.send(fragment);
  await tick();
  assert.equal(
    a.port.getSnapshot().lastDrop?.reason,
    "ipv4_fragment_not_routed",
  );
  assert.throws(() =>
    validateNetworkPolicy({
      ingress: [{ protocol: "icmp", cidr: "0.0.0.0/0", port: 80 }],
      egress: [],
    }),
  );
  a.port.dispose();
  b.port.dispose();
});

test("quarantine is irreversible, aborts outside work and queued peer traffic, and captures rejected attempts", async () => {
  let complete: ((response: Response) => void) | undefined;
  let signal: AbortSignal | undefined;
  const network = new VirtualNetwork({
    vpcs,
    factories,
    fetch: async (_url, options) => {
      signal = options?.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    },
  });
  const a = attach(network, "a", "10.40.1.10");
  const b = attach(network, "b", "10.40.1.11");
  a.port.setMode("world");
  a.port.setCapture(true);
  const adapter = Adapter.instances.at(-1)!;
  const pending = adapter.fetch("https://example.com");
  a.ep.send(ip(a.port.ip, b.port.ip));
  a.port.quarantine("Investigating a snapshot");
  await tick();
  assert.equal(b.ep.received.length, 0);
  assert.equal(signal?.aborted, true);
  assert.equal(adapter.destroyed, true);
  complete!(new Response("must not arrive"));
  await assert.rejects(pending, /disabled/);
  a.port.setReady(false);
  a.port.setReady(true);
  assert.throws(() => a.port.setMode("local"), /quarantined/);
  assert.throws(() => a.port.setMode("world"), /quarantined/);
  assert.throws(
    () => a.port.configureTransport({ kind: "web" }),
    /quarantined/,
  );
  assert.throws(() => a.port.setPolicy(ALLOW_ALL_POLICY), /quarantined/);
  assert.throws(
    () =>
      a.port.configureAttachment({
        vpcId: "b",
        subnetId: "one",
        ip: a.port.ip,
      }),
    /quarantined/,
  );
  a.ep.send(ip(a.port.ip, b.port.ip));
  await tick();
  assert.equal(b.ep.received.length, 0);
  assert.equal(a.port.getSnapshot().lastDrop?.reason, "quarantined");
  assert.equal(a.port.getSnapshot().capture.packets, 2);
  assert.equal(a.port.getSnapshot().mode, "isolated");
  const copy = network.createPort("inspection", a.port.ip, {
    vpcId: "a",
    subnetId: "one",
    quarantined: true,
  });
  assert.equal(copy.quarantined, true);
  assert.throws(() => copy.setMode("world"));
  assert.equal(
    new DataView(a.port.exportPcap().buffer).getUint32(0, true),
    0xa1b2c3d4,
  );
  copy.dispose();
  a.port.dispose();
  b.port.dispose();
});

test("attachment changes require detach and ordinary duplicate addresses remain forbidden", () => {
  const network = new VirtualNetwork({ vpcs, factories });
  const a = attach(network, "a", "10.40.1.10");
  assert.throws(() =>
    network.createPort("duplicate", a.port.ip, { vpcId: "a", subnetId: "one" }),
  );
  assert.throws(
    () =>
      a.port.configureAttachment({
        vpcId: "b",
        subnetId: "one",
        ip: a.port.ip,
      }),
    /detach/,
  );
  a.port.detach();
  a.port.configureAttachment({ vpcId: "b", subnetId: "two", ip: "10.40.2.10" });
  assert.equal(a.port.vpcId, "b");
  assert.equal(a.port.getSnapshot().mode, "isolated");
  assert.match(a.port.guestSetupCommand(), /default gw 10\.40\.2\.1/);
  a.port.dispose();
});

test("packet capture has valid Ethernet PCAP headers, copies bytes and bounds its ring", () => {
  const capture = new PacketCapture();
  const frame = new Uint8Array(3000).fill(7);
  capture.record(frame, 1234);
  assert.equal(capture.getSnapshot().packets, 0);
  capture.setEnabled(true);
  for (let index = 0; index < 2050; index++)
    capture.record(frame, 1234 + index);
  frame[0] = 9;
  const data = capture.exportPcap();
  const header = new DataView(data.buffer);
  assert.equal(header.getUint32(0, true), 0xa1b2c3d4);
  assert.equal(header.getUint16(4, true), 2);
  assert.equal(header.getUint16(6, true), 4);
  assert.equal(header.getUint32(16, true), 2048);
  assert.equal(header.getUint32(20, true), 1);
  assert.equal(header.getUint32(24 + 8, true), 2048);
  assert.equal(header.getUint32(24 + 12, true), 3000);
  assert.equal(data[40], 7);
  assert.equal(capture.getSnapshot().packets, 2048);
  assert.equal(capture.getSnapshot().evicted, 2);
  assert.equal(capture.getSnapshot().bytes, 4 * 1024 * 1024);
});
