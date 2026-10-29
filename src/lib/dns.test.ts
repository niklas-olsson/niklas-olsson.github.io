// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import type { V86 } from "v86";
import { dnsReply, localDnsLabel, parseDnsQuery, validateDnsHostname } from "./dns.ts";
import { VirtualNetwork } from "./network.ts";
import { ALLOW_ALL_POLICY, internetChecksum, inspectPacket } from "./network-policy.ts";
import type { AdapterFactories, NetworkAdapter } from "./network-transport.ts";

const gatewayMac = new Uint8Array([0x52, 0x54, 0, 1, 2, 3]);
function request(name: string, type = 1, source = "10.40.1.10", gateway = "10.40.1.1", checksum = false): Uint8Array {
  const question = [...name.split(".").flatMap((label) => [label.length, ...new TextEncoder().encode(label)]), 0, type >> 8, type & 255, 0, 1];
  const frame = new Uint8Array(54 + question.length);
  const view = new DataView(frame.buffer);
  frame.set(gatewayMac); frame.set([2, 0, 0, 0, 0, 10], 6); frame.set([8, 0], 12);
  frame[14] = 0x45; view.setUint16(16, frame.length - 14); frame[22] = 64; frame[23] = 17;
  frame.set(source.split(".").map(Number), 26); frame.set(gateway.split(".").map(Number), 30);
  view.setUint16(24, internetChecksum(frame.subarray(14, 34)));
  view.setUint16(34, 42000); view.setUint16(36, 53); view.setUint16(38, frame.length - 34);
  frame.set([0x12, 0x34, 1, 0, 0, 1], 42); frame.set(question, 54);
  if (checksum) {
    const pseudo = new Uint8Array(12 + frame.length - 34);
    pseudo.set(frame.subarray(26, 34)); pseudo[9] = 17;
    new DataView(pseudo.buffer).setUint16(10, frame.length - 34); pseudo.set(frame.subarray(34), 12);
    view.setUint16(40, internetChecksum(pseudo) || 0xffff);
  }
  return frame;
}
function response(frame: Uint8Array) {
  assert.equal(inspectPacket(frame).error, undefined);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const answers = view.getUint16(48);
  return { code: frame[45] & 15, answers, address: answers ? [...frame.slice(-4)].join(".") : null };
}

test("DNS parses bounded real UDP questions and responds with actual IPv4 or explicit absence", () => {
  const query = parseDnsQuery(request("Peer.Terrarium.Internal", 1, undefined, undefined, true))!;
  assert.equal(query.name, "peer.terrarium.internal");
  assert.equal(query.sourcePort, 42000);
  const reply = dnsReply(query, "10.40.2.20", gatewayMac);
  assert.deepEqual(response(reply), { code: 0, answers: 1, address: "10.40.2.20" });
  assert.equal(new DataView(reply.buffer).getUint16(42), 0x1234);
  assert.equal(new DataView(reply.buffer).getUint16(reply.length - 10), 0, "zero record TTL");
  assert.equal(response(dnsReply(query, null, gatewayMac)).code, 3);
  const ipv6 = parseDnsQuery(request("peer", 28))!;
  assert.deepEqual(response(dnsReply(ipv6, "10.40.2.20", gatewayMac)), { code: 0, answers: 0, address: null });
  assert.deepEqual(localDnsLabel("peer"), { internal: true, label: "peer" });
  assert.deepEqual(localDnsLabel("PEER.TERRARIUM.INTERNAL."), { internal: true, label: "peer" });
  assert.deepEqual(localDnsLabel("deep.peer.terrarium.internal"), { internal: true, label: null });
  assert.equal(localDnsLabel("www.example.com").internal, false);
  assert.throws(() => validateDnsHostname("bad name"));
});

test("malformed, compressed, fragmented, and corrupt DNS questions do not produce replies", () => {
  const valid = request("peer");
  const compressed = valid.slice(); compressed[54] = 0xc0;
  assert.equal(parseDnsQuery(compressed), null);
  const multi = valid.slice(); multi[47] = 2;
  assert.equal(parseDnsQuery(multi), null);
  const fragment = valid.slice(); fragment[20] = 0x20;
  assert.equal(parseDnsQuery(fragment), null);
  const badLength = valid.slice(); badLength[39]--;
  assert.equal(parseDnsQuery(badLength), null);
  const corrupt = request("peer", 1, undefined, undefined, true); corrupt[55] ^= 1;
  assert.equal(parseDnsQuery(corrupt), null);
  for (let end = 0; end < valid.length; end++) assert.equal(parseDnsQuery(valid.slice(0, end)), null);
  assert.equal(parseDnsQuery(request("x".repeat(64))), null);
});

class Adapter implements NetworkAdapter {
  static sent = 0;
  vm_mac = new Uint8Array(6);
  tcp_conn = {};
  send(_frame: Uint8Array) { Adapter.sent++; }
  receive(_frame: Uint8Array) {}
  fetch = async () => new Response("unused");
  destroy() {}
}
const factories = { Fetch: Adapter, Wisp: Adapter } as unknown as AdapterFactories;
const vpcs = ["a", "b"].map((id) => ({ id, name: id, cidr: "10.40.0.0/16", subnets: [
  { id: "one", name: "One", cidr: "10.40.1.0/24" }, { id: "two", name: "Two", cidr: "10.40.2.0/24" },
] }));
function endpoint() {
  const received: Uint8Array[] = [];
  const listeners = new Set<(frame: Uint8Array) => void>();
  return {
    received,
    instance: { add_listener: (_: string, listener: (frame: Uint8Array) => void) => listeners.add(listener), remove_listener: (_: string, listener: (frame: Uint8Array) => void) => listeners.delete(listener), bus: { send: (_: string, frame: Uint8Array) => received.push(frame.slice()) } } as unknown as V86,
    send(frame: Uint8Array) { for (const listener of listeners) listener(frame); },
  };
}
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));
function client(network: VirtualNetwork, id: string, vpcId = "a", quarantined = false) {
  const port = network.createPort(id, "10.40.1.10", { vpcId, subnetId: "one", hostname: id, quarantined });
  const ep = endpoint(); port.attach(ep.instance); port.setReady(true);
  if (!quarantined) port.setMode("local");
  return { port, ep };
}

test("same-VPC names resolve across subnets; overlapping VPCs and private misses remain scoped", async () => {
  const network = new VirtualNetwork({ factories, vpcs });
  const a = client(network, "client-a"); const b = client(network, "client-b", "b");
  const peerA = network.createPort("peer-a", "10.40.2.20", { vpcId: "a", subnetId: "two", hostname: "peer" });
  const peerB = network.createPort("peer-b", "10.40.1.21", { vpcId: "b", subnetId: "one", hostname: "peer" });
  const secret = network.createPort("only-a", "10.40.1.22", { vpcId: "a", subnetId: "one", hostname: "only-a" });
  try {
    a.ep.send(request("peer.terrarium.internal")); b.ep.send(request("peer")); await tick();
    assert.equal(response(a.ep.received.at(-1)!).address, "10.40.2.20");
    assert.equal(response(b.ep.received.at(-1)!).address, "10.40.1.21");
    b.ep.send(request("only-a.terrarium.internal")); await tick();
    assert.equal(response(b.ep.received.at(-1)!).code, 3);
    assert.equal(a.port.getSnapshot().dnsName, "client-a.terrarium.internal");
    assert.throws(() => peerA.setHostname("client-a"), /already owns/);
    peerA.setHostname("renamed");
    a.ep.send(request("peer")); await tick(); assert.equal(response(a.ep.received.at(-1)!).code, 3);
    a.ep.send(request("renamed")); await tick(); assert.equal(response(a.ep.received.at(-1)!).address, peerA.ip);
    // World transport still owns external names; local private misses cannot leak there.
    a.port.setMode("world");
    a.ep.send(request("www.example.com")); await tick(); assert.match(response(a.ep.received.at(-1)!).address!, /^198\.18\./);
    a.ep.send(request("only-b.terrarium.internal")); await tick(); assert.equal(response(a.ep.received.at(-1)!).code, 3);
    const before = a.ep.received.length;
    a.ep.send(request("renamed.terrarium.internal", 1, "10.40.1.10", "8.8.8.8")); await tick();
    assert.equal(a.ep.received.length, before);
    assert.equal(a.port.getSnapshot().lastDrop?.reason, "private_dns_requires_gateway");
    assert.equal(Adapter.sent, 0, "No DNS packet was sent to an outside transport");
  } finally { for (const port of [a.port, b.port, peerA, peerB, secret]) port.dispose(); }
});

test("quarantine, readiness, isolation, and both packet policies govern DNS responses", async () => {
  const network = new VirtualNetwork({ factories, vpcs });
  const a = client(network, "observer"); const q = client(network, "quarantine", "a", true);
  const peer = network.createPort("peer", "10.40.2.20", { vpcId: "a", subnetId: "two", hostname: "peer" });
  try {
    a.ep.send(request("quarantine")); await tick(); assert.equal(response(a.ep.received.at(-1)!).code, 3);
    q.ep.send(request("observer")); await tick(); assert.equal(q.ep.received.length, 0);
    q.port.setHostname("new-quarantine"); assert.equal(q.port.getSnapshot().quarantined, true);
    const before = a.ep.received.length;
    a.ep.send(request("peer")); peer.quarantine("Queued DNS must not advertise it"); await tick();
    assert.equal(a.ep.received.length, before);
    a.port.setReady(false); a.ep.send(request("observer")); await tick(); assert.equal(a.ep.received.length, before);
    a.port.setReady(true); a.port.setMode("isolated"); a.ep.send(request("observer")); await tick(); assert.equal(a.ep.received.length, before);
    a.port.setMode("local"); a.port.setPolicy({ ingress: [], egress: ALLOW_ALL_POLICY.egress });
    a.ep.send(request("observer")); await tick(); assert.equal(a.ep.received.length, before);
    assert.ok(a.port.getSnapshot().dropReasons.ingress_policy > 0);
    a.port.setPolicy({ ingress: ALLOW_ALL_POLICY.ingress, egress: [] });
    a.ep.send(request("observer")); await tick(); assert.equal(a.ep.received.length, before);
    assert.ok(a.port.getSnapshot().dropReasons.egress_policy > 0);
  } finally { for (const port of [a.port, q.port, peer]) port.dispose(); }
});
