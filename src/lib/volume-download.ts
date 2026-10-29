// SPDX-License-Identifier: Apache-2.0
import type { CloudControlPlane, CloudVolumeRecord } from "./cloud.ts";
import { MAX_BUFFERED_VOLUME_MIB } from "./volume-types.ts";
import { exportVolume } from "./volume-store.ts";
import { downloadFile } from "./snapshots.ts";
import { beginResourceMutation } from "./resource-events.ts";

interface DiskFileWriter { write(chunk: Uint8Array<ArrayBuffer>): Promise<void>; close(): Promise<void>; abort(reason?: unknown): Promise<void> }
interface DiskFileHandle { createWritable(): Promise<DiskFileWriter> }
type SavePicker = (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<DiskFileHandle>;
export function supportsStreamingDiskDownload(): boolean {
  return typeof (globalThis as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker === "function";
}

/** Only the selected host file is changed; a failed stream aborts its pending write. */
export async function downloadVolume(volume: CloudVolumeRecord, cloud: CloudControlPlane,
  options: { signal?: AbortSignal; onProgress?: (written: number, total: number) => void } = {}): Promise<void> {
  const filename = volume.name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 100) || "terrarium-data";
  const finish = beginResourceMutation("volume");
  try {
    if (volume.bytes <= MAX_BUFFERED_VOLUME_MIB * 1024 * 1024) {
      options.signal?.throwIfAborted();
      const data = await exportVolume(volume.id);
      options.signal?.throwIfAborted();
      downloadFile(`${filename}.img`, data.buffer);
      downloadFile(`${filename}.json`, JSON.stringify({ ...data.metadata, sha256: data.sha256 }, null, 2), "application/json");
      return;
    }
    const picker = (globalThis as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    if (!picker) throw new Error("Large disks require a browser with a streaming Save file picker. The disk was kept. The API also accepts a backpressured sink through cloud.volumes.exportTo().");
    // Call before any asynchronous operation so the user's click authorizes the picker.
    const handle = await picker.call(globalThis, { suggestedName: `${filename}.img`, types: [{ description: "Raw disk image", accept: { "application/octet-stream": [".img"] } }] });
    options.signal?.throwIfAborted();
    const writer = await handle.createWritable();
    let committed = false;
    try {
      const result = await cloud.volumes.exportTo(volume.id, writer, options);
      options.signal?.throwIfAborted();
      await writer.close(); committed = true;
      downloadFile(`${filename}.json`, JSON.stringify({ ...result.metadata, sha256: result.sha256, bytesWritten: result.bytesWritten }, null, 2), "application/json");
    } catch (error) {
      if (!committed) await writer.abort(error).catch(() => undefined);
      throw error;
    }
  } finally { finish(); }
}
