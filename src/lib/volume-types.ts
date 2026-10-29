// SPDX-License-Identifier: Apache-2.0

export const VOLUME_PAGE_BYTES = 64 * 1024;
export const MIN_VOLUME_MIB = 4;
// Logical capacity is independent of committed pages and the bounded LRU.
export const MAX_VOLUME_MIB = 8192;
export const VOLUME_CACHE_BYTES = 64 * 1024 * 1024;
export const VOLUME_TRANSFER_BYTES = 1024 * 1024;
export const VOLUME_WRITE_QUEUE_BYTES = 8 * 1024 * 1024;
// Compatibility API only; large disks must use a backpressured stream sink.
export const MAX_BUFFERED_VOLUME_MIB = 128;
export const DEFAULT_VOLUME_MIB = 16;

export interface VolumeMeta {
  id: string;
  name: string;
  bytes: number;
  kind: "volume" | "snapshot";
  filesystem: "ext2";
  createdAt: number;
  updatedAt: number;
  revision: number;
  /** Immutable snapshot digest; mutable images are hashed when exported. */
  sha256: string | null;
  sourceId?: string;
}

export interface VolumeAttachment {
  id: string;
  slot: 0 | 1;
  readOnly?: boolean;
}

export interface VolumeAttachmentState extends VolumeAttachment {
  name: string;
  bytes: number;
  kind: "volume" | "snapshot";
  readOnly: boolean;
  device: string;
  mountPath: string;
  status: "configured" | "opening" | "mounted" | "closed" | "error";
  pendingWrites: number;
  lastPersistedAt: number | null;
  error?: string;
}

export interface VolumeExport {
  metadata: VolumeMeta;
  buffer: ArrayBuffer;
  sha256: string;
}

export interface VolumeStreamResult {
  metadata: VolumeMeta;
  sha256: string;
  bytesWritten: number;
}

export interface VolumeStreamOptions {
  signal?: AbortSignal;
  /** 1..1MiB; the sink must finish each write before the next chunk is read. */
  chunkBytes?: number;
  onProgress?: (bytesWritten: number, totalBytes: number) => void;
}

export function validateVolumeId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(value))
    throw new Error("Invalid volume ID.");
  return value;
}

export function validateVolumeName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Give this volume a name.");
  const name = value.trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name))
    throw new Error("Volume names must contain 1–80 printable characters.");
  return name;
}

export function validateVolumeSize(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < MIN_VOLUME_MIB || Number(value) > MAX_VOLUME_MIB)
    throw new Error(`Choose a whole-number disk size from ${MIN_VOLUME_MIB} to ${MAX_VOLUME_MIB} MiB. Disk pages are committed on demand; browser storage quota still applies.`);
  return Number(value);
}

export function validateVolumeAttachments(value: unknown): VolumeAttachment[] {
  if (!Array.isArray(value) || value.length > 2)
    throw new Error("This runtime exposes two tested VirtIO block device slots.");
  const ids = new Set<string>();
  const slots = new Set<number>();
  const result = value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid volume attachment.");
    const id = validateVolumeId(entry.id);
    if (entry.slot !== 0 && entry.slot !== 1) throw new Error("Choose VirtIO disk slot 0 or 1.");
    if (entry.readOnly !== undefined && typeof entry.readOnly !== "boolean")
      throw new Error("Read-only attachment must be a boolean.");
    if (ids.has(id) || slots.has(entry.slot)) throw new Error("A disk or VirtIO slot is already attached.");
    ids.add(id); slots.add(entry.slot);
    return { id, slot: entry.slot as 0 | 1, readOnly: entry.readOnly === true };
  });
  return result.sort((a, b) => a.slot - b.slot);
}

export function isVolumeMeta(value: unknown): value is VolumeMeta {
  if (!value || typeof value !== "object") return false;
  const record = value as VolumeMeta;
  try {
    if (typeof record.bytes !== "number") return false;
    validateVolumeId(record.id);
    validateVolumeName(record.name);
    validateVolumeSize(record.bytes / 1024 / 1024);
    if (record.sourceId !== undefined) validateVolumeId(record.sourceId);
  } catch { return false; }
  return (record.kind === "volume" || record.kind === "snapshot") &&
    record.filesystem === "ext2" &&
    Number.isSafeInteger(record.createdAt) && record.createdAt > 0 &&
    Number.isSafeInteger(record.updatedAt) && record.updatedAt >= record.createdAt &&
    Number.isSafeInteger(record.revision) && record.revision >= 0 &&
    (record.sha256 === null || /^[a-f0-9]{64}$/.test(record.sha256)) &&
    (record.kind !== "snapshot" || typeof record.sha256 === "string");
}
