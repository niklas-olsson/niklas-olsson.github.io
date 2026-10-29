export interface MonitorDeviceOperations {
  open(stream: { seekable?: boolean }): void;
  close(): void;
  read(stream: unknown, buffer: Uint8Array, offset: number, length: number): number;
  write(stream: unknown, buffer: Uint8Array, offset: number, length: number): number;
  poll(): number;
  llseek(): never;
}
export interface MonitorFileSystem {
  ErrnoError: new (errno: number) => Error;
  makedev(major: number, minor: number): number;
  registerDevice(device: number, operations: MonitorDeviceOperations): void;
  mkdirTree(path: string): void;
  mkdev(path: string, mode: number, device: number): void;
}
export interface QemuTranslationStats {
  readonly generatedCodeUsedBytes: number;
  readonly generatedCodeCapacityBytes: number;
  readonly translationBlockCount: number;
  readonly translationBlockFlushCount: number;
  readonly translationBlockInvalidateCount: number;
}
export interface QemuMonitorResourceObservation {
  readonly translationStats: QemuTranslationStats;
  /** Bounded decoded HMP body after its readline cursor operations are rendered. */
  readonly monitorText: string;
}
export function parseQemuTranslationStats(text: string): QemuTranslationStats;
export interface PipeMonitor {
  install(filesystem: MonitorFileSystem): void;
  /** Fixed private HMP commands for lifecycle, checkpoints and paused observations. */
  execute(command: string, args?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}
export function createPipeMonitor(options: {
  onError: (error: Error) => void;
  readyTimeoutMs?: number;
  commandTimeoutMs?: number;
}): PipeMonitor;
