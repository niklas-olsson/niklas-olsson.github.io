import type { QemuRuntimeBundle } from "./catalog.js";
import type { QemuMonitorResourceObservation } from "./monitor.js";

export interface QemuWorkerEngine {
  input(text: string, port?: number): void;
  carrier(enabled: boolean): void;
  network(frame: Uint8Array): void;
  pause(): Promise<void>;
  resume(): Promise<void>;
  flushDisks(): Promise<void>;
  saveCheckpoint(): Promise<ArrayBuffer>;
  inspectRegisters(): Promise<string>;
  inspectResources(): Promise<QemuMonitorResourceObservation>;
  restoreCheckpoint(): Promise<void>;
  destroy(): Promise<void>;
}
export interface QemuDispatcherOptions {
  emit(message: Record<string, unknown>, transfer?: Transferable[]): void;
  close(): void;
  isIsolated(): boolean;
  loadBundle(bundle: QemuRuntimeBundle): Promise<{ manifest: unknown; pthreadUrl: string | URL }>;
  loadModule(bytes: ArrayBuffer): Promise<{ factory: unknown; url: string; dispose?: () => void }>;
  start?: (message: Record<string, unknown>, options: {
    emit: QemuDispatcherOptions["emit"];
    loadModule: QemuDispatcherOptions["loadModule"];
    pthreadUrl: string | URL;
  }) => Promise<QemuWorkerEngine>;
}
export function createQemuDispatcher(options: QemuDispatcherOptions): (data: unknown) => Promise<void>;
