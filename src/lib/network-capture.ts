// SPDX-License-Identifier: Apache-2.0
import type { PacketInfo } from "./network-policy.ts";

export interface FlowEvent {
  atMs: number;
  direction: "ingress" | "egress";
  verdict: "allow" | "drop";
  reason: string;
  protocol: PacketInfo["protocol"];
  source: string;
  destination: string;
  sourcePort?: number;
  destinationPort?: number;
  bytes: number;
}
export interface CaptureSnapshot {
  enabled: boolean;
  packets: number;
  bytes: number;
  evicted: number;
  snapLength: number;
}
const SNAP_LENGTH = 2048;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const MAX_CAPTURE_PACKETS = 2048;

export class PacketCapture {
  private enabled = false;
  private records: {
    atMs: number;
    originalLength: number;
    bytes: Uint8Array;
  }[] = [];
  private byteCount = 0;
  private evicted = 0;
  setEnabled(enabled: boolean): void {
    this.enabled = !!enabled;
  }
  getSnapshot(): CaptureSnapshot {
    return {
      enabled: this.enabled,
      packets: this.records.length,
      bytes: this.byteCount,
      evicted: this.evicted,
      snapLength: SNAP_LENGTH,
    };
  }
  clear(): void {
    this.records = [];
    this.byteCount = 0;
    this.evicted = 0;
  }
  record(frame: Uint8Array, atMs: number): void {
    if (!this.enabled || !(frame instanceof Uint8Array)) return;
    const bytes = frame.slice(0, SNAP_LENGTH);
    while (
      this.records.length &&
      (this.records.length >= MAX_CAPTURE_PACKETS ||
        this.byteCount + bytes.length > MAX_CAPTURE_BYTES)
    ) {
      this.byteCount -= this.records.shift()!.bytes.length;
      this.evicted++;
    }
    this.records.push({ atMs, originalLength: frame.length, bytes });
    this.byteCount += bytes.length;
  }
  exportPcap(): Uint8Array {
    const output = new Uint8Array(
      24 + this.records.length * 16 + this.byteCount,
    );
    const view = new DataView(output.buffer);
    view.setUint32(0, 0xa1b2c3d4, true);
    view.setUint16(4, 2, true);
    view.setUint16(6, 4, true);
    view.setUint32(16, SNAP_LENGTH, true);
    view.setUint32(20, 1, true);
    let offset = 24;
    for (const record of this.records) {
      view.setUint32(offset, Math.floor(record.atMs / 1000), true);
      view.setUint32(offset + 4, Math.floor(record.atMs % 1000) * 1000, true);
      view.setUint32(offset + 8, record.bytes.length, true);
      view.setUint32(offset + 12, record.originalLength, true);
      output.set(record.bytes, offset + 16);
      offset += 16 + record.bytes.length;
    }
    return output;
  }
}
