import type { MonitorFileSystem } from "./monitor.js";
export function createSerialPipes(options: { onOutput(port: number, data: string): void }): {
  install(filesystem: MonitorFileSystem): void;
  input(port: number, text: string): void;
  clear(): void;
  close(): void;
};
