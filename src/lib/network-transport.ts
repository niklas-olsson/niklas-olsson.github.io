// SPDX-License-Identifier: Apache-2.0

import type { V86Options } from "v86";

export interface EthernetEndpoint {
  onNetworkFrame(listener: (frame: Uint8Array) => void): () => void;
  sendNetworkFrame(frame: Uint8Array): void;
  setNetworkCarrier?(enabled: boolean): void;
}

export type NetworkTransport =
  | { kind: "web" }
  | { kind: "wisp"; relayUrl: string };
export type ConnectionState = "off" | "connecting" | "connected" | "error";

interface TcpPacket {
  ipv4: { dest: Array<number | string>; [key: string]: unknown };
  [key: string]: unknown;
}

export interface NetworkAdapter {
  send(frame: Uint8Array): void;
  receive(frame: Uint8Array): void;
  fetch?: (
    input: RequestInfo | URL,
    options?: RequestInit,
  ) => Promise<Response>;
  destroy(): void;
  vm_mac: Uint8Array;
  tcp_conn: Record<string, { close?: () => void }>;
  wispws?: WebSocket | null;
  register_ws?: (url: string) => void;
  on_tcp_connection?: (connection: unknown, packet: TcpPacket) => boolean;
}

export class AdapterBus {
  // v86's TCP dispatcher sends through the opposite bus endpoint. The
  // standalone adapter owns both endpoints, so dispatch back to its listeners.
  readonly pair = this;
  private readonly listeners = new Map<
    string,
    Array<{ listener: (data: unknown) => void; context?: unknown }>
  >();

  register(
    event: string,
    listener: (data: unknown) => void,
    context?: unknown,
  ): void {
    const items = this.listeners.get(event) ?? [];
    items.push({ listener, context });
    this.listeners.set(event, items);
  }

  unregister(event: string, listener: (data: unknown) => void): void {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter(
        (entry) => entry.listener !== listener,
      ),
    );
  }

  send(event: string, data: unknown): void {
    for (const entry of this.listeners.get(event) ?? [])
      entry.listener.call(entry.context, data);
  }
}

export interface AdapterFactories {
  Fetch: new (
    bus: AdapterBus,
    options: V86Options["net_device"],
  ) => NetworkAdapter;
  Wisp: new (
    url: string,
    bus: AdapterBus,
    options: V86Options["net_device"],
  ) => NetworkAdapter;
}

declare global {
  var TerrariumNetworkAdapters: AdapterFactories | undefined;
}

let adapterPromise: Promise<AdapterFactories> | null = null;

export function loadNetworkAdapters(): Promise<AdapterFactories> {
  if (globalThis.TerrariumNetworkAdapters)
    return Promise.resolve(globalThis.TerrariumNetworkAdapters);
  if (adapterPromise) return adapterPromise;
  if (typeof document === "undefined")
    return Promise.reject(
      new Error(
        "Load the prepared v86 script before using network adapters outside a browser.",
      ),
    );
  adapterPromise = new Promise<AdapterFactories>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL(
      `${import.meta.env.BASE_URL}runtime/libv86.js`,
      document.baseURI,
    ).href;
    script.async = true;
    const timer = setTimeout(() => {
      script.remove();
      reject(new Error("The networking adapter library timed out."));
    }, 30_000);
    script.onload = () => {
      clearTimeout(timer);
      if (globalThis.TerrariumNetworkAdapters)
        resolve(globalThis.TerrariumNetworkAdapters);
      else
        reject(
          new Error(
            "The prepared emulator did not expose its networking adapters.",
          ),
        );
    };
    script.onerror = () => {
      clearTimeout(timer);
      script.remove();
      reject(new Error("Could not load the networking adapter library."));
    };
    document.head.appendChild(script);
  }).catch((error) => {
    adapterPromise = null;
    throw error;
  });
  return adapterPromise;
}

/** A relay is explicitly supplied by the visitor; there is no default server. */
export function validateRelayUrl(value: string): string {
  if (typeof value !== "string" || value.length > 2048 || !value.trim())
    throw new Error("Enter your secure Wisp relay URL.");
  let url: URL;
  try {
    url = new URL(value.trim().replace(/^wisps:/i, "wss:"));
  } catch {
    throw new Error("Enter an absolute wss:// URL for your Wisp relay.");
  }
  if (
    url.protocol !== "wss:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      "The relay must use wss://, with no embedded username, password, or fragment.",
    );
  }
  return url.href;
}

function checksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 2)
    sum += (bytes[offset] << 8) | (bytes[offset + 1] ?? 0);
  while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

/**
 * Wisp transports hostnames in CONNECT frames. Answer guest DNS locally with
 * synthetic addresses, then map those addresses back to the requested hostname
 * when opening a relay connection. DNS resolution is performed by that relay,
 * with no separate browser DoH request or hidden resolver.
 */
export class RelayDns {
  private readonly names = new Map<string, string>();
  private readonly addresses = new Map<string, string>();
  private nextAddress = 2;

  hostname(ip: string): string | undefined {
    return this.addresses.get(ip);
  }

  reply(frame: Uint8Array): Uint8Array | null {
    if (
      frame.length < 42 ||
      frame[12] !== 8 ||
      frame[13] !== 0 ||
      frame[23] !== 17
    )
      return null;
    const ipHeader = (frame[14] & 15) * 4;
    if (
      ipHeader < 20 ||
      frame.length < 14 + ipHeader + 20 ||
      (frame[20] & 0x3f) !== 0 ||
      frame[21] !== 0
    )
      return null;
    const udp = 14 + ipHeader;
    if (frame[udp + 2] !== 0 || frame[udp + 3] !== 53) return null;
    const dns = frame.subarray(udp + 8);
    if (
      dns.length < 17 ||
      (dns[2] & 0x80) !== 0 ||
      dns[4] !== 0 ||
      dns[5] !== 1
    )
      return null;
    let cursor = 12;
    const labels: string[] = [];
    while (cursor < dns.length && dns[cursor] !== 0) {
      const size = dns[cursor++];
      if (size > 63 || cursor + size >= dns.length) return null;
      const label = new TextDecoder().decode(
        dns.subarray(cursor, cursor + size),
      );
      if (!/^[A-Za-z0-9_-]+$/.test(label)) return null;
      labels.push(label);
      cursor += size;
    }
    if (cursor + 5 > dns.length) return null;
    cursor++;
    const type = (dns[cursor] << 8) | dns[cursor + 1];
    const queryClass = (dns[cursor + 2] << 8) | dns[cursor + 3];
    const endQuestion = cursor + 4;
    const hostname = labels.join(".").toLowerCase();
    if (!hostname || hostname.length > 253 || queryClass !== 1) return null;
    let ip = this.names.get(hostname);
    const answer = type === 1;
    if (answer && !ip) {
      if (this.names.size >= 256) return null;
      ip = `198.18.${Math.floor(this.nextAddress / 254)}.${(this.nextAddress % 254) + 1}`;
      this.nextAddress++;
      this.names.set(hostname, ip);
      this.addresses.set(ip, hostname);
    }
    const payload = new Uint8Array(endQuestion + (answer ? 16 : 0));
    payload.set(dns.subarray(0, endQuestion));
    payload.set([0x81, 0x80], 2);
    payload.set([0, 1, 0, answer ? 1 : 0, 0, 0, 0, 0], 4);
    if (answer)
      payload.set(
        [
          0xc0,
          0x0c,
          0,
          1,
          0,
          1,
          0,
          0,
          0,
          60,
          0,
          4,
          ...ip!.split(".").map(Number),
        ],
        endQuestion,
      );
    const packet = new Uint8Array(14 + 20 + 8 + payload.length);
    packet.set(frame.subarray(6, 12), 0);
    packet.set(frame.subarray(0, 6), 6);
    packet.set([8, 0], 12);
    const view = new DataView(packet.buffer);
    packet[14] = 0x45;
    view.setUint16(16, 20 + 8 + payload.length);
    packet[22] = 64;
    packet[23] = 17;
    packet.set(frame.subarray(30, 34), 26);
    packet.set(frame.subarray(26, 30), 30);
    view.setUint16(24, checksum(packet.subarray(14, 34)));
    view.setUint16(34, 53);
    view.setUint16(36, (frame[udp] << 8) | frame[udp + 1]);
    view.setUint16(38, 8 + payload.length);
    // UDP checksum zero is valid for IPv4. Nothing leaves the selected relay.
    packet.set(payload, 42);
    return packet;
  }
}

export function routeRelayHostnames(
  adapter: NetworkAdapter,
  dns: RelayDns,
): void {
  const original = adapter.on_tcp_connection?.bind(adapter);
  if (!original)
    throw new Error("The pinned Wisp adapter has no TCP connection hook.");
  adapter.on_tcp_connection = (connection, packet) => {
    const hostname = dns.hostname(packet.ipv4.dest.join("."));
    const mapped = hostname
      ? { ...packet, ipv4: { ...packet.ipv4, dest: [hostname] } }
      : packet;
    return original(connection, mapped);
  };
}
