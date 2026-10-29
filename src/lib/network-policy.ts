// SPDX-License-Identifier: Apache-2.0
import { containsIp, parseCidr } from "./vpc-config.ts";

export type PacketProtocol =
  | "arp"
  | "tcp"
  | "udp"
  | "icmp"
  | "ipv4"
  | "ipv6"
  | "other";
export interface PacketInfo {
  protocol: PacketProtocol;
  source: string;
  destination: string;
  sourcePort?: number;
  destinationPort?: number;
  etherType: number;
  fragmented: boolean;
  ipHeaderBytes: number;
  error?: string;
}
export interface PacketRule {
  protocol: "any" | "tcp" | "udp" | "icmp";
  cidr: string;
  port?: number;
}
/** Stateless allowlists. Return traffic needs a matching reverse-direction rule. */
export interface NetworkPolicy {
  ingress: PacketRule[];
  egress: PacketRule[];
}
export const ALLOW_ALL_POLICY: NetworkPolicy = {
  ingress: [{ protocol: "any", cidr: "0.0.0.0/0" }],
  egress: [{ protocol: "any", cidr: "0.0.0.0/0" }],
};
export const DENY_ALL_POLICY: NetworkPolicy = { ingress: [], egress: [] };

export function ipAt(frame: Uint8Array, offset: number): string {
  return Array.from(frame.subarray(offset, offset + 4)).join(".");
}
export function macAt(frame: Uint8Array, offset: number): string {
  return Array.from(frame.subarray(offset, offset + 6), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join(":");
}
export function internetChecksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < bytes.length; index += 2)
    sum += (bytes[index] << 8) | (bytes[index + 1] ?? 0);
  while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

export function inspectPacket(frame: Uint8Array): PacketInfo {
  const info: PacketInfo = {
    protocol: "other",
    source: "",
    destination: "",
    etherType: 0,
    fragmented: false,
    ipHeaderBytes: 0,
  };
  if (
    !(frame instanceof Uint8Array) ||
    frame.length < 14 ||
    frame.length > 65536
  )
    return { ...info, error: "malformed_frame" };
  info.etherType = (frame[12] << 8) | frame[13];
  info.source = macAt(frame, 6);
  info.destination = macAt(frame, 0);
  if (info.etherType === 0x0806) {
    info.protocol = "arp";
    if (
      frame.length < 42 ||
      frame[14] !== 0 ||
      frame[15] !== 1 ||
      frame[16] !== 8 ||
      frame[17] !== 0 ||
      frame[18] !== 6 ||
      frame[19] !== 4 ||
      frame[20] !== 0 ||
      ![1, 2].includes(frame[21])
    )
      return { ...info, error: "malformed_arp" };
    info.source = ipAt(frame, 28);
    info.destination = ipAt(frame, 38);
    if (macAt(frame, 6) !== macAt(frame, 22)) info.error = "arp_mac_mismatch";
    return info;
  }
  if (info.etherType === 0x86dd)
    return { ...info, protocol: "ipv6", error: "ipv6_not_routed" };
  if (info.etherType !== 0x0800)
    return { ...info, error: "unsupported_ethertype" };
  info.protocol = "ipv4";
  info.ipHeaderBytes = (frame[14] & 15) * 4;
  const total = (frame[16] << 8) | frame[17];
  if (
    frame.length < 34 ||
    frame[14] >>> 4 !== 4 ||
    info.ipHeaderBytes < 20 ||
    total < info.ipHeaderBytes ||
    frame.length < 14 + total ||
    internetChecksum(frame.subarray(14, 14 + info.ipHeaderBytes)) !== 0
  )
    return { ...info, error: "malformed_ipv4" };
  info.source = ipAt(frame, 26);
  info.destination = ipAt(frame, 30);
  info.fragmented = (frame[20] & 0x3f) !== 0 || frame[21] !== 0;
  if (info.fragmented) return { ...info, error: "ipv4_fragment_not_routed" };
  info.protocol =
    frame[23] === 6
      ? "tcp"
      : frame[23] === 17
        ? "udp"
        : frame[23] === 1
          ? "icmp"
          : "ipv4";
  const transport = 14 + info.ipHeaderBytes;
  if (info.protocol === "tcp" || info.protocol === "udp") {
    if (total - info.ipHeaderBytes < (info.protocol === "tcp" ? 20 : 8))
      return { ...info, error: "malformed_transport" };
    info.sourcePort = (frame[transport] << 8) | frame[transport + 1];
    info.destinationPort = (frame[transport + 2] << 8) | frame[transport + 3];
  }
  return info;
}

export function validateNetworkPolicy(input: NetworkPolicy): NetworkPolicy {
  if (!input || typeof input !== "object")
    throw new Error("A packet policy is required.");
  const validate = (rules: PacketRule[]): PacketRule[] => {
    if (!Array.isArray(rules) || rules.length > 16)
      throw new Error("Use at most 16 allow rules per direction.");
    return rules.map((rule) => {
      if (!rule || !["any", "tcp", "udp", "icmp"].includes(rule.protocol))
        throw new Error("Choose any, TCP, UDP, or ICMP for each rule.");
      const cidr = parseCidr(rule.cidr).cidr;
      if (
        rule.port !== undefined &&
        (!Number.isInteger(rule.port) ||
          rule.port < 1 ||
          rule.port > 65535 ||
          !["tcp", "udp"].includes(rule.protocol))
      )
        throw new Error(
          "A destination port from 1–65535 is valid only for TCP or UDP rules.",
        );
      return {
        protocol: rule.protocol,
        cidr,
        ...(rule.port === undefined ? {} : { port: rule.port }),
      };
    });
  };
  return { ingress: validate(input.ingress), egress: validate(input.egress) };
}

export function policyAllows(
  policy: NetworkPolicy,
  direction: "ingress" | "egress",
  packet: PacketInfo,
): boolean {
  // Neighbor discovery is validated and subnet-confined separately.
  if (packet.protocol === "arp") return true;
  if (packet.error) return false;
  const peer = direction === "ingress" ? packet.source : packet.destination;
  return policy[direction].some(
    (rule) =>
      (rule.protocol === "any" || rule.protocol === packet.protocol) &&
      containsIp(rule.cidr, peer) &&
      (rule.port === undefined || rule.port === packet.destinationPort),
  );
}
