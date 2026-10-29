// SPDX-License-Identifier: Apache-2.0

import type { V86, V86Options } from "v86";
import { VPC_DNS_SUFFIX, dnsReply, localDnsLabel, parseDnsQuery, validateDnsHostname } from "./dns.ts";
import {
  DEFAULT_SUBNET_ID,
  DEFAULT_VPC_ID,
  DEFAULT_VPCS,
  containsIp,
  ipv4Number,
  parseCidr,
  resolveAttachment,
  validateVpcList,
  type NetworkAttachment,
  type ResolvedAttachment,
  type VpcConfig,
} from "./vpc-config.ts";
import {
  ALLOW_ALL_POLICY,
  inspectPacket,
  internetChecksum,
  macAt,
  policyAllows,
  validateNetworkPolicy,
  type NetworkPolicy,
  type PacketInfo,
} from "./network-policy.ts";
import {
  PacketCapture,
  type CaptureSnapshot,
  type FlowEvent,
} from "./network-capture.ts";
export type {
  NetworkAttachment,
  VpcConfig,
  SubnetConfig,
} from "./vpc-config.ts";
export type { NetworkPolicy, PacketRule } from "./network-policy.ts";
export type { FlowEvent, CaptureSnapshot } from "./network-capture.ts";
import {
  AdapterBus,
  loadNetworkAdapters,
  RelayDns,
  routeRelayHostnames,
  validateRelayUrl,
  type AdapterFactories,
  type ConnectionState,
  type EthernetEndpoint,
  type NetworkAdapter,
  type NetworkTransport,
} from "./network-transport.ts";
export {
  validateRelayUrl,
  type EthernetEndpoint,
  type NetworkTransport,
} from "./network-transport.ts";

export type NetworkMode = "isolated" | "local" | "world";
export const LAN_PREFIX = "192.168.76";
export const LAN_GATEWAY = `${LAN_PREFIX}.1`;
const MAX_FRAME_BYTES = 65_536;
const MAX_WEB_REQUESTS = 6;
const MAX_WEB_RESPONSE_BYTES = 8 * 1024 * 1024;
const GATEWAY_MAC = new Uint8Array([0x52, 0x54, 0, 1, 2, 3]);

export interface CreatePortOptions {
  hostname?: string;
  vpcId?: string;
  subnetId?: string;
  quarantined?: boolean;
  quarantineReason?: string;
}

export interface NetworkSnapshot {
  id: string;
  hostname: string | null;
  dnsName: string | null;
  ip: string;
  mode: NetworkMode;
  attached: boolean;
  ready: boolean;
  /** World uses either the constrained HTTP bridge or an explicit TCP relay. */
  transport: "web" | "wisp";
  relayUrl: string | null;
  connectionState: ConnectionState;
  txPackets: number;
  rxPackets: number;
  droppedPackets: number;
  webRequests: number;
  blockedRequests: number;
  inflightRequests: number;
  lastError: string | null;
  vpcId: string;
  subnetId: string;
  vpcCidr: string;
  subnetCidr: string;
  gateway: string;
  quarantined: boolean;
  quarantineReason: string | null;
  policy: NetworkPolicy;
  capture: CaptureSnapshot;
  lastDrop: FlowEvent | null;
  dropReasons: Record<string, number>;
}

interface NetworkSettings {
  fetch?: typeof fetch;
  /** Host application origin, excluded from guest fetch requests. */
  origin?: string;
  factories?: AdapterFactories;
  vpcs?: VpcConfig[];
}

export function guestNetworkScript(ip: string, gateway = LAN_GATEWAY): string {
  const address = ipv4Number(ip);
  const route = ipv4Number(gateway);
  if (
    (address & 0xffffff00) !== (route & 0xffffff00) ||
    (route & 255) !== 1 ||
    (address & 255) < 2 ||
    (address & 255) > 254
  )
    throw new Error(
      "Use a host address and its .1 gateway in the same /24 subnet.",
    );
  return `ifconfig eth0 ${ip} netmask 255.255.255.0 up\nroute del default 2>/dev/null || true\nroute add default gw ${gateway}\nprintf 'nameserver ${gateway}\\n' > /etc/resolv.conf`;
}

function privateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host.startsWith("[")) return true;
  if (
    /^(localhost|localhost\.localdomain)$/.test(host) ||
    /\.(localhost|local|internal|lan|home|external|invalid|test)$/.test(host)
  )
    return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b, c] = host.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  return false;
}

export function publicWebUrl(input: string | URL, origin?: string): URL {
  const url = new URL(String(input));
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("The web bridge supports HTTP requests only.");
  if (url.username || url.password)
    throw new Error(
      "Credentials in a URL are not supported by the web bridge.",
    );
  if (privateOrLocalHost(url.hostname))
    throw new Error(
      "Local and private host addresses are excluded from the web bridge.",
    );
  // The guest speaks HTTP to v86; the browser always uses HTTPS on the wire.
  url.protocol = "https:";
  if (
    origin &&
    url.hostname.toLowerCase().replace(/\.$/, "") ===
      new URL(origin).hostname.toLowerCase().replace(/\.$/, "")
  )
    throw new Error("The application host is excluded from guest requests.");
  url.hash = "";
  return url;
}

interface PendingRoute {
  source: NetworkPort;
  target: NetworkPort;
  sourceToken: string;
  targetToken: string;
  frame: Uint8Array;
  expiresAt: number;
}

/** Host-owned VPC membership, subnet Ethernet segments, and IPv4 local routes. */
export class VirtualNetwork {
  private readonly ports = new Map<string, NetworkPort>();
  private readonly learnedMacs = new Map<string, Uint8Array>();
  private readonly pendingRoutes: PendingRoute[] = [];
  private vpcs: VpcConfig[];
  private readonly settings: NetworkSettings;
  private readonly listeners = new Set<(ports: NetworkSnapshot[]) => void>();

  constructor(settings: NetworkSettings = {}) {
    this.settings = settings;
    this.vpcs = validateVpcList(settings.vpcs ?? DEFAULT_VPCS);
  }

  listVpcs = (): VpcConfig[] => structuredClone(this.vpcs);

  addVpc(config: VpcConfig): void {
    this.vpcs = validateVpcList([...this.vpcs, config]);
    this.notify();
  }

  updateVpc(id: string, patch: { name: string }): void {
    if (!this.vpcs.some((vpc) => vpc.id === id)) throw new Error("That VPC does not exist.");
    this.vpcs = validateVpcList(this.vpcs.map((vpc) => vpc.id === id ? { ...vpc, name: patch.name } : vpc));
    this.notify();
  }

  addSubnet(vpcId: string, subnet: import("./vpc-config.ts").SubnetConfig): void {
    if (!this.vpcs.some((vpc) => vpc.id === vpcId)) throw new Error("That VPC does not exist.");
    this.vpcs = validateVpcList(this.vpcs.map((vpc) => vpc.id === vpcId ? { ...vpc, subnets: [...vpc.subnets, subnet] } : vpc));
    this.notify();
  }

  updateSubnet(vpcId: string, subnetId: string, patch: Partial<Pick<import("./vpc-config.ts").SubnetConfig, "name" | "cidr">>): void {
    const subnet = this.vpcs.find((vpc) => vpc.id === vpcId)?.subnets.find((item) => item.id === subnetId);
    if (!subnet) throw new Error("That subnet does not exist.");
    if (patch.cidr !== undefined && patch.cidr !== subnet.cidr && [...this.ports.values()].some((port) => port.vpcId === vpcId && port.subnetId === subnetId)) throw new Error("Move or remove every machine before changing an occupied subnet's CIDR.");
    const updated = { ...subnet, ...(patch.name === undefined ? {} : { name: patch.name }), ...(patch.cidr === undefined ? {} : { cidr: patch.cidr }) };
    this.vpcs = validateVpcList(this.vpcs.map((vpc) => vpc.id === vpcId ? { ...vpc, subnets: vpc.subnets.map((item) => item.id === subnetId ? updated : item) } : vpc));
    this.notify();
  }

  removeSubnet(vpcId: string, subnetId: string): void {
    if (!this.vpcs.find((vpc) => vpc.id === vpcId)?.subnets.some((subnet) => subnet.id === subnetId)) throw new Error("That subnet does not exist.");
    const attached = [...this.ports.values()].filter((port) => port.vpcId === vpcId && port.subnetId === subnetId);
    if (attached.length) throw new Error(`Move or remove attached machines before deleting this subnet: ${attached.map((port) => port.hostname ?? port.id).join(", ")}. Stopped machines also retain their attachments.`);
    this.vpcs = validateVpcList(this.vpcs.map((vpc) => vpc.id === vpcId ? { ...vpc, subnets: vpc.subnets.filter((subnet) => subnet.id !== subnetId) } : vpc));
    this.notify();
  }

  removeVpc(id: string): void {
    const vpc = this.vpcs.find((item) => item.id === id);
    if (!vpc)
      throw new Error("That VPC does not exist.");
    const attached = [...this.ports.values()].filter((port) => port.vpcId === id);
    if (attached.length) throw new Error(`Move or remove attached machines before deleting this VPC: ${attached.map((port) => port.hostname ?? port.id).join(", ")}.`);
    if (vpc.subnets.length) throw new Error(`Delete child subnets explicitly before deleting this VPC: ${vpc.subnets.map((subnet) => subnet.name).join(", ")}.`);
    this.vpcs = validateVpcList(this.vpcs.filter((vpc) => vpc.id !== id));
    this.notify();
  }

  resolvePortAttachment(
    id: string,
    attachment: NetworkAttachment,
    quarantined: boolean,
  ): ResolvedAttachment {
    const resolved = resolveAttachment(this.vpcs, attachment);
    if (
      !quarantined &&
      [...this.ports.values()].some(
        (port) =>
          port.id !== id &&
          !port.quarantined &&
          port.vpcId === resolved.vpcId &&
          port.ip === resolved.ip,
      )
    )
      throw new Error(
        "Another connected-capable machine already owns that address in this VPC.",
      );
    return resolved;
  }

  validatePortHostname(id: string, hostname: string, vpcId: string, quarantined: boolean): string {
    const name = validateDnsHostname(hostname);
    if (!quarantined && [...this.ports.values()].some((port) => port.id !== id && !port.quarantined && port.vpcId === vpcId && port.hostname === name))
      throw new Error("Another machine already owns that DNS name in this VPC.");
    return name;
  }

  createPort(
    id: string,
    ip: string,
    options: CreatePortOptions = {},
  ): NetworkPort {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id))
      throw new Error("Invalid network port ID.");
    if (this.ports.has(id))
      throw new Error("This machine already has a network port.");
    const attachment = this.resolvePortAttachment(
      id,
      {
        ip,
        vpcId: options.vpcId ?? DEFAULT_VPC_ID,
        subnetId: options.subnetId ?? DEFAULT_SUBNET_ID,
      },
      options.quarantined === true,
    );
    const port = new NetworkPort(this, id, attachment, this.settings, options);
    this.ports.set(id, port);
    this.notify();
    return port;
  }

  getSnapshot = (): NetworkSnapshot[] =>
    [...this.ports.values()].map((port) => port.getSnapshot());

  subscribe(listener: (ports: NetworkSnapshot[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.getSnapshot());
      } catch {
        /* A UI observer cannot interrupt packet delivery. */
      }
    }
  }

  forget(id: string): void {
    this.learnedMacs.delete(id);
    for (let index = this.pendingRoutes.length - 1; index >= 0; index--) {
      const pending = this.pendingRoutes[index];
      if (pending.source.id === id || pending.target.id === id)
        this.pendingRoutes.splice(index, 1);
    }
  }

  remove(id: string): void {
    this.forget(id);
    this.ports.delete(id);
    this.notify();
  }

  private learn(source: NetworkPort, frame: Uint8Array): void {
    this.learnedMacs.set(source.id, frame.slice(6, 12));
    for (let index = this.pendingRoutes.length - 1; index >= 0; index--) {
      const pending = this.pendingRoutes[index];
      if (
        pending.expiresAt < Date.now() ||
        !pending.source.isConnected() ||
        !pending.target.isConnected() ||
        pending.source.deliveryToken() !== pending.sourceToken ||
        pending.target.deliveryToken() !== pending.targetToken
      ) {
        this.pendingRoutes.splice(index, 1);
      } else if (pending.target === source) {
        this.pendingRoutes.splice(index, 1);
        this.deliverRouted(pending.source, pending.target, pending.frame);
      }
    }
  }

  private subnetPeers(source: NetworkPort): NetworkPort[] {
    return [...this.ports.values()].filter(
      (target) =>
        target !== source &&
        target.vpcId === source.vpcId &&
        target.subnetId === source.subnetId,
    );
  }

  private arpPacket(
    sourceIp: string,
    targetIp: string,
    destination: Uint8Array,
    operation: 1 | 2,
    targetMac = new Uint8Array(6),
  ): Uint8Array {
    const frame = new Uint8Array(42);
    frame.set(destination, 0);
    frame.set(GATEWAY_MAC, 6);
    frame.set([8, 6, 0, 1, 8, 0, 6, 4, 0, operation], 12);
    frame.set(GATEWAY_MAC, 22);
    frame.set(sourceIp.split(".").map(Number), 28);
    frame.set(targetMac, 32);
    frame.set(targetIp.split(".").map(Number), 38);
    return frame;
  }

  private deliverRouted(
    source: NetworkPort,
    target: NetworkPort,
    frame: Uint8Array,
  ): void {
    const destination = this.learnedMacs.get(target.id);
    if (!destination) return;
    const routed = frame.slice();
    const headerLength = (routed[14] & 15) * 4;
    routed.set(destination, 0);
    routed.set(GATEWAY_MAC, 6);
    routed[22]--;
    routed[24] = 0;
    routed[25] = 0;
    new DataView(routed.buffer).setUint16(
      24,
      internetChecksum(routed.subarray(14, 14 + headerLength)),
    );
    target.receivePeer(routed, source, true);
  }

  /** Returns outside only after all VPC and source-identity checks succeeded. */
  route(
    source: NetworkPort,
    frame: Uint8Array,
    packet: PacketInfo,
  ): "outside" | string {
    if (this.ports.get(source.id) !== source || !source.isConnected())
      return "drop:port_disconnected";
    if (packet.error) return `drop:${packet.error}`;
    if (
      frame[6] & 1 ||
      macAt(frame, 6) === "00:00:00:00:00:00" ||
      macAt(frame, 6) === macAt(GATEWAY_MAC, 0)
    )
      return "drop:invalid_source_mac";
    if (
      packet.source !== source.ip &&
      !(
        packet.protocol === "arp" &&
        packet.source === "0.0.0.0" &&
        packet.destination === source.ip &&
        frame[21] === 1
      )
    )
      return "drop:source_ip_mismatch";
    this.learn(source, frame);
    if (packet.protocol === "arp") {
      if (packet.destination === source.gateway) {
        if (frame[21] === 1)
          source.receiveGateway(
            this.arpPacket(
              source.gateway,
              source.ip,
              frame.slice(6, 12),
              2,
              frame.slice(6, 12),
            ),
          );
        return "gateway_arp";
      }
      if (!containsIp(source.subnetCidr, packet.destination))
        return "drop:arp_outside_subnet";
      for (const target of this.subnetPeers(source))
        target.receivePeer(frame, source, false);
      return "subnet_arp";
    }
    const destination = ipv4Number(packet.destination);
    const broadcast = parseCidr(source.subnetCidr).broadcast;
    if (
      destination === 0xffffffff ||
      destination === broadcast ||
      destination >>> 28 === 14
    ) {
      for (const target of this.subnetPeers(source))
        target.receivePeer(frame, source, false);
      return "subnet_broadcast";
    }
    const target = [...this.ports.values()].find(
      (port) =>
        port !== source &&
        !port.quarantined &&
        port.vpcId === source.vpcId &&
        port.ip === packet.destination,
    );
    if (target) {
      if (!target.isConnected()) return "drop:peer_disconnected";
      if (target.subnetId === source.subnetId) {
        target.receivePeer(frame, source, false);
        return "subnet_peer";
      }
      if (frame[22] <= 1) return "drop:ttl_expired";
      if (macAt(frame, 0) !== macAt(GATEWAY_MAC, 0))
        return "drop:gateway_mac_required";
      if (this.learnedMacs.has(target.id))
        this.deliverRouted(source, target, frame);
      else {
        if (this.pendingRoutes.length >= 32) return "drop:route_queue_full";
        this.pendingRoutes.push({
          source,
          target,
          sourceToken: source.deliveryToken(),
          targetToken: target.deliveryToken(),
          frame: frame.slice(),
          expiresAt: Date.now() + 2000,
        });
        const request = this.arpPacket(
          target.gateway,
          target.ip,
          new Uint8Array(6).fill(255),
          1,
        );
        target.receiveGateway(request);
      }
      return "vpc_local_route";
    }
    if (packet.destination === source.gateway && packet.protocol === "icmp") {
      const offset = 14 + packet.ipHeaderBytes;
      if (
        frame.length < offset + 8 ||
        frame[offset] !== 8 ||
        frame[offset + 1] !== 0
      )
        return "drop:gateway_icmp_unsupported";
      const reply = frame.slice(0, 14 + ((frame[16] << 8) | frame[17]));
      reply.set(frame.subarray(6, 12), 0);
      reply.set(GATEWAY_MAC, 6);
      reply.set(frame.subarray(30, 34), 26);
      reply.set(frame.subarray(26, 30), 30);
      reply[22] = 64;
      reply[24] = 0;
      reply[25] = 0;
      new DataView(reply.buffer).setUint16(
        24,
        internetChecksum(reply.subarray(14, 14 + packet.ipHeaderBytes)),
      );
      reply[offset] = 0;
      reply[offset + 2] = 0;
      reply[offset + 3] = 0;
      new DataView(reply.buffer).setUint16(
        offset + 2,
        internetChecksum(reply.subarray(offset)),
      );
      source.receiveGateway(reply);
      return "gateway_icmp";
    }
    if (packet.protocol === "udp" && packet.destinationPort === 53) {
      const query = parseDnsQuery(frame);
      if (!query) return "drop:dns_query_unsupported";
      const name = localDnsLabel(query.name);
      if (name.internal) {
        if (packet.destination !== source.gateway) return "drop:private_dns_requires_gateway";
        if (macAt(frame, 0) !== macAt(GATEWAY_MAC, 0)) return "drop:gateway_mac_required";
        // Host-owned configuration records, scoped before lookup. Readiness of
        // the destination is not a health check; quarantine is never advertised.
        const destination = name.label && [...this.ports.values()].find((port) => !port.quarantined && port.vpcId === source.vpcId && port.hostname === name.label);
        const address = destination ? destination.ip : null;
        source.receiveGateway(dnsReply(query, address, GATEWAY_MAC), "vpc_dns", () => !destination || (
          this.ports.get(destination.id) === destination && !destination.quarantined && destination.vpcId === source.vpcId && destination.hostname === name.label && destination.ip === address
        ));
        return destination ? "vpc_dns" : "vpc_dns_nxdomain";
      }
    }
    if (packet.destination !== source.gateway) {
      if (containsIp(source.vpcCidr, packet.destination))
        return "drop:no_vpc_route";
      if (
        this.vpcs.some(
          (vpc) =>
            vpc.id !== source.vpcId && containsIp(vpc.cidr, packet.destination),
        )
      )
        return "drop:cross_vpc_route";
    }
    if (
      packet.protocol !== "tcp" &&
      !(packet.protocol === "udp" && packet.destinationPort === 53)
    )
      return "drop:outside_protocol_unsupported";
    return "outside";
  }
}

export class NetworkPort {
  readonly id: string;
  private dnsHostname: string | null;
  private attachment: ResolvedAttachment;
  #quarantined = false;
  private quarantineReason: string | null = null;
  private policy: NetworkPolicy = structuredClone(ALLOW_ALL_POLICY);
  private readonly capture = new PacketCapture();
  private readonly flowLog: FlowEvent[] = [];
  private lastDrop: FlowEvent | null = null;
  private readonly dropReasons: Record<string, number> = Object.create(null);
  private readonly network: VirtualNetwork;
  private readonly fetchImpl: typeof fetch;
  private readonly origin: string | undefined;
  private mode: NetworkMode = "isolated";
  private ready = false;
  private policyGeneration = 0;
  private endpoint: EthernetEndpoint | null = null;
  private unsubscribeFrames: (() => void) | null = null;
  private adapter: NetworkAdapter | null = null;
  private factories: AdapterFactories | null;
  private pendingAttachment = false;
  private backendGeneration = 0;
  private configuration: NetworkTransport = { kind: "web" };
  private connectionState: ConnectionState = "off";
  private readonly relayDns = new RelayDns();
  private generation = 0;
  private disposed = false;
  private txPackets = 0;
  private rxPackets = 0;
  private droppedPackets = 0;
  private webRequests = 0;
  private blockedRequests = 0;
  private lastError: string | null = null;
  private readonly activeFetches = new Set<AbortController>();
  private readonly listeners = new Set<(snapshot: NetworkSnapshot) => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    network: VirtualNetwork,
    id: string,
    attachment: ResolvedAttachment,
    settings: NetworkSettings = {},
    options: CreatePortOptions = {},
  ) {
    this.network = network;
    this.id = id;
    this.attachment = attachment;
    this.#quarantined = options.quarantined === true;
    this.dnsHostname = options.hostname === undefined ? null : network.validatePortHostname(id, options.hostname, attachment.vpcId, this.#quarantined);
    this.quarantineReason = this.#quarantined
      ? (options.quarantineReason || "Snapshot investigation").slice(0, 160)
      : null;
    this.fetchImpl = settings.fetch ?? globalThis.fetch.bind(globalThis);
    this.origin =
      settings.origin ??
      (typeof location !== "undefined" ? location.origin : undefined);
    this.factories = settings.factories ?? null;
  }

  get ip(): string {
    return this.attachment.ip;
  }
  get hostname(): string | null { return this.dnsHostname; }

  /** Host metadata only. Updating a name cannot enable a quarantined port. */
  setHostname(hostname: string): void {
    if (this.disposed) throw new Error("This network port has been disposed.");
    this.dnsHostname = this.network.validatePortHostname(this.id, hostname, this.vpcId, this.#quarantined);
    this.notify();
  }
  get vpcId(): string {
    return this.attachment.vpcId;
  }
  get subnetId(): string {
    return this.attachment.subnetId;
  }
  get vpcCidr(): string {
    return this.attachment.vpcCidr;
  }
  get subnetCidr(): string {
    return this.attachment.subnetCidr;
  }
  get gateway(): string {
    return this.attachment.gateway;
  }
  get quarantined(): boolean {
    return this.#quarantined;
  }
  isConnected(): boolean {
    return (
      !!this.endpoint &&
      this.ready &&
      !this.#quarantined &&
      this.mode !== "isolated"
    );
  }
  deliveryToken(): string {
    return `${this.generation}:${this.policyGeneration}`;
  }

  private requireMutableNetwork(): void {
    if (this.disposed) throw new Error("This network port has been disposed.");
    if (this.#quarantined)
      throw new Error(
        "This investigation machine is permanently quarantined. Network configuration cannot release it.",
      );
  }

  configureAttachment(attachment: NetworkAttachment): void {
    this.requireMutableNetwork();
    if (this.endpoint || this.pendingAttachment)
      throw new Error(
        "Stop and detach the machine before changing its VPC attachment.",
      );
    const next = this.network.resolvePortAttachment(this.id, attachment, false);
    if (this.dnsHostname) this.network.validatePortHostname(this.id, this.dnsHostname, next.vpcId, false);
    this.destroyBackend();
    this.network.forget(this.id);
    this.policyGeneration++;
    this.attachment = next;
    this.mode = "isolated";
    this.ready = false;
    this.notify();
  }

  /** Irreversible for this port's lifetime; there is deliberately no release method. */
  quarantine(reason = "Snapshot investigation"): void {
    if (this.disposed) throw new Error("This network port has been disposed.");
    if (this.#quarantined) return;
    this.#quarantined = true;
    this.quarantineReason = String(reason).slice(0, 160);
    this.mode = "isolated";
    this.policyGeneration++;
    this.destroyBackend();
    this.network.forget(this.id);
    this.endpoint?.setNetworkCarrier?.(false);
    this.notify();
  }

  setPolicy(policy: NetworkPolicy): void {
    this.requireMutableNetwork();
    const validated = validateNetworkPolicy(policy);
    this.policy = validated;
    this.policyGeneration++;
    this.destroyBackend();
    this.network.forget(this.id);
    this.ensureBackend();
    this.notify();
  }

  setCapture(enabled: boolean): void {
    this.capture.setEnabled(enabled);
    this.notify();
  }
  clearCapture(): void {
    this.capture.clear();
    this.notify();
  }
  exportPcap(): Uint8Array {
    return this.capture.exportPcap();
  }
  getFlowLog(limit = 100): FlowEvent[] {
    return this.flowLog
      .slice(-Math.max(1, Math.min(200, Math.floor(limit) || 100)))
      .map((event) => ({ ...event }));
  }
  clearDiagnostics(): void {
    this.flowLog.length = 0;
    this.lastDrop = null;
    for (const reason of Object.keys(this.dropReasons))
      delete this.dropReasons[reason];
    this.notify();
  }

  private record(
    frame: Uint8Array,
    packet: PacketInfo,
    direction: "ingress" | "egress",
    verdict: "allow" | "drop",
    reason: string,
  ): void {
    const atMs = Date.now();
    const event: FlowEvent = {
      atMs,
      direction,
      verdict,
      reason,
      protocol: packet.protocol,
      source: packet.source,
      destination: packet.destination,
      bytes: frame.byteLength,
      ...(packet.sourcePort === undefined
        ? {}
        : { sourcePort: packet.sourcePort }),
      ...(packet.destinationPort === undefined
        ? {}
        : { destinationPort: packet.destinationPort }),
    };
    if (this.flowLog.length >= 200) this.flowLog.shift();
    this.flowLog.push(event);
    this.capture.record(frame, atMs);
    if (verdict === "drop") {
      this.droppedPackets++;
      this.lastDrop = event;
      this.dropReasons[reason] = (this.dropReasons[reason] ?? 0) + 1;
    }
    this.scheduleNotify();
  }

  v86Options(): V86Options["net_device"] {
    // The NIC has no built-in backend. This port owns every external connection.
    return { type: "ne2k" };
  }

  guestSetupCommand(): string {
    return guestNetworkScript(this.ip, this.gateway);
  }

  /** Hold traffic until the assigned address is installed after boot/restore. */
  setReady(ready: boolean): void {
    if (this.disposed) throw new Error("This network port has been disposed.");
    if (ready && !this.endpoint)
      throw new Error("Attach a machine before enabling its network port.");
    if (ready === this.ready) return;
    this.ready = ready;
    this.policyGeneration++;
    if (!ready) {
      this.destroyBackend();
      this.network.forget(this.id);
    }
    this.endpoint?.setNetworkCarrier?.(this.isConnected());
    if (ready) this.ensureBackend();
    this.notify();
  }

  /** Call after emulator-ready and before emulator.run(). */
  attach(emulator: V86): void {
    const internals = emulator as unknown as {
      bus: { send(event: string, data: Uint8Array): void };
      network_adapter?: unknown;
    };
    if (internals.network_adapter)
      throw new Error(
        "Do not configure an uncontrolled v86 relay; the network port owns its backend.",
      );
    if (!internals.bus || typeof internals.bus.send !== "function")
      throw new Error("The emulator has no Ethernet bus.");
    this.factories ??= globalThis.TerrariumNetworkAdapters ?? null;
    if (!this.factories)
      throw new Error(
        "Run runtime preparation to expose the pinned network adapters.",
      );
    this.attachEndpoint({
      onNetworkFrame: (listener) => {
        emulator.add_listener("net0-send", listener);
        return () => emulator.remove_listener("net0-send", listener);
      },
      sendNetworkFrame: (frame) => internals.bus.send("net0-receive", frame),
    });
  }

  async attachEthernet(endpoint: EthernetEndpoint): Promise<void> {
    if (this.endpoint || this.pendingAttachment)
      throw new Error("A network attachment already exists.");
    if (this.disposed) throw new Error("This network port has been disposed.");
    const generation = ++this.generation;
    this.pendingAttachment = true;
    try {
      this.factories ??= await loadNetworkAdapters();
      if (generation !== this.generation || this.disposed)
        throw new DOMException("Network attachment cancelled.", "AbortError");
      this.attachEndpoint(endpoint);
    } finally {
      if (generation === this.generation || this.endpoint === endpoint)
        this.pendingAttachment = false;
    }
  }

  private attachEndpoint(endpoint: EthernetEndpoint): void {
    if (this.disposed) throw new Error("This network port has been disposed.");
    if (this.endpoint)
      throw new Error(
        "Detach the previous machine before attaching another one.",
      );
    this.endpoint = endpoint;
    this.ready = false;
    endpoint.setNetworkCarrier?.(false);
    const generation = ++this.generation;
    this.unsubscribeFrames = endpoint.onNetworkFrame((frame) => {
      if (this.endpoint !== endpoint || this.generation !== generation) return;
      this.txPackets++;
      const packet = inspectPacket(frame);
      let reason: string;
      if (this.#quarantined) reason = "drop:quarantined";
      else if (!this.ready) reason = "drop:readiness_hold";
      else if (this.mode === "isolated") reason = "drop:isolated";
      else if (packet.error) reason = `drop:${packet.error}`;
      else if (!policyAllows(this.policy, "egress", packet))
        reason = "drop:egress_policy";
      else reason = this.network.route(this, frame, packet);
      if (reason === "outside") {
        if (this.mode !== "world") reason = "drop:outside_disabled";
        else {
          try {
            this.ensureBackend();
            if (!this.adapter)
              throw new Error("The selected network backend is not ready.");
            this.adapter.vm_mac = frame.slice(6, 12);
            if (packet.protocol === "udp" && packet.destinationPort === 53) {
              const dnsReply = this.relayDns.reply(frame);
              if (dnsReply) {
                this.adapter.receive(dnsReply);
                reason = "local_dns";
              } else reason = "drop:dns_query_unsupported";
            } else {
              this.adapter.send(frame);
              reason = "outside_route";
            }
          } catch (error) {
            this.lastError =
              error instanceof Error
                ? error.message
                : "Network frame could not be handled.";
            reason = "drop:backend_error";
          }
        }
      }
      this.record(
        frame,
        packet,
        "egress",
        reason.startsWith("drop:") ? "drop" : "allow",
        reason.replace(/^drop:/, ""),
      );
    });
    this.lastError = null;
    this.notify();
  }

  setMode(mode: NetworkMode): void {
    if (this.disposed) throw new Error("This network port has been disposed.");
    if (!["isolated", "local", "world"].includes(mode))
      throw new Error("Unknown network mode.");
    if (this.#quarantined && mode !== "isolated") this.requireMutableNetwork();
    if (mode === this.mode) return;
    this.mode = mode;
    this.policyGeneration++;
    this.destroyBackend();
    this.network.forget(this.id);
    this.lastError = null;
    this.endpoint?.setNetworkCarrier?.(this.isConnected());
    this.ensureBackend();
    this.notify();
  }

  configureTransport(configuration: NetworkTransport): void {
    this.requireMutableNetwork();
    const next: NetworkTransport =
      configuration.kind === "web"
        ? { kind: "web" }
        : configuration.kind === "wisp"
          ? { kind: "wisp", relayUrl: validateRelayUrl(configuration.relayUrl) }
          : (() => {
              throw new Error("Unknown Internet transport.");
            })();
    this.destroyBackend();
    this.configuration = next;
    this.lastError = null;
    this.ensureBackend();
    this.notify();
  }

  getSnapshot = (): NetworkSnapshot => ({
    id: this.id,
    hostname: this.dnsHostname,
    dnsName: this.dnsHostname ? `${this.dnsHostname}.${VPC_DNS_SUFFIX}` : null,
    ip: this.ip,
    mode: this.mode,
    attached: !!this.endpoint,
    ready: this.ready,
    transport: this.configuration.kind,
    relayUrl:
      this.configuration.kind === "wisp" ? this.configuration.relayUrl : null,
    connectionState: this.connectionState,
    txPackets: this.txPackets,
    rxPackets: this.rxPackets,
    droppedPackets: this.droppedPackets,
    webRequests: this.webRequests,
    blockedRequests: this.blockedRequests,
    inflightRequests: this.activeFetches.size,
    lastError: this.lastError,
    vpcId: this.vpcId,
    subnetId: this.subnetId,
    vpcCidr: this.vpcCidr,
    subnetCidr: this.subnetCidr,
    gateway: this.gateway,
    quarantined: this.#quarantined,
    quarantineReason: this.quarantineReason,
    policy: structuredClone(this.policy),
    capture: this.capture.getSnapshot(),
    lastDrop: this.lastDrop ? { ...this.lastDrop } : null,
    dropReasons: { ...this.dropReasons },
  });

  subscribe(listener: (snapshot: NetworkSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  receivePeer(frame: Uint8Array, source: NetworkPort, routed: boolean): void {
    const sourceToken = source.deliveryToken();
    if (
      source.vpcId !== this.vpcId ||
      (!routed && source.subnetId !== this.subnetId)
    ) {
      this.record(
        frame,
        inspectPacket(frame),
        "ingress",
        "drop",
        "cross_vpc_or_subnet",
      );
      return;
    }
    this.receive(
      frame,
      routed ? "vpc_local_route" : "subnet_peer",
      () =>
        source.isConnected() &&
        source.deliveryToken() === sourceToken &&
        source.vpcId === this.vpcId,
    );
  }

  receiveGateway(frame: Uint8Array, reason = "gateway", stillValid?: () => boolean): void {
    this.receive(frame, reason, stillValid);
  }

  private receive(
    frame: Uint8Array,
    reason: string,
    sourceAllowed: () => boolean = () => true,
  ): void {
    const endpoint = this.endpoint;
    const generation = this.generation;
    const policyGeneration = this.policyGeneration;
    const packet = inspectPacket(frame);
    if (
      this.#quarantined ||
      !endpoint ||
      !this.ready ||
      this.mode === "isolated" ||
      packet.error ||
      !policyAllows(this.policy, "ingress", packet)
    ) {
      this.record(
        frame,
        packet,
        "ingress",
        "drop",
        this.#quarantined
          ? "quarantined"
          : !endpoint || !this.ready
            ? "readiness_hold"
            : this.mode === "isolated"
              ? "isolated"
              : (packet.error ?? "ingress_policy"),
      );
      return;
    }
    const copy = new Uint8Array(frame);
    queueMicrotask(() => {
      if (
        this.endpoint !== endpoint ||
        this.generation !== generation ||
        this.policyGeneration !== policyGeneration ||
        this.#quarantined ||
        !sourceAllowed() ||
        !this.ready ||
        this.mode === "isolated"
      )
        return;
      this.rxPackets++;
      endpoint.sendNetworkFrame(copy);
      this.record(copy, packet, "ingress", "allow", reason);
    });
  }

  detach(): void {
    this.ready = false;
    this.generation++;
    this.pendingAttachment = false;
    this.destroyBackend();
    this.endpoint?.setNetworkCarrier?.(false);
    this.unsubscribeFrames?.();
    this.unsubscribeFrames = null;
    this.endpoint = null;
    this.adapter = null;
    this.network.forget(this.id);
    // Old adapter closures stay guarded until that emulator is destroyed.
    this.notify();
  }

  dispose(): void {
    if (this.disposed) return;
    this.detach();
    this.disposed = true;
    this.listeners.clear();
    if (this.notifyTimer !== null) clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    this.network.remove(this.id);
  }

  private destroyBackend(): void {
    this.backendGeneration++;
    this.abortWeb();
    const adapter = this.adapter;
    this.adapter = null;
    this.connectionState = "off";
    if (!adapter) return;
    for (const connection of Object.values(adapter.tcp_conn ?? {})) {
      try {
        connection.close?.();
      } catch {
        /* A disconnect must finish even if a guest TCP stream is broken. */
      }
    }
    adapter.tcp_conn = {};
    try {
      adapter.destroy();
    } catch {
      /* Packet guards already prevent further delivery. */
    }
  }

  private ensureBackend(): void {
    const endpoint = this.endpoint;
    if (
      !endpoint ||
      !this.ready ||
      this.#quarantined ||
      this.mode !== "world" ||
      this.adapter ||
      !this.factories
    )
      return;
    const generation = this.generation;
    const backendGeneration = ++this.backendGeneration;
    const active = () =>
      this.endpoint === endpoint &&
      this.generation === generation &&
      this.backendGeneration === backendGeneration &&
      this.ready &&
      !this.#quarantined &&
      this.mode === "world";
    const bus = new AdapterBus();
    const options = {
      type: "ne2k" as const,
      router_ip: this.gateway,
      vm_ip: this.ip,
      dns_method: "static" as const,
    };
    try {
      const adapter =
        this.configuration.kind === "web"
          ? new this.factories.Fetch(bus, options)
          : new this.factories.Wisp(
              this.configuration.relayUrl.replace(/^wss:/, "wisps:"),
              bus,
              options,
            );
      this.adapter = adapter;
      adapter.receive = (frame) => {
        if (!active() || frame.byteLength > MAX_FRAME_BYTES) return;
        this.receive(frame, "outside_reply", active);
      };
      if (this.configuration.kind === "web") {
        adapter.fetch = (url, init) =>
          this.fetchWeb(url, init, endpoint, generation, backendGeneration);
        this.connectionState = "connected";
      } else {
        routeRelayHostnames(adapter, this.relayDns);
        this.connectionState = "connecting";
        const observe = () => {
          const socket = adapter.wispws;
          if (!socket) return;
          // Wisp v1 has no version exchange: the stream-zero CONTINUE frame
          // grants initial credit. A WebSocket opening alone is not readiness.
          socket.addEventListener("close", () => {
            if (active()) {
              this.connectionState = "connecting";
              this.notify();
            }
          });
          socket.addEventListener("error", () => {
            if (active()) {
              this.connectionState = "error";
              this.lastError = "The Wisp relay connection failed.";
              this.notify();
            }
          });
          const onMessage = socket.onmessage;
          socket.onmessage = (event) => {
            if (!active()) return;
            try {
              if (
                !(event.data instanceof ArrayBuffer) ||
                event.data.byteLength < 5 ||
                event.data.byteLength > 1024 * 1024
              )
                throw new Error("Invalid relay frame.");
              const frame = new Uint8Array(event.data);
              if (
                (frame[0] === 3 && frame.byteLength !== 9) ||
                (frame[0] === 4 && frame.byteLength !== 6) ||
                ![2, 3, 4, 5].includes(frame[0])
              )
                throw new Error("Invalid relay frame.");
              onMessage?.call(socket, event);
              if (
                frame[0] === 3 &&
                new DataView(event.data).getUint32(1, true) === 0 &&
                new DataView(event.data).getUint32(5, true) > 0
              ) {
                this.connectionState = "connected";
                this.lastError = null;
                this.notify();
              }
            } catch {
              this.lastError = "The relay sent an invalid Wisp frame.";
              this.connectionState = "error";
              socket.close(1002);
              this.notify();
            }
          };
        };
        // Upstream retries call this method dynamically. Guarding it also
        // cancels reconnect timers that were scheduled before a disconnect.
        const register = adapter.register_ws?.bind(adapter);
        if (!register)
          throw new Error("The pinned Wisp adapter has no lifecycle hook.");
        adapter.register_ws = (url) => {
          if (active()) {
            register(url);
            observe();
          }
        };
        observe();
      }
    } catch (error) {
      this.destroyBackend();
      this.connectionState = "error";
      this.lastError =
        error instanceof Error
          ? error.message
          : "Could not initialize the network transport.";
    }
  }

  private abortWeb(): void {
    for (const controller of this.activeFetches)
      controller.abort(new Error("The web connection was disabled."));
    this.activeFetches.clear();
  }

  private async fetchWeb(
    input: RequestInfo | URL,
    options: RequestInit | undefined,
    endpoint: EthernetEndpoint,
    generation: number,
    backendGeneration: number,
  ): Promise<Response> {
    const allowed = () =>
      this.ready &&
      !this.#quarantined &&
      this.mode === "world" &&
      this.endpoint === endpoint &&
      this.generation === generation &&
      this.backendGeneration === backendGeneration;
    if (!allowed()) {
      this.blockedRequests++;
      throw new Error("Web access is disabled for this machine.");
    }
    let url: URL;
    try {
      if (typeof Request !== "undefined" && input instanceof Request)
        throw new Error("Only explicit guest URLs are supported.");
      url = publicWebUrl(input as string | URL, this.origin);
      if (this.activeFetches.size >= MAX_WEB_REQUESTS)
        throw new Error("This machine has reached its six-request web limit.");
    } catch (error) {
      this.blockedRequests++;
      this.lastError =
        error instanceof Error ? error.message : "This request is not allowed.";
      this.scheduleNotify();
      throw error;
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("The web request timed out.")),
      30_000,
    );
    this.activeFetches.add(controller);
    this.webRequests++;
    this.scheduleNotify();
    const cleanup = () => {
      clearTimeout(timer);
      this.activeFetches.delete(controller);
      this.scheduleNotify();
    };
    try {
      const headers = new Headers(options?.headers);
      for (const header of [
        "cookie",
        "cookie2",
        "proxy-authorization",
        "referer",
      ])
        headers.delete(header);
      const response = await this.fetchImpl(url, {
        ...options,
        headers,
        signal: controller.signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
        mode: "cors",
      });
      if (!allowed() || controller.signal.aborted)
        throw new Error("Web access was disabled before the response arrived.");
      if (!response.body) {
        cleanup();
        return response;
      }
      const reader = response.body.getReader();
      let received = 0;
      const chunks: Uint8Array[] = [];
      const cancelReader = () => {
        void reader.cancel(controller.signal.reason).catch(() => undefined);
      };
      controller.signal.addEventListener("abort", cancelReader, { once: true });
      try {
        while (true) {
          if (!allowed() || controller.signal.aborted)
            throw new Error("Web access was disabled during the response.");
          const chunk = await reader.read();
          if (!allowed() || controller.signal.aborted)
            throw new Error("Web access was disabled during the response.");
          if (chunk.done) break;
          received += chunk.value.byteLength;
          if (received > MAX_WEB_RESPONSE_BYTES)
            throw new Error("The web response exceeded the 8 MiB limit.");
          chunks.push(chunk.value);
        }
      } catch (error) {
        controller.abort();
        await reader.cancel(error).catch(() => undefined);
        throw error;
      } finally {
        controller.signal.removeEventListener("abort", cancelReader);
        reader.releaseLock();
      }
      // The pinned upstream adapter does not catch errors from its detached
      // body-reader promise. Complete this bounded download first so aborts or
      // oversized bodies reject its fetch promise, before any HTTP success is
      // delivered to the guest. The web bridge intentionally does not stream.
      const body = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const tracked = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      Object.defineProperty(tracked, "url", { value: response.url });
      cleanup();
      return tracked;
    } catch (error) {
      cleanup();
      this.lastError =
        error instanceof Error ? error.message : "Web request failed.";
      this.scheduleNotify();
      throw error;
    }
  }

  private scheduleNotify(): void {
    if (this.disposed || this.notifyTimer !== null) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.notify();
    }, 100);
  }

  private notify(): void {
    if (this.notifyTimer !== null) clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        /* Observers cannot change network delivery. */
      }
    }
    this.network.notify();
  }
}
