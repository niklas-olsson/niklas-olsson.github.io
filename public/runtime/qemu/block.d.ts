export interface DiskDefinition {
  slot: 0 | 1;
  bytes: number;
  readOnly: boolean;
  transport: "paged-v1";
  mailbox: SharedArrayBuffer;
}
export interface DiskNode {
  usedBytes: number;
  contents: Uint8Array;
  node_ops: { setattr(node: DiskNode, attributes: { size?: number }): void };
  stream_ops: {
    read(stream: unknown, buffer: Uint8Array | Int8Array, offset: number, length: number, position: number): number;
    write(stream: unknown, buffer: Uint8Array | Int8Array, offset: number, length: number, position: number): number;
    allocate(stream: unknown, offset: number, length: number): void;
    mmap(): never;
    msync(): never;
  };
  mount: { type: { syncfs?(mount: unknown, populate: boolean, done: (error: unknown) => void): void } };
}
export interface DiskRequest {
  type: "disk-request";
  operation: "read" | "write" | "flush";
  slot: 0 | 1;
  sequence: number;
  offset: number;
  length: number;
}
export function installPersistentDisks(filesystem: {
  ErrnoError: new (errno: number) => Error;
  mkdirTree(path: string): void;
  writeFile(path: string, bytes: Uint8Array): void;
  lookupPath(path: string): { node: DiskNode };
}, definitions: DiskDefinition[], emit: (request: DiskRequest) => void, onError: (error: Error) => void): {
  flush(): void;
  close(): void;
};
export function installEvidenceDisk(filesystem: {
  ErrnoError: new (errno: number) => Error;
  mkdirTree(path: string): void;
  writeFile(path: string, bytes: Uint8Array, options?: { canOwn?: boolean }): void;
  lookupPath(path: string): { node: DiskNode };
}, image: ArrayBuffer): void;
