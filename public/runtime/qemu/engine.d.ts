import type { QemuMonitorResourceObservation } from "./monitor.js";
export interface QemuEngine {
  input(text: string, port?: number): void;
  carrier(enabled: boolean): void;
  network(frame: Uint8Array): void;
  pause(): Promise<void>;
  resume(): Promise<void>;
  flushDisks(): Promise<void>;
  inspectRegisters(): Promise<string>;
  inspectResources(): Promise<QemuMonitorResourceObservation>;
  saveCheckpoint(): Promise<ArrayBuffer>;
  restoreCheckpoint(): Promise<void>;
  destroy(): Promise<void>;
}
export function startQemu(message: Record<string, unknown>, platform: {
  emit(message: Record<string, unknown>, transfer?: ArrayBuffer[]): void;
  loadModule(bytes: ArrayBuffer): Promise<{
    factory(options: Record<string, unknown>): Promise<unknown>;
    url: string;
    dispose?(): void;
  }>;
  pthreadUrl: string | URL;
}): Promise<QemuEngine>;
