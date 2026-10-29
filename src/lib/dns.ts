// SPDX-License-Identifier: Apache-2.0
import { internetChecksum } from "./network-policy.ts";

export const VPC_DNS_SUFFIX = "terrarium.internal";
const MAX_DNS_QUERY_BYTES = 1232;

export function validateDnsHostname(value: string): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(value))
    throw new Error("A machine DNS name must use 1–32 lowercase letters, digits, or internal hyphens.");
  return value;
}

/** Short names and our complete private zone are authoritative, including misses. */
export function localDnsLabel(name: string): { internal: boolean; label: string | null } {
  const normalized = name.toLowerCase().replace(/\.$/, "");
  const internal = !normalized.includes(".") || normalized === VPC_DNS_SUFFIX || normalized.endsWith(`.${VPC_DNS_SUFFIX}`);
  if (!internal) return { internal: false, label: null };
  const label = normalized.endsWith(`.${VPC_DNS_SUFFIX}`) ? normalized.slice(0, -(VPC_DNS_SUFFIX.length + 1)) : normalized;
  try { return { internal: true, label: validateDnsHostname(label) }; }
  catch { return { internal: true, label: null }; }
}

export interface DnsQuery {
  readonly name: string;
  readonly type: number;
  readonly frame: Uint8Array;
  readonly question: Uint8Array;
  readonly transactionId: number;
  readonly recursive: boolean;
  readonly sourcePort: number;
}

/** Bounded, single-question DNS over IPv4 UDP. Compressed query names are rejected. */
export function parseDnsQuery(frame: Uint8Array): DnsQuery | null {
  if (frame.length < 54 || frame[12] !== 8 || frame[13] !== 0 || (frame[14] >>> 4) !== 4 || frame[23] !== 17) return null;
  const ipHeaderBytes = (frame[14] & 15) * 4;
  const ipBytes = (frame[16] << 8) | frame[17];
  if (ipHeaderBytes < 20 || ipBytes < ipHeaderBytes + 20 || frame.length < 14 + ipBytes || (frame[20] & 0x3f) !== 0 || frame[21] !== 0 || internetChecksum(frame.subarray(14, 14 + ipHeaderBytes)) !== 0) return null;
  const udp = 14 + ipHeaderBytes;
  const udpBytes = (frame[udp + 4] << 8) | frame[udp + 5];
  if (frame[udp + 2] !== 0 || frame[udp + 3] !== 53 || udpBytes < 20 || udpBytes !== ipBytes - ipHeaderBytes || udpBytes - 8 > MAX_DNS_QUERY_BYTES) return null;
  if (frame[udp + 6] !== 0 || frame[udp + 7] !== 0) {
    const checksumData = new Uint8Array(12 + udpBytes);
    checksumData.set(frame.subarray(26, 34)); checksumData[9] = 17;
    new DataView(checksumData.buffer).setUint16(10, udpBytes);
    checksumData.set(frame.subarray(udp, udp + udpBytes), 12);
    if (internetChecksum(checksumData) !== 0) return null;
  }
  const dns = frame.subarray(udp + 8, udp + udpBytes);
  if ((dns[2] & 0xfa) !== 0 || dns[4] !== 0 || dns[5] !== 1 || dns[6] !== 0 || dns[7] !== 0 || dns[8] !== 0 || dns[9] !== 0 || dns[10] !== 0 || dns[11] > 1) return null;
  let cursor = 12;
  const labels: string[] = [];
  while (cursor < dns.length && dns[cursor] !== 0) {
    const size = dns[cursor++];
    if (size > 63 || cursor + size >= dns.length) return null;
    let label = "";
    for (const byte of dns.subarray(cursor, cursor + size)) {
      if (!((byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || byte === 45 || byte === 95)) return null;
      label += String.fromCharCode(byte);
    }
    labels.push(label); cursor += size;
  }
  if (cursor + 5 > dns.length) return null;
  const endName = cursor++;
  if (endName - 12 > 253 || !labels.length) return null;
  const type = (dns[cursor] << 8) | dns[cursor + 1];
  const queryClass = (dns[cursor + 2] << 8) | dns[cursor + 3];
  if (queryClass !== 1) return null;
  return {
    name: labels.join(".").toLowerCase(), type, frame,
    question: dns.slice(12, cursor + 4),
    transactionId: (dns[0] << 8) | dns[1],
    recursive: (dns[2] & 1) !== 0,
    sourcePort: (frame[udp] << 8) | frame[udp + 1],
  };
}

/** Actual configured IPv4 address, or NXDOMAIN. Existing names have no IPv6 answer. */
export function dnsReply(query: DnsQuery, address: string | null, gatewayMac: Uint8Array): Uint8Array {
  const answer = address !== null && query.type === 1;
  const payload = new Uint8Array(12 + query.question.length + (answer ? 16 : 0));
  const dnsView = new DataView(payload.buffer);
  dnsView.setUint16(0, query.transactionId);
  // Authoritative and nonrecursive. Reflect RD; this service does not recurse.
  dnsView.setUint16(2, 0x8400 | (query.recursive ? 0x100 : 0) | (address === null ? 3 : 0));
  dnsView.setUint16(4, 1); dnsView.setUint16(6, answer ? 1 : 0);
  payload.set(query.question, 12);
  if (answer) {
    // TTL zero prevents a configuration change from advertising a stale address.
    payload.set([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, ...address.split(".").map(Number)], 12 + query.question.length);
  }
  const packet = new Uint8Array(14 + 20 + 8 + payload.length);
  packet.set(query.frame.subarray(6, 12)); packet.set(gatewayMac, 6); packet.set([8, 0], 12);
  const view = new DataView(packet.buffer);
  packet[14] = 0x45; view.setUint16(16, 20 + 8 + payload.length); packet[22] = 64; packet[23] = 17;
  packet.set(query.frame.subarray(30, 34), 26); packet.set(query.frame.subarray(26, 30), 30);
  view.setUint16(24, internetChecksum(packet.subarray(14, 34)));
  view.setUint16(34, 53); view.setUint16(36, query.sourcePort); view.setUint16(38, 8 + payload.length);
  // A zero UDP checksum is valid for IPv4; IP integrity is always checked above.
  packet.set(payload, 42);
  return packet;
}
